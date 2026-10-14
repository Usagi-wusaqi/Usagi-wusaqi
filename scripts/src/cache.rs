//! 缓存读写、序列化、汇总与清理

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Write;

use serde::{Deserialize, Serialize};
use serde_json::ser::{Formatter, Serializer};

use crate::config::App;
use crate::util::{
    parse_iso_timestamp, print_color, read_text_normalized, Log, GREEN, NC, RED, YELLOW,
};

/// 单个 commit 的缓存条目（字段顺序固定，用于逐字节对齐原输出）
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct CacheEntry {
    pub timestamp: String,
    pub index: i64,
    pub additions: i64,
    pub deletions: i64,
    pub images: i64,
    pub url: String,
}

#[derive(Serialize)]
pub struct CacheMetadata {
    pub total_commits: i64,
    pub total_additions: i64,
    pub total_deletions: i64,
    pub total_images: i64,
    pub latest_commit_timestamp: String,
}

pub type CacheData = BTreeMap<String, Vec<CacheEntry>>;

/// 当前数据源（git log 或 API）里的 commit，用于过期缓存比对
#[derive(Clone)]
pub struct CurrentCommit {
    pub sha: String,
    pub date: String,
}

#[derive(Default, Clone)]
pub struct Stats {
    pub total_commits: i64,
    pub total_additions: i64,
    pub total_deletions: i64,
    pub total_images: i64,
    pub latest_commit_timestamp: String,
}

// ============================================================================
// JSON 序列化（对齐 Python json.dumps 的 ", " / ": " 分隔符）
// ============================================================================

struct PyFormatter;

impl Formatter for PyFormatter {
    fn begin_array_value<W>(&mut self, writer: &mut W, first: bool) -> std::io::Result<()>
    where
        W: ?Sized + Write,
    {
        if first {
            Ok(())
        } else {
            writer.write_all(b", ")
        }
    }

    fn begin_object_key<W>(&mut self, writer: &mut W, first: bool) -> std::io::Result<()>
    where
        W: ?Sized + Write,
    {
        if first {
            Ok(())
        } else {
            writer.write_all(b", ")
        }
    }

    fn begin_object_value<W>(&mut self, writer: &mut W) -> std::io::Result<()>
    where
        W: ?Sized + Write,
    {
        writer.write_all(b": ")
    }
}

pub fn to_py_json<T: Serialize>(value: &T) -> String {
    let mut buf = Vec::new();
    {
        let mut serializer = Serializer::with_formatter(&mut buf, PyFormatter);
        value.serialize(&mut serializer).expect("JSON 序列化失败");
    }
    String::from_utf8(buf).expect("JSON 输出不是合法 UTF-8")
}

/// 序列化为与原脚本逐字节一致的紧凑 JSON（metadata 与 data 各占一行，每条 commit 一行）
pub fn serialize_cache(metadata: &CacheMetadata, data: &CacheData) -> String {
    let mut lines: Vec<String> = vec!["{".to_string()];
    lines.push(format!("  \"_metadata\": {},", to_py_json(metadata)));

    for (repo_index, (repo_name, commits)) in data.iter().enumerate() {
        if repo_index == 0 {
            lines.push(format!("  \"data\": {{\"{repo_name}\": ["));
        } else {
            lines.push(format!("    ,\"{repo_name}\": ["));
        }

        for (commit_index, commit) in commits.iter().enumerate() {
            let prefix = if commit_index == 0 { "" } else { "," };
            lines.push(format!("      {prefix}{}", to_py_json(commit)));
        }
        lines.push("    ]".to_string());
    }

    if data.is_empty() {
        lines.push("  \"data\": {}".to_string());
    } else {
        lines.push("  }".to_string());
    }
    lines.push("}".to_string());

    let mut out = lines.join("\n");
    out.push('\n');
    out
}

// ============================================================================
// 排序 / 统计 / 标准化
// ============================================================================

pub fn sort_and_reindex_commits(cache_data: CacheData) -> CacheData {
    let mut sorted_cache = CacheData::new();

    for (repo_name, commits) in cache_data {
        let mut commits = commits;
        commits.sort_by_key(|entry| parse_iso_timestamp(&entry.timestamp));
        for (idx, entry) in commits.iter_mut().enumerate() {
            entry.index = idx as i64 + 1;
        }
        sorted_cache.insert(repo_name, commits);
    }

    sorted_cache
}

pub fn calculate_cache_statistics(cache_data: &CacheData) -> (i64, i64, i64, i64) {
    let mut total_commits = 0;
    let mut total_additions = 0;
    let mut total_deletions = 0;
    let mut total_images = 0;

    for commits in cache_data.values() {
        total_commits += commits.len() as i64;
        for entry in commits {
            total_additions += entry.additions;
            total_deletions += entry.deletions;
            total_images += entry.images;
        }
    }

    (
        total_commits,
        total_additions,
        total_deletions,
        total_images,
    )
}

/// 按 commit URL 去重（字段顺序已由结构体固定）
pub fn normalize_cache_data(cache_data: CacheData, log: &mut Log) -> CacheData {
    let mut normalized = CacheData::new();

    for (repo_name, items) in cache_data {
        let mut seen_urls: HashSet<String> = HashSet::new();
        let mut normalized_items: Vec<CacheEntry> = Vec::new();
        let mut duplicate_count = 0;

        for item in items {
            if !item.url.is_empty() {
                if seen_urls.contains(&item.url) {
                    duplicate_count += 1;
                    continue;
                }
                seen_urls.insert(item.url.clone());
            }
            normalized_items.push(item);
        }

        if duplicate_count > 0 {
            log.color(
                &format!("    🧹 已按 commit URL 去重缓存: 删除 {duplicate_count} 条重复数据"),
                YELLOW,
            );
        }

        normalized.insert(repo_name, normalized_items);
    }

    normalized
}

// ============================================================================
// 读写
// ============================================================================

pub fn load_cache(app: &App, repo_name: &str, log: &mut Log) -> CacheData {
    let _ = fs::create_dir_all(&app.cache_dir);
    let cache_file = app.cache_file(repo_name);

    if !cache_file.exists() {
        log.color(
            &format!("⚠️  加载缓存失败: {} 不存在", cache_file.display()),
            YELLOW,
        );
        return CacheData::new();
    }

    let content = match read_text_normalized(&cache_file) {
        Ok(content) => content,
        Err(err) => {
            log.color(&format!("⚠️  加载缓存失败: {err}"), YELLOW);
            return CacheData::new();
        }
    };

    let value: serde_json::Value = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(err) => {
            log.color(&format!("⚠️  加载缓存失败: {err}"), YELLOW);
            return CacheData::new();
        }
    };

    log.color(&format!("💾 已加载缓存: {}", cache_file.display()), GREEN);
    let total_commits = value
        .get("_metadata")
        .and_then(|meta| meta.get("total_commits"))
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    log.color(&format!("   缓存包含 {total_commits} 个commits"), NC);

    let Some(data_object) = value.get("data").and_then(serde_json::Value::as_object) else {
        return CacheData::new();
    };

    let mut cache_data = CacheData::new();
    for (repo, items) in data_object {
        let mut entries = Vec::new();
        if let Some(array) = items.as_array() {
            for item in array {
                if let Ok(entry) = serde_json::from_value::<CacheEntry>(item.clone()) {
                    entries.push(entry);
                }
            }
        }
        cache_data.insert(repo.clone(), entries);
    }

    normalize_cache_data(cache_data, log)
}

pub fn save_cache(app: &App, repo_name: &str, cache_data: &mut CacheData, log: &mut Log) -> bool {
    let _ = fs::create_dir_all(&app.cache_dir);
    let cache_file = app.cache_file(repo_name);

    let sorted_cache_data = sort_and_reindex_commits(cache_data.clone());
    let (total_commits, total_additions, total_deletions, total_images) =
        calculate_cache_statistics(&sorted_cache_data);

    let mut latest_key = i64::MIN;
    let mut latest_timestamp = String::new();
    for commits in sorted_cache_data.values() {
        for commit in commits {
            let key = parse_iso_timestamp(&commit.timestamp);
            if key > latest_key {
                latest_key = key;
                latest_timestamp = commit.timestamp.clone();
            }
        }
    }

    let metadata = CacheMetadata {
        total_commits,
        total_additions,
        total_deletions,
        total_images,
        latest_commit_timestamp: latest_timestamp,
    };

    let serialized = serialize_cache(&metadata, &sorted_cache_data);
    let old_content = read_text_normalized(&cache_file).unwrap_or_default();

    if old_content == serialized {
        log.color(&format!("✅ 缓存无变化: {}", cache_file.display()), GREEN);
        return false;
    }

    if let Err(err) = fs::write(&cache_file, &serialized) {
        print_color(&format!("❌ 保存缓存失败: {err}"), RED);
        return false;
    }

    *cache_data = sorted_cache_data;

    log.color(&format!("✅ 缓存已保存: {}", cache_file.display()), GREEN);
    log.color(&format!("   commits: {total_commits}"), NC);
    log.color(
        &format!(
            "   additions: {total_additions}  deletions: {total_deletions}  images: {total_images}"
        ),
        NC,
    );

    true
}

pub fn aggregate_stats_from_cache(app: &App) -> Stats {
    let mut stats = Stats::default();
    if !app.cache_dir.exists() {
        return stats;
    }

    let mut latest_key = i64::MIN;

    for cache_file in sorted_cache_files(&app.cache_dir) {
        let Ok(content) = read_text_normalized(&cache_file) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };

        let Some(data_object) = value.get("data").and_then(serde_json::Value::as_object) else {
            continue;
        };
        let Some(stem) = cache_file.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !data_object.contains_key(stem) {
            continue;
        }

        let Some(meta) = value
            .get("_metadata")
            .and_then(serde_json::Value::as_object)
        else {
            continue;
        };

        stats.total_commits += meta
            .get("total_commits")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);
        stats.total_additions += meta
            .get("total_additions")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);
        stats.total_deletions += meta
            .get("total_deletions")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);
        stats.total_images += meta
            .get("total_images")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);

        let timestamp = meta
            .get("latest_commit_timestamp")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let key = parse_iso_timestamp(timestamp);
        if key > latest_key {
            latest_key = key;
            stats.latest_commit_timestamp = timestamp.to_string();
        }
    }

    stats
}

// ============================================================================
// 过期缓存清理
// ============================================================================

/// 返回按文件名排序的缓存文件列表
fn sorted_cache_files(cache_dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return Vec::new();
    };

    let mut files: Vec<std::path::PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("json"))
        .collect();
    files.sort();

    files
}

pub fn cleanup_stale_cache_files(app: &App, active_repo_names: &HashSet<String>) -> bool {
    if !app.cache_dir.exists() || active_repo_names.is_empty() {
        return false;
    }

    let mut changed = false;
    for cache_file in sorted_cache_files(&app.cache_dir) {
        let Some(stem) = cache_file.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if active_repo_names.contains(stem) {
            continue;
        }

        match fs::remove_file(&cache_file) {
            Ok(()) => {
                changed = true;
                print_color(
                    &format!("🧹 已删除不存在仓库的缓存: {}", cache_file.display()),
                    YELLOW,
                );
            }
            Err(err) => {
                print_color(&format!("⚠️  删除陈旧缓存失败: {err}"), YELLOW);
            }
        }
    }

    changed
}

pub fn clean_stale_cache(
    cache_data: &mut CacheData,
    current_commits: &[CurrentCommit],
    repo_name: &str,
    owner: &str,
    is_api_fallback: bool,
    log: &mut Log,
) {
    if !cache_data.contains_key(repo_name) {
        return;
    }

    let mut current_urls: HashSet<String> = HashSet::new();
    let mut min_timestamp = String::new();
    let mut max_timestamp = String::new();

    for commit in current_commits {
        current_urls.insert(format!(
            "https://github.com/{owner}/{repo_name}/commit/{}",
            commit.sha
        ));
        if !commit.date.is_empty() {
            if min_timestamp.is_empty() || commit.date < min_timestamp {
                min_timestamp = commit.date.clone();
            }
            if max_timestamp.is_empty() || commit.date > max_timestamp {
                max_timestamp = commit.date.clone();
            }
        }
    }

    let items = cache_data.get(repo_name).cloned().unwrap_or_default();
    let mut in_range: Vec<CacheEntry> = Vec::new();
    let mut out_of_range: Vec<CacheEntry> = Vec::new();

    for item in items {
        let out = is_api_fallback
            && !min_timestamp.is_empty()
            && !max_timestamp.is_empty()
            && (item.timestamp < min_timestamp || item.timestamp > max_timestamp);
        if out {
            out_of_range.push(item);
        } else {
            in_range.push(item);
        }
    }

    let cached_urls_in_range: HashSet<String> = in_range
        .iter()
        .filter(|item| !item.url.is_empty())
        .map(|item| item.url.clone())
        .collect();
    let stale_commits: HashSet<String> = cached_urls_in_range
        .difference(&current_urls)
        .cloned()
        .collect();

    log_cache_cleanup_mode(
        is_api_fallback,
        &min_timestamp,
        &max_timestamp,
        out_of_range.len(),
        log,
    );

    if stale_commits.is_empty() {
        log.color("    ✅ 缓存数据完整，无消失的commits", GREEN);
        return;
    }

    log.color(
        &format!("    🧹 检测到 {} 个消失的commits", stale_commits.len()),
        YELLOW,
    );
    log.color("       原因：被变基、压缩或重写", YELLOW);

    let mut new_cache_list = out_of_range;
    new_cache_list.extend(
        in_range
            .into_iter()
            .filter(|item| !stale_commits.contains(&item.url)),
    );
    cache_data.insert(repo_name.to_string(), new_cache_list);

    log.color(
        &format!("    ✅ 已清除 {} 个过期的commit缓存", stale_commits.len()),
        GREEN,
    );

    if cache_data.get(repo_name).is_some_and(Vec::is_empty) {
        cache_data.remove(repo_name);
        log.color("    ℹ️  仓库缓存已清空", NC);
    }
}

/// 截取前 `count` 个字符（对应 Python 的字符串切片 `[:count]`）
fn truncate_chars(text: &str, count: usize) -> &str {
    match text.char_indices().nth(count) {
        Some((index, _)) => &text[..index],
        None => text,
    }
}

fn log_cache_cleanup_mode(
    is_api_fallback: bool,
    min_timestamp: &str,
    max_timestamp: &str,
    out_of_range_count: usize,
    log: &mut Log,
) {
    if is_api_fallback {
        let min_ts = if min_timestamp.is_empty() {
            "?"
        } else {
            truncate_chars(min_timestamp, 10)
        };
        let max_ts = if max_timestamp.is_empty() {
            "?"
        } else {
            truncate_chars(max_timestamp, 10)
        };
        let mode_desc = format!("API 兜底模式（检查范围: {min_ts} ~ {max_ts}）");
        if out_of_range_count > 0 {
            log.color(&format!("    ℹ️  {mode_desc}"), NC);
            log.color(
                &format!("       保留 {out_of_range_count} 个超出 API 范围的数据"),
                NC,
            );
        }
    } else {
        log.color("    ℹ️  Git log 模式（完整历史）", NC);
    }
}

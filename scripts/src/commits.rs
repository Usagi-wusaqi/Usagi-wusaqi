//! Commits 获取与分析（git log / git show 优先，GitHub API 兜底）

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::cache::{
    clean_stale_cache, load_cache, save_cache, CacheData, CacheEntry, CurrentCommit,
};
use crate::config::App;
use crate::github::{github_api_request, ApiError};
use crate::util::{format_number, now_iso_utc, run_command, Log, GREEN, NC, RED, YELLOW};

/// 单个仓库的处理上下文
pub struct RepoContext {
    pub repo_path: Option<PathBuf>,
    pub owner: String,
    pub repo_name: String,
    pub username: String,
}

#[derive(Default)]
pub struct CommitDetails {
    pub additions: i64,
    pub deletions: i64,
    pub files: Vec<FileStatus>,
}

pub struct FileStatus {
    pub filename: String,
    pub status: String,
}

// ============================================================================
// 仓库 URL 解析
// ============================================================================

/// 从 GitHub 仓库 URL 中提取 owner（对应 Python 的 `urllib.parse.urlparse().path`）
pub fn repo_owner_from_url(repo_url: &str) -> Option<String> {
    let after_scheme = match repo_url.find("://") {
        Some(index) => &repo_url[index + 3..],
        None => repo_url,
    };
    let index = after_scheme.find('/')?;
    let path = after_scheme[index..].trim_matches('/');
    let mut parts = path.split('/');
    let owner = parts.next()?;
    if owner.is_empty() || parts.next().is_none() {
        return None;
    }
    Some(owner.to_string())
}

fn build_commit_url(owner: &str, repo_name: &str, sha: &str) -> String {
    format!("https://github.com/{owner}/{repo_name}/commit/{sha}")
}

// ============================================================================
// Commits 数据获取
// ============================================================================

/// 解析 `git log --format=%H%n%aI` 的输出（交替两行：SHA 与 ISO 日期），去重后追加
fn collect_commits(
    git_log_output: &str,
    seen_shas: &mut HashSet<String>,
    result: &mut Vec<CurrentCommit>,
) {
    let lines: Vec<&str> = git_log_output
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();

    let mut index = 0;
    while index + 1 < lines.len() {
        let sha = lines[index];
        let iso_date = lines[index + 1];
        if seen_shas.insert(sha.to_string()) {
            result.push(CurrentCommit {
                sha: sha.to_string(),
                date: iso_date.to_string(),
            });
        }
        index += 2;
    }
}

/// 从本地 git log 获取用户的所有 commits（完整历史）
pub fn get_commits_from_git_log(
    app: &App,
    repo_path: &Path,
    default_branch: &str,
    log: &mut Log,
) -> Option<Vec<CurrentCommit>> {
    let identities = app.identity_snapshot();
    if identities.is_empty() {
        log.color("    ⚠️  没有已知作者身份，需要先从 API 学习", YELLOW);
        return None;
    }
    log.color(
        &format!("    ℹ️  使用 {} 个作者身份匹配", identities.len()),
        NC,
    );

    let branch_ref = format!("origin/{default_branch}");
    let mut seen_shas: HashSet<String> = HashSet::new();
    let mut all_commits: Vec<CurrentCommit> = Vec::new();

    for author in &identities {
        let safe = author.replace('"', "\\\"");
        // --author 匹配主作者 / --grep 匹配 Co-authored-by 标记
        for flag in [
            format!("--author={safe}"),
            format!("--grep=Co-authored-by: {safe}"),
        ] {
            let (output, code) = run_command(
                "git",
                &["log", &branch_ref, &flag, "--format=%H%n%aI"],
                Some(repo_path),
            );
            if code == 0 {
                collect_commits(&output, &mut seen_shas, &mut all_commits);
            }
        }
    }

    if all_commits.is_empty() {
        log.color("    ⚠️  git log 失败", YELLOW);
        return None;
    }
    log.color(
        &format!("    ℹ️  git log 获取 {} 个commits", all_commits.len()),
        NC,
    );
    Some(all_commits)
}

/// 从 GitHub API 获取用户的最近 commits（分页，最多 max_api_pages 页）
pub fn get_commits_from_api(
    app: &App,
    owner: &str,
    repo_name: &str,
    username: &str,
    default_branch: &str,
    log: &mut Log,
) -> Vec<CurrentCommit> {
    let max_pages = app.rc.max_api_pages;
    let per_page = app.rc.per_page;
    let mut page = 1i64;
    let mut all_commits: Vec<CurrentCommit> = Vec::new();

    while page <= max_pages {
        let api_url = format!(
            "{}/repos/{owner}/{repo_name}/commits?author={username}&sha={default_branch}&per_page={per_page}&page={page}",
            app.rc.github_api
        );
        log.color(&format!("    🔍 API 获取commits (第{page}页)..."), NC);

        let output = match github_api_request(app, &api_url) {
            Ok(output) => output,
            Err(ApiError::RateLimit(message)) => {
                app.set_rate_limit(message);
                return all_commits;
            }
            Err(ApiError::Failure) => {
                log.color("    ❌ API调用失败", RED);
                return all_commits;
            }
        };

        match serde_json::from_str::<serde_json::Value>(&output) {
            Ok(serde_json::Value::Array(items)) => {
                if items.is_empty() {
                    break;
                }
                for item in &items {
                    all_commits.push(commit_from_api_value(item));
                }
                log.color(
                    &format!("    📊 已获取 {} 个commits", all_commits.len()),
                    NC,
                );
                if items.len() < per_page as usize {
                    break;
                }
                page += 1;
            }
            Ok(_) => break,
            Err(err) => {
                log.color(&format!("    ❌ JSON 解析失败: {err}"), RED);
                return all_commits;
            }
        }
    }

    if page > max_pages {
        log.color(
            &format!(
                "    ℹ️  已达到最大页数限制 ({max_pages} 页)，共 {} 个commits",
                all_commits.len()
            ),
            NC,
        );
    }

    all_commits
}

fn commit_from_api_value(item: &serde_json::Value) -> CurrentCommit {
    let sha = item
        .get("sha")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    let date = item
        .get("commit")
        .and_then(|commit| commit.get("author"))
        .and_then(|author| author.get("date"))
        .and_then(serde_json::Value::as_str)
        .filter(|date| !date.is_empty())
        .map(String::from)
        .unwrap_or_else(now_iso_utc);
    CurrentCommit { sha, date }
}

/// 获取 commits，Git log 优先，API 兜底；返回 (commits, is_api_fallback)
fn fetch_commits_with_fallback(
    app: &App,
    ctx: &RepoContext,
    default_branch: &str,
    log: &mut Log,
) -> (Vec<CurrentCommit>, bool) {
    if let Some(repo_path) = &ctx.repo_path {
        if let Some(commits) = get_commits_from_git_log(app, repo_path, default_branch, log) {
            log.color(
                &format!(
                    "    ✅ 使用 Git log（完整历史）: {} 个commits",
                    commits.len()
                ),
                GREEN,
            );
            return (commits, false);
        }
    }

    log.color("    ⚠️  Git log 无数据，尝试 API 兜底...", YELLOW);

    let api_commits = get_commits_from_api(
        app,
        &ctx.owner,
        &ctx.repo_name,
        &ctx.username,
        default_branch,
        log,
    );

    if !api_commits.is_empty() {
        log.color(
            &format!("    ✅ 使用 API 兜底数据: {} 个commits", api_commits.len()),
            GREEN,
        );
        log.color(
            "    ⚠️  注意: API 有分页限制，超出范围的老数据将保留缓存",
            YELLOW,
        );
        return (api_commits, true);
    }

    (Vec::new(), false)
}

// ============================================================================
// Commit 详情
// ============================================================================

/// 从本地 git 获取 commit 详情（--shortstat 与 --name-status 是互斥格式，故分两条命令）
pub fn get_commit_details_from_git(repo_path: &Path, sha: &str) -> CommitDetails {
    let mut details = CommitDetails::default();

    let (output, code) = run_command(
        "git",
        &["show", "--shortstat", "--pretty=format:", sha],
        Some(repo_path),
    );
    if code == 0 {
        for line in output.split('\n') {
            let stripped = line.trim();
            if stripped.is_empty() {
                continue;
            }
            // 形如 "3 files changed, 10 insertions(+), 5 deletions(-)"
            if stripped.contains("changed")
                && (stripped.contains("insertion") || stripped.contains("deletion"))
            {
                if let Some(value) = capture_before(stripped, " insertion") {
                    details.additions = value;
                }
                if let Some(value) = capture_before(stripped, " deletion") {
                    details.deletions = value;
                }
                break;
            }
        }
    }

    let (output, code) = run_command(
        "git",
        &["show", "--name-status", "--pretty=format:", sha],
        Some(repo_path),
    );
    if code == 0 {
        for line in output.split('\n') {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 2 {
                continue;
            }
            // R100 -> R, C100 -> C
            let status_code = parts[0].trim_end_matches(|ch: char| ch.is_ascii_digit());
            if (status_code == "R" || status_code == "C") && parts.len() >= 3 {
                details.files.push(FileStatus {
                    filename: parts[2].to_string(),
                    status: if status_code == "C" {
                        "added"
                    } else {
                        "modified"
                    }
                    .to_string(),
                });
            } else {
                details.files.push(FileStatus {
                    filename: parts[1].to_string(),
                    status: if parts[0] == "A" { "added" } else { "modified" }.to_string(),
                });
            }
        }
    }

    details
}

/// 取 `suffix` 之前紧邻的数字（对应 Python 的 `re.search(r"(\d+) <suffix>")`）
fn capture_before(text: &str, suffix: &str) -> Option<i64> {
    let mut search_from = 0;
    while let Some(offset) = text[search_from..].find(suffix) {
        let index = search_from + offset;
        let digits: String = text[..index]
            .chars()
            .rev()
            .take_while(|ch| ch.is_ascii_digit())
            .collect();
        if !digits.is_empty() {
            let value: String = digits.chars().rev().collect();
            return value.parse().ok();
        }
        search_from = index + suffix.len();
    }
    None
}

/// 从 API 获取 commit 详情
fn get_commit_details_from_api(
    app: &App,
    owner: &str,
    repo_name: &str,
    sha: &str,
) -> CommitDetails {
    let api_url = format!(
        "{}/repos/{owner}/{repo_name}/commits/{sha}",
        app.rc.github_api
    );
    match github_api_request(app, &api_url) {
        Ok(output) => match serde_json::from_str::<serde_json::Value>(&output) {
            Ok(value) => details_from_api_value(&value),
            Err(_) => CommitDetails::default(),
        },
        Err(ApiError::RateLimit(message)) => {
            app.set_rate_limit(message);
            CommitDetails::default()
        }
        Err(ApiError::Failure) => CommitDetails::default(),
    }
}

fn details_from_api_value(value: &serde_json::Value) -> CommitDetails {
    let stats = value.get("stats");
    let additions = stats
        .and_then(|stats| stats.get("additions"))
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);
    let deletions = stats
        .and_then(|stats| stats.get("deletions"))
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(0);

    let mut files = Vec::new();
    if let Some(items) = value.get("files").and_then(serde_json::Value::as_array) {
        for item in items {
            files.push(FileStatus {
                filename: item
                    .get("filename")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                status: item
                    .get("status")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            });
        }
    }

    CommitDetails {
        additions,
        deletions,
        files,
    }
}

/// 计算单个 commit 的统计数据，返回 (additions, deletions, images)
fn calculate_commit_stats(app: &App, details: &CommitDetails) -> (i64, i64, i64) {
    let mut images = 0;
    for file in &details.files {
        if file.status == "added" && is_image_file(app, &file.filename) {
            images += 1;
        }
    }
    (details.additions, details.deletions, images)
}

fn is_image_file(app: &App, filename: &str) -> bool {
    let lower = filename.to_lowercase();
    app.rc
        .image_extensions
        .iter()
        .any(|ext| lower.ends_with(ext.as_str()))
}

// ============================================================================
// 分析主流程
// ============================================================================

/// 分析代码贡献并保存缓存，返回缓存是否有变更
pub fn analyze_commits(app: &App, ctx: &RepoContext, log: &mut Log) -> bool {
    log.color("    📊 开始分析commits...", YELLOW);

    let mut cache_data = load_cache(app, &ctx.repo_name, log);

    let mut default_branch = "main".to_string();
    if let Some(repo_path) = &ctx.repo_path {
        let (output, code) = run_command(
            "git",
            &["symbolic-ref", "refs/remotes/origin/HEAD"],
            Some(repo_path),
        );
        default_branch = if code == 0 {
            output
                .strip_prefix("refs/remotes/origin/")
                .unwrap_or(&output)
                .to_string()
        } else {
            "main".to_string()
        };
        log.color(&format!("    ℹ️  默认分支: {default_branch}"), NC);
    }

    let (all_commits, is_api_fallback) =
        fetch_commits_with_fallback(app, ctx, &default_branch, log);

    if all_commits.is_empty() {
        log.color("    ℹ️  未找到commits", NC);
        return false;
    }

    let total_commits = all_commits.len() as i64;
    log.color(&format!("    📊 最终使用 {total_commits} 个commits"), NC);

    // 清理过期缓存（当前仓库中已经消失的 commit 链接）
    let old_count = cache_data.get(&ctx.repo_name).map_or(0, Vec::len);
    clean_stale_cache(
        &mut cache_data,
        &all_commits,
        &ctx.repo_name,
        &ctx.owner,
        is_api_fallback,
        log,
    );
    let stale_cleaned = cache_data.get(&ctx.repo_name).map_or(0, Vec::len) != old_count;

    let (total_additions, total_deletions, total_images, cache_hits, cache_misses) =
        process_all_commits(app, ctx, &all_commits, &mut cache_data, log);

    print_cache_stats(cache_hits, cache_misses, total_commits, log);
    print_stats_summary(log, total_additions, total_deletions, total_images, "    ");

    let saved_changed = save_cache(app, &ctx.repo_name, &mut cache_data, log);

    cache_misses > 0 || stale_cleaned || saved_changed
}

/// 处理所有 commits 并统计，返回 (additions, deletions, images, cache_hits, cache_misses)
fn process_all_commits(
    app: &App,
    ctx: &RepoContext,
    all_commits: &[CurrentCommit],
    cache_data: &mut CacheData,
    log: &mut Log,
) -> (i64, i64, i64, i64, i64) {
    let mut total_additions = 0i64;
    let mut total_deletions = 0i64;
    let mut total_images = 0i64;
    let mut cache_hits = 0i64;
    let mut cache_misses = 0i64;
    let mut processed = 0i64;
    let total_commits = all_commits.len() as i64;

    // 构建缓存索引 O(1) 查找
    let mut cache_index: HashMap<String, CacheEntry> = HashMap::new();
    if let Some(items) = cache_data.get(&ctx.repo_name) {
        for item in items {
            if !item.url.is_empty() {
                cache_index.insert(item.url.clone(), item.clone());
            }
        }
    }

    for commit in all_commits {
        if commit.sha.is_empty() {
            continue;
        }

        processed += 1;
        if processed % app.rc.progress_interval == 0 {
            let pct = processed * 100 / total_commits;
            log.color(
                &format!("    📊 处理中: {processed}/{total_commits} ({pct}%)"),
                NC,
            );
        }

        let commit_url = build_commit_url(&ctx.owner, &ctx.repo_name, &commit.sha);

        // 缓存命中：复用已统计的数据
        if let Some(entry) = cache_index.get(&commit_url) {
            total_additions += entry.additions;
            total_deletions += entry.deletions;
            total_images += entry.images;
            cache_hits += 1;
            continue;
        }

        // 缓存未命中，获取详情
        cache_misses += 1;
        let details = match &ctx.repo_path {
            Some(repo_path) => get_commit_details_from_git(repo_path, &commit.sha),
            None => get_commit_details_from_api(app, &ctx.owner, &ctx.repo_name, &commit.sha),
        };

        let (additions, deletions, images) = calculate_commit_stats(app, &details);
        total_additions += additions;
        total_deletions += deletions;
        total_images += images;

        cache_data
            .entry(ctx.repo_name.clone())
            .or_default()
            .push(CacheEntry {
                timestamp: commit.date.clone(),
                index: processed,
                additions,
                deletions,
                images,
                url: commit_url,
            });
    }

    (
        total_additions,
        total_deletions,
        total_images,
        cache_hits,
        cache_misses,
    )
}

fn print_cache_stats(cache_hits: i64, cache_misses: i64, total_commits: i64, log: &mut Log) {
    log.color("    💾 缓存统计:", YELLOW);
    log.color(&format!("       - 缓存命中: {cache_hits} 个commit"), NC);
    log.color(&format!("       - 缓存未命中: {cache_misses} 个commit"), NC);
    if total_commits > 0 {
        let cache_hit_rate = cache_hits as f64 / total_commits as f64 * 100.0;
        log.color(&format!("       - 缓存命中率: {cache_hit_rate:.1}%"), NC);
    }
}

fn print_stats_summary(log: &mut Log, additions: i64, deletions: i64, images: i64, prefix: &str) {
    let net = additions - deletions;
    let net_sign = if net >= 0 { "+" } else { "" };
    log.color(
        &format!(
            "{prefix}✅ +{} / -{} (net {net_sign}{})",
            format_number(additions),
            format_number(deletions),
            format_number(net)
        ),
        GREEN,
    );
    log.color(&format!("{prefix}   🖼️ 图片: {images} images"), GREEN);
}

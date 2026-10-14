//! 配置加载、作者身份存取、全局运行上下文

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::cache::to_py_json;
use crate::util::{base64_decode, base64_encode, print_color, read_text_normalized, GREEN, YELLOW};

pub const MANIFEST_DIR: &str = env!("CARGO_MANIFEST_DIR");

/// 项目根目录（对应 Python 脚本的 `Path(__file__).parent.parent`）
pub fn project_root() -> PathBuf {
    Path::new(MANIFEST_DIR)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(MANIFEST_DIR))
}

// ============================================================================
// config.toml 结构
// ============================================================================

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct ApiConfig {
    pub github_api_base: String,
    pub max_api_pages: i64,
    pub per_page: i64,
    pub rate_limit_warn_threshold: i64,
}

pub struct VercelConfig {
    pub base_url: String,
    pub hide_border: bool,
    pub cache_seconds: i64,
}

impl Default for VercelConfig {
    fn default() -> Self {
        Self {
            base_url: String::new(),
            hide_border: true,
            cache_seconds: 86400,
        }
    }
}

impl<'de> Deserialize<'de> for VercelConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Raw {
            base_url: Option<String>,
            hide_border: Option<bool>,
            cache_seconds: Option<i64>,
        }

        let raw = Raw::deserialize(deserializer)?;
        let defaults = VercelConfig::default();
        Ok(VercelConfig {
            base_url: raw.base_url.unwrap_or(defaults.base_url),
            hide_border: raw.hide_border.unwrap_or(defaults.hide_border),
            cache_seconds: raw.cache_seconds.unwrap_or(defaults.cache_seconds),
        })
    }
}

pub struct SvgLayout {
    pub padding: i64,
    pub title_y: i64,
    pub stats_y: i64,
    pub value_gap: i64,
    pub border_radius: f64,
}

impl Default for SvgLayout {
    fn default() -> Self {
        Self {
            padding: 67,
            title_y: 70,
            stats_y: 120,
            value_gap: 36,
            border_radius: 4.5,
        }
    }
}

impl<'de> Deserialize<'de> for SvgLayout {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Raw {
            padding: Option<i64>,
            title_y: Option<i64>,
            stats_y: Option<i64>,
            value_gap: Option<i64>,
            border_radius: Option<f64>,
        }

        let raw = Raw::deserialize(deserializer)?;
        let defaults = SvgLayout::default();
        Ok(SvgLayout {
            padding: raw.padding.unwrap_or(defaults.padding),
            title_y: raw.title_y.unwrap_or(defaults.title_y),
            stats_y: raw.stats_y.unwrap_or(defaults.stats_y),
            value_gap: raw.value_gap.unwrap_or(defaults.value_gap),
            border_radius: raw.border_radius.unwrap_or(defaults.border_radius),
        })
    }
}

pub struct SvgFont {
    pub family: String,
    pub family_extended: String,
    pub header_size: String,
    pub header_size_firefox: String,
    pub stat_size: String,
    pub bold_size: String,
}

impl Default for SvgFont {
    fn default() -> Self {
        Self {
            family: "'Segoe UI', Ubuntu, Sans-Serif".to_string(),
            family_extended: "'Segoe UI', Ubuntu, 'Helvetica Neue', Sans-Serif".to_string(),
            header_size: "600 48px".to_string(),
            header_size_firefox: "41px".to_string(),
            stat_size: "600 20px".to_string(),
            bold_size: "700 36px".to_string(),
        }
    }
}

impl<'de> Deserialize<'de> for SvgFont {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Raw {
            family: Option<String>,
            family_extended: Option<String>,
            header_size: Option<String>,
            header_size_firefox: Option<String>,
            stat_size: Option<String>,
            bold_size: Option<String>,
        }

        let raw = Raw::deserialize(deserializer)?;
        let defaults = SvgFont::default();
        Ok(SvgFont {
            family: raw.family.unwrap_or(defaults.family),
            family_extended: raw.family_extended.unwrap_or(defaults.family_extended),
            header_size: raw.header_size.unwrap_or(defaults.header_size),
            header_size_firefox: raw
                .header_size_firefox
                .unwrap_or(defaults.header_size_firefox),
            stat_size: raw.stat_size.unwrap_or(defaults.stat_size),
            bold_size: raw.bold_size.unwrap_or(defaults.bold_size),
        })
    }
}

pub struct SvgLabels {
    pub additions: String,
    pub deletions: String,
    pub net: String,
    pub images: String,
}

impl Default for SvgLabels {
    fn default() -> Self {
        Self {
            additions: "Additions".to_string(),
            deletions: "Deletions".to_string(),
            net: "Net".to_string(),
            images: "Images".to_string(),
        }
    }
}

impl<'de> Deserialize<'de> for SvgLabels {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Raw {
            additions: Option<String>,
            deletions: Option<String>,
            net: Option<String>,
            images: Option<String>,
        }

        let raw = Raw::deserialize(deserializer)?;
        let defaults = SvgLabels::default();
        Ok(SvgLabels {
            additions: raw.additions.unwrap_or(defaults.additions),
            deletions: raw.deletions.unwrap_or(defaults.deletions),
            net: raw.net.unwrap_or(defaults.net),
            images: raw.images.unwrap_or(defaults.images),
        })
    }
}

#[derive(Default)]
pub struct SvgConfig {
    pub custom_title: Option<String>,
    pub title_color: String,
    pub text_color: String,
    pub bg_color: String,
    pub border_color: String,
    pub add_color: String,
    pub del_color: String,
    pub img_color: String,
    pub width: i64,
    pub height: i64,
    pub layout: SvgLayout,
    pub font: SvgFont,
    pub labels: SvgLabels,
}

impl<'de> Deserialize<'de> for SvgConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Raw {
            custom_title: Option<String>,
            title_color: Option<String>,
            text_color: Option<String>,
            bg_color: Option<String>,
            border_color: Option<String>,
            add_color: Option<String>,
            del_color: Option<String>,
            img_color: Option<String>,
            width: Option<i64>,
            height: Option<i64>,
            layout: Option<SvgLayout>,
            font: Option<SvgFont>,
            labels: Option<SvgLabels>,
        }

        let raw = Raw::deserialize(deserializer)?;
        let defaults = SvgConfig::default();
        Ok(SvgConfig {
            custom_title: raw.custom_title,
            title_color: raw.title_color.unwrap_or(defaults.title_color),
            text_color: raw.text_color.unwrap_or(defaults.text_color),
            bg_color: raw.bg_color.unwrap_or(defaults.bg_color),
            border_color: raw.border_color.unwrap_or(defaults.border_color),
            add_color: raw.add_color.unwrap_or(defaults.add_color),
            del_color: raw.del_color.unwrap_or(defaults.del_color),
            img_color: raw.img_color.unwrap_or(defaults.img_color),
            width: raw.width.unwrap_or(defaults.width),
            height: raw.height.unwrap_or(defaults.height),
            layout: raw.layout.unwrap_or(defaults.layout),
            font: raw.font.unwrap_or(defaults.font),
            labels: raw.labels.unwrap_or(defaults.labels),
        })
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct BehaviorConfig {
    pub separator_length: usize,
    pub image_extensions: Vec<String>,
    pub progress_interval: i64,
    pub timezone_offset_hours: i64,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Config {
    pub author_identities: String,
    pub api: ApiConfig,
    pub vercel: VercelConfig,
    pub svg: SvgConfig,
    pub behavior: BehaviorConfig,
}

/// 运行时配置（由 `apply_config()` 派生，供全局引用）
pub struct RuntimeConfig {
    pub github_api: String,
    pub separator_length: usize,
    pub max_api_pages: i64,
    pub per_page: i64,
    pub rate_limit_warn_threshold: i64,
    pub progress_interval: i64,
    pub image_extensions: Vec<String>,
}

// ============================================================================
// 加载与派生
// ============================================================================

/// 从 config.toml 加载配置；文件缺失或解析失败时返回默认配置
pub fn load_config(config_path: &Path) -> Config {
    match fs::read_to_string(config_path) {
        Ok(content) => toml::from_str(&content).unwrap_or_default(),
        Err(_) => Config::default(),
    }
}

pub fn apply_config(config: &Config) -> RuntimeConfig {
    RuntimeConfig {
        github_api: config.api.github_api_base.clone(),
        separator_length: config.behavior.separator_length,
        max_api_pages: config.api.max_api_pages,
        per_page: config.api.per_page,
        rate_limit_warn_threshold: config.api.rate_limit_warn_threshold,
        progress_interval: if config.behavior.progress_interval == 0 {
            10
        } else {
            config.behavior.progress_interval
        },
        image_extensions: config.behavior.image_extensions.clone(),
    }
}

// ============================================================================
// 全局运行上下文
// ============================================================================

pub struct App {
    pub origin_username: String,
    pub upstream_username: String,
    pub token: String,
    pub config: Config,
    pub rc: RuntimeConfig,
    pub cache_dir: PathBuf,
    pub readme_path: PathBuf,
    pub template_path: PathBuf,
    pub config_path: PathBuf,
    pub svg_path: PathBuf,
    pub identities: Mutex<BTreeSet<String>>,
    pub identities_changed: AtomicBool,
    pub rate_limit: Mutex<Option<String>>,
}

impl App {
    pub fn new(origin_username: String, upstream_username: String, token: String) -> Self {
        let root = project_root();
        let config_path = root.join("config.toml");
        let config = load_config(&config_path);
        let rc = apply_config(&config);

        Self {
            origin_username,
            upstream_username,
            token,
            config,
            rc,
            cache_dir: Path::new(MANIFEST_DIR).join("stats_cache"),
            readme_path: root.join("README.md"),
            template_path: root.join("README.template.md"),
            config_path,
            svg_path: root.join("contributions.svg"),
            identities: Mutex::new(BTreeSet::new()),
            identities_changed: AtomicBool::new(false),
            rate_limit: Mutex::new(None),
        }
    }

    pub fn cache_file(&self, repo_name: &str) -> PathBuf {
        self.cache_dir.join(format!("{repo_name}.json"))
    }

    /// 已知作者身份的快照（排序后，保证并发下的确定性）
    pub fn identity_snapshot(&self) -> Vec<String> {
        self.identities
            .lock()
            .map(|guard| guard.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// 合并新身份，返回是否出现新增
    pub fn merge_identities(&self, new_identities: &BTreeSet<String>) -> bool {
        let mut guard = match self.identities.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let before = guard.len();
        guard.extend(new_identities.iter().cloned());
        guard.len() > before
    }

    pub fn set_rate_limit(&self, message: String) {
        if let Ok(mut guard) = self.rate_limit.lock() {
            if guard.is_none() {
                *guard = Some(message);
            }
        }
    }

    pub fn take_rate_limit(&self) -> Option<String> {
        self.rate_limit.lock().ok().and_then(|mut g| g.take())
    }
}

// ============================================================================
// 作者身份管理
// ============================================================================

pub fn load_author_identities(app: &App) -> BTreeSet<String> {
    let raw = app.config.author_identities.trim();
    if raw.is_empty() {
        return BTreeSet::new();
    }

    match decode_identities(raw) {
        Some(identities) => {
            if !identities.is_empty() {
                print_color(
                    &format!("💾 已加载 {} 个已知作者身份", identities.len()),
                    GREEN,
                );
            }
            identities
        }
        None => {
            print_color("⚠️  加载作者身份失败", YELLOW);
            BTreeSet::new()
        }
    }
}

fn decode_identities(raw: &str) -> Option<BTreeSet<String>> {
    let bytes = base64_decode(raw)?;
    let text = String::from_utf8(bytes).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;

    let mut identities = BTreeSet::new();
    if let Some(items) = value.get("identities").and_then(|items| items.as_array()) {
        for item in items {
            if let Some(identity) = item.as_str() {
                identities.insert(identity.to_string());
            }
        }
    }
    Some(identities)
}

#[derive(Serialize)]
struct IdentityDocument<'a> {
    identities: &'a [String],
}

/// 保存作者身份列表到 config.toml（Base64 编码）
pub fn save_author_identities(app: &App) {
    let identities = app.identity_snapshot();
    let document = IdentityDocument {
        identities: &identities,
    };
    let json_text = to_py_json(&document);
    let encoded = base64_encode(json_text.as_bytes());

    let content = match read_text_normalized(&app.config_path) {
        Ok(content) => content,
        Err(err) => {
            print_color(&format!("⚠️  保存作者身份失败: {err}"), YELLOW);
            return;
        }
    };

    let updated = update_toml_values(&content, "author_identities", &encoded);
    if let Err(err) = fs::write(&app.config_path, updated) {
        print_color(&format!("⚠️  保存作者身份失败: {err}"), YELLOW);
        return;
    }

    print_color(&format!("💾 已保存 {} 个作者身份", identities.len()), GREEN);
}

/// 正则原地替换 TOML 中的单个键值对（保留注释与格式）
fn update_toml_values(content: &str, key: &str, value: &str) -> String {
    let replacement = format!("\"{value}\"");
    let mut out = String::with_capacity(content.len());
    let mut replaced = false;

    for line in content.split_inclusive('\n') {
        if !replaced {
            if let Some(prefix_len) = match_key_prefix(line, key) {
                out.push_str(&line[..prefix_len]);
                out.push_str(&replacement);
                if line.ends_with('\n') {
                    out.push('\n');
                }
                replaced = true;
                continue;
            }
        }
        out.push_str(line);
    }

    if !replaced {
        print_color(
            &format!("⚠️  config.toml 中未找到键 '{key}'，跳过更新"),
            YELLOW,
        );
    }

    out
}

/// 匹配行首的 `key` + 空白 + `=` + 空白，返回替换起点
fn match_key_prefix(line: &str, key: &str) -> Option<usize> {
    if !line.starts_with(key) {
        return None;
    }

    let bytes = line.as_bytes();
    let mut idx = key.len();

    while idx < bytes.len() && (bytes[idx] == b' ' || bytes[idx] == b'\t') {
        idx += 1;
    }
    if idx >= bytes.len() || bytes[idx] != b'=' {
        return None;
    }
    idx += 1;
    while idx < bytes.len() && (bytes[idx] == b' ' || bytes[idx] == b'\t') {
        idx += 1;
    }

    Some(idx)
}

/// 从 README.md 读取默认的用户名变量
pub fn get_default_from_readme(readme_path: &Path, var_name: &str) -> Option<String> {
    let content = read_text_normalized(readme_path).ok()?;
    let marker = format!("{var_name} = ");

    for line in content.split('\n') {
        if let Some(pos) = line.find(&marker) {
            let value = line[pos + marker.len()..].trim();
            return Some(value.to_string());
        }
    }
    None
}

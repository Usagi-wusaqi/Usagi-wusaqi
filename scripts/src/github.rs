//! GitHub API 交互（通过 curl 子进程发起请求）

use std::collections::BTreeSet;
use std::process::Command;
use std::sync::atomic::Ordering;

use serde::Deserialize;

use crate::config::App;
use crate::util::{print_color, Log, GREEN, NC, RED, YELLOW};

pub enum ApiError {
    /// 配额耗尽，需要终止整个流程
    RateLimit(String),
    /// 其他失败（网络、非 2xx）
    Failure,
}

#[derive(Deserialize, Default, Clone)]
#[serde(default)]
pub struct RepoInfo {
    pub name: Option<String>,
    pub html_url: Option<String>,
    pub fork: bool,
    pub source: Option<serde_json::Value>,
    pub parent: Option<serde_json::Value>,
}

impl RepoInfo {
    fn upstream_value(&self) -> Option<serde_json::Value> {
        non_null(self.source.clone()).or_else(|| non_null(self.parent.clone()))
    }
}

fn non_null(value: Option<serde_json::Value>) -> Option<serde_json::Value> {
    value.filter(|item| !item.is_null())
}

// ============================================================================
// HTTP（curl）
// ============================================================================

pub fn github_api_request(app: &App, api_url: &str) -> Result<String, ApiError> {
    let authorization = format!("Authorization: token {}", app.token);
    let mut args: Vec<&str> = vec!["-s", "-i", "-H", "Accept: application/vnd.github.v3+json"];
    if !app.token.is_empty() {
        args.push("-H");
        args.push(authorization.as_str());
    }
    args.push(api_url);

    let raw = match curl(&args) {
        Some(raw) => raw,
        None => {
            print_color("❌ 网络请求失败", RED);
            return Err(ApiError::Failure);
        }
    };

    let (head, body) = split_http(&raw);
    let status = parse_status(head);
    let remaining = header_value(head, "x-ratelimit-remaining")
        .and_then(|value| value.trim().parse::<i64>().ok());

    if (200..400).contains(&status) {
        if let Some(remaining) = remaining {
            if remaining < app.rc.rate_limit_warn_threshold {
                print_color(&format!("⚠️  API 配额剩余: {remaining}"), YELLOW);
            }
        }
        return Ok(body);
    }

    if (status == 403 || status == 429) && remaining == Some(0) {
        let message = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .get("message")
                    .and_then(|m| m.as_str())
                    .map(String::from)
            })
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(ApiError::RateLimit(format!(
            "GitHub API 配额耗尽: {message}"
        )));
    }

    Err(ApiError::Failure)
}

fn curl(args: &[&str]) -> Option<String> {
    match Command::new("curl").args(args).output() {
        Ok(output) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        _ => None,
    }
}

fn split_http(raw: &str) -> (&str, String) {
    if let Some(index) = raw.find("\r\n\r\n") {
        (&raw[..index], raw[index + 4..].to_string())
    } else if let Some(index) = raw.find("\n\n") {
        (&raw[..index], raw[index + 2..].to_string())
    } else {
        (raw, String::new())
    }
}

fn parse_status(head: &str) -> i64 {
    head.lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<i64>().ok())
        .unwrap_or(0)
}

fn header_value(head: &str, name: &str) -> Option<String> {
    for line in head.lines().skip(1) {
        if let Some((key, value)) = line.split_once(':') {
            if key.trim().eq_ignore_ascii_case(name) {
                return Some(value.to_string());
            }
        }
    }
    None
}

// ============================================================================
// 仓库列表
// ============================================================================

pub fn get_repos(app: &App) -> Result<Vec<RepoInfo>, String> {
    print_color("📡 获取所有仓库列表...", YELLOW);

    let mut repos: Vec<RepoInfo> = Vec::new();
    let mut page = 1i64;

    while page <= app.rc.max_api_pages {
        let api_url = format!(
            "{}/users/{}/repos?per_page={}&type=all&page={page}",
            app.rc.github_api, app.origin_username, app.rc.per_page
        );

        let output = match github_api_request(app, &api_url) {
            Ok(output) => output,
            Err(ApiError::RateLimit(message)) => return Err(message),
            Err(ApiError::Failure) => {
                print_color("❌ 获取仓库列表失败", RED);
                return Ok(repos);
            }
        };

        match serde_json::from_str::<serde_json::Value>(&output) {
            Ok(serde_json::Value::Array(items)) => {
                if items.is_empty() {
                    break;
                }

                for item in &items {
                    if let Ok(repo) = serde_json::from_value::<RepoInfo>(item.clone()) {
                        repos.push(repo);
                    }
                }

                print_color(
                    &format!("   第 {page} 页：获取到 {} 个仓库", items.len()),
                    NC,
                );

                if items.len() < app.rc.per_page as usize {
                    break;
                }
                page += 1;
            }
            Ok(serde_json::Value::Object(object)) => {
                let message = object
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
                    .to_string();
                if !message.is_empty() {
                    print_color(&format!("❌ API 错误: {message}"), RED);
                    return Ok(repos);
                }
                break;
            }
            Ok(_) => break,
            Err(err) => {
                print_color(&format!("❌ JSON 解析失败: {err}"), RED);
                let preview: String = output.chars().take(500).collect();
                print_color(&format!("数据内容: {preview}"), RED);
                return Ok(repos);
            }
        }
    }

    print_color(&format!("✅ 获取到 {} 个仓库", repos.len()), GREEN);
    for repo in &repos {
        let repo_name = repo.name.as_deref().unwrap_or("Unknown");
        let kind = if repo.fork { "Fork" } else { "原创" };
        print_color(&format!("   - {repo_name} ({kind})"), NC);
    }

    Ok(repos)
}

/// 获取 fork 仓库的上游信息
pub fn get_upstream_repo(app: &App, repo: &RepoInfo) -> (Option<String>, Option<String>) {
    if !repo.fork {
        return (None, None);
    }

    let mut upstream = repo.upstream_value();

    if upstream.is_none() {
        let Some(repo_name) = repo.name.as_deref() else {
            return (None, None);
        };

        let api_url = format!(
            "{}/repos/{}/{repo_name}",
            app.rc.github_api, app.origin_username
        );
        match github_api_request(app, &api_url) {
            Ok(output) => {
                if let Ok(detail) = serde_json::from_str::<serde_json::Value>(&output) {
                    upstream = non_null(detail.get("source").cloned())
                        .or_else(|| non_null(detail.get("parent").cloned()));
                }
            }
            Err(ApiError::RateLimit(message)) => app.set_rate_limit(message),
            Err(ApiError::Failure) => {}
        }
    }

    if let Some(value) = upstream {
        let owner = value
            .get("owner")
            .and_then(|owner| owner.get("login"))
            .and_then(|login| login.as_str());
        let name = value.get("name").and_then(|name| name.as_str());

        if let (Some(owner), Some(name)) = (owner, name) {
            print_color(&format!("    📡 检测到上游仓库: {owner}/{name}"), NC);
            return (Some(owner.to_string()), Some(name.to_string()));
        }
    }

    (None, None)
}

// ============================================================================
// 作者身份学习（复用「预筛探测」的同一次请求）
// ============================================================================

/// 探测该仓库中用户是否有提交；成功时返回 commits 数组
pub fn probe_user_commits(
    app: &App,
    owner: &str,
    repo_name: &str,
    username: &str,
    log: &mut Log,
) -> Option<Vec<serde_json::Value>> {
    log.color("    🔍 从 API 学习作者身份...", YELLOW);

    let api_url = format!(
        "{}/repos/{owner}/{repo_name}/commits?author={username}&per_page={}&page=1",
        app.rc.github_api, app.rc.per_page
    );

    let output = match github_api_request(app, &api_url) {
        Ok(output) => output,
        Err(ApiError::RateLimit(message)) => {
            app.set_rate_limit(message);
            return None;
        }
        Err(ApiError::Failure) => return None,
    };

    match serde_json::from_str::<serde_json::Value>(&output) {
        Ok(serde_json::Value::Array(items)) => Some(items),
        _ => None,
    }
}

/// 从探测到的 commits 中提取作者身份并合并到全局集合
pub fn learn_identities(app: &App, commits: &[serde_json::Value], log: &mut Log) {
    let mut found: BTreeSet<String> = BTreeSet::new();
    for commit in commits {
        if let Some(identity) = extract_author_from_commit(commit) {
            found.insert(identity);
        }
    }

    if found.is_empty() {
        return;
    }

    log.color(&format!("    ✅ 发现 {} 个作者身份", found.len()), GREEN);
    for identity in &found {
        log.color(&format!("       - {identity}"), NC);
    }

    if app.merge_identities(&found) {
        app.identities_changed.store(true, Ordering::Relaxed);
        let total = app.identity_snapshot().len();
        log.color(&format!("    ✅ 发现新身份，共 {total} 个"), GREEN);
    }
}

fn extract_author_from_commit(commit: &serde_json::Value) -> Option<String> {
    let author = commit.get("commit")?.get("author")?;
    let name = author.get("name")?.as_str()?;
    let email = author.get("email")?.as_str()?;

    if name.is_empty() || email.is_empty() {
        return None;
    }
    Some(format!("{name} <{email}>"))
}

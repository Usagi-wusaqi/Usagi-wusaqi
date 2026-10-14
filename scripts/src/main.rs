//! generate-stats 入口：CLI 解析、仓库并发处理、产物生成

mod cache;
mod commits;
mod config;
mod github;
mod render;
mod util;

use std::collections::{HashSet, VecDeque};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use cache::{aggregate_stats_from_cache, cleanup_stale_cache_files};
use commits::{analyze_commits, repo_owner_from_url, RepoContext};
use config::{
    get_default_from_readme, load_author_identities, project_root, save_author_identities, App,
};
use github::{get_repos, get_upstream_repo, learn_identities, probe_user_commits, RepoInfo};
use render::{generate_contributions_svg, save_contributions_svg, update_readme};
use util::{format_number, print_color, print_separator, run_command, Log, GREEN, NC, RED, YELLOW};

/// 并发处理的仓库数（GitHub 侧为网络等待型任务，固定并发度即可）
const CONCURRENCY: usize = 6;

/// 待处理仓库（Phase A 已缓冲好日志，Phase B 并发消费）
struct Job {
    head: Log,
    repo_path: PathBuf,
    owner: String,
    repo_name: String,
    clone_url: String,
}

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    let mut clear_cache = false;
    let mut mode = "actions".to_string();

    let args: Vec<String> = env::args().skip(1).collect();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--clear-cache" => clear_cache = true,
            "--mode" => {
                index += 1;
                match args.get(index).map(String::as_str) {
                    Some("actions") => mode = "actions".to_string(),
                    Some("api") => mode = "api".to_string(),
                    _ => {
                        print_color("❌ 参数 --mode 需要 actions 或 api", RED);
                        return 2;
                    }
                }
            }
            "--help" | "-h" => {
                print_help();
                return 0;
            }
            other => {
                print_color(&format!("❌ 未知参数: {other}"), RED);
                print_help();
                return 2;
            }
        }
        index += 1;
    }

    let root = project_root();
    let readme_path = root.join("README.md");
    let origin_username = env::var("ORIGIN_USERNAME")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| get_default_from_readme(&readme_path, "ORIGIN_USERNAME"))
        .unwrap_or_default();
    let upstream_username = env::var("UPSTREAM_USERNAME")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| get_default_from_readme(&readme_path, "UPSTREAM_USERNAME"))
        .unwrap_or_default();
    let token = env::var("GH_TOKEN").unwrap_or_default();

    let app = App::new(origin_username, upstream_username, token);
    let separator_length = app.rc.separator_length;

    print_separator(Some("🚀 开始生成 GitHub 统计..."), GREEN, separator_length);
    print_color("📊 统计配置:", YELLOW);
    print_color(&format!("   - 运行模式: {mode}"), NC);
    print_color(&format!("   - 缓存目录: {}", app.cache_dir.display()), NC);
    print_separator(None, GREEN, separator_length);

    if clear_cache {
        if app.cache_dir.exists() {
            print_color(
                &format!("🗑️  清除缓存目录: {}", app.cache_dir.display()),
                YELLOW,
            );
            let _ = fs::remove_dir_all(&app.cache_dir);
            print_color("✅ 缓存已清除", GREEN);
        } else {
            print_color(
                &format!("ℹ️  缓存目录不存在: {}", app.cache_dir.display()),
                NC,
            );
        }
        return 0;
    }

    if app.token.is_empty() {
        print_color("❌ 错误: GH_TOKEN 环境变量未设置", RED);
        return 1;
    }

    // 加载已知作者身份（后续处理仓库时会增量学习新身份）
    let identities = load_author_identities(&app);
    app.merge_identities(&identities);

    let repos = match get_repos(&app) {
        Ok(repos) => repos,
        Err(message) => {
            print_color(&format!("❌ {message}"), RED);
            return 1;
        }
    };
    if repos.is_empty() {
        print_color("⚠️  没有找到仓库", YELLOW);
        return 1;
    }

    let any_changed = process_repos(&app, &repos);

    // 新身份统一在末尾串行写回 config.toml，避免并发写
    if app.identities_changed.load(Ordering::Relaxed) {
        save_author_identities(&app);
    }

    if let Some(message) = app.take_rate_limit() {
        print_color(&format!("❌ {message}"), RED);
        return 1;
    }

    if !any_changed {
        print_separator(Some("✅ 脚本执行完成（无变更）"), GREEN, separator_length);
        return 0;
    }

    // 从所有缓存文件的 _metadata 汇总统计
    let stats = aggregate_stats_from_cache(&app);
    let net = stats.total_additions - stats.total_deletions;
    let net_sign = if net >= 0 { "+" } else { "" };
    print_separator(
        Some("📈 汇总统计（来自缓存文件 _metadata）"),
        GREEN,
        separator_length,
    );
    print_color(
        &format!(
            "  ✍️  +{} / -{} (net {net_sign}{})",
            format_number(stats.total_additions),
            format_number(stats.total_deletions),
            format_number(net)
        ),
        GREEN,
    );
    print_color(
        &format!("  🖼️  总 images: {}", format_number(stats.total_images)),
        GREEN,
    );
    print_separator(None, GREEN, separator_length);

    // Actions 模式：生成并保存 SVG 卡片
    if mode == "actions" {
        let svg_content = generate_contributions_svg(&app, &stats, &app.origin_username);
        if !save_contributions_svg(&app, &svg_content) {
            return 1;
        }
    }

    if !update_readme(&app, &stats, &mode) {
        return 1;
    }

    print_separator(Some("✅ 脚本执行完成！"), GREEN, separator_length);
    0
}

fn print_help() {
    println!("用法: generate-stats [选项]");
    println!();
    println!("选项:");
    println!("  --clear-cache         清除缓存文件");
    println!("  --mode <actions|api>  运行模式: actions=生成本地SVG+更新README, api=仅更新README (默认: actions)");
    println!("  -h, --help            显示此帮助信息");
}

// ============================================================================
// 仓库处理
// ============================================================================

/// 处理所有仓库：预筛 → 克隆 → 分析 → 保存缓存，返回是否有缓存变更
fn process_repos(app: &App, repos: &[RepoInfo]) -> bool {
    print_separator(Some("开始处理仓库..."), GREEN, app.rc.separator_length);

    let temp_dir = env::current_dir().unwrap_or_default().join("temp_repos");
    let _ = fs::create_dir_all(&temp_dir);

    let mut active_repo_names: HashSet<String> = HashSet::new();
    let mut processed_targets: HashSet<String> = HashSet::new();
    let mut jobs: VecDeque<Job> = VecDeque::new();

    // Phase A（串行）：解析上游、探测提交、缓冲日志 —— 每次探测只 1 个 API 请求
    for repo in repos {
        let (Some(repo_name), Some(repo_url)) = (repo.name.as_deref(), repo.html_url.as_deref())
        else {
            continue;
        };
        let is_fork = repo.fork;

        let mut log = Log::default();
        log.separator(
            &format!("📦 仓库: {repo_name}"),
            YELLOW,
            app.rc.separator_length,
        );
        log.color(&format!("  URL: {repo_url}"), NC);
        log.color(
            &format!(
                "  类型: {}",
                if is_fork {
                    "Fork 仓库"
                } else {
                    "原创仓库"
                }
            ),
            NC,
        );

        // 确定要克隆的仓库（Fork 仓库直接克隆上游）
        let (upstream_owner, upstream_name) = get_upstream_repo(app, repo);
        let (clone_owner, target_repo_name, clone_url) = match (upstream_owner, upstream_name) {
            (Some(owner), Some(name)) => {
                log.color(&format!("  📡 直接克隆上游仓库: {owner}/{name}"), NC);
                let url = format!("https://{}@github.com/{owner}/{name}.git", app.token);
                (owner, name, url)
            }
            _ => {
                let owner =
                    repo_owner_from_url(repo_url).unwrap_or_else(|| app.origin_username.clone());
                let url = repo_url.replace(
                    "https://github.com/",
                    &format!("https://{}@github.com/", app.token),
                );
                (owner, repo_name.to_string(), url)
            }
        };

        active_repo_names.insert(target_repo_name.clone());
        let target_key = format!("{clone_owner}/{target_repo_name}").to_lowercase();
        if !processed_targets.insert(target_key) {
            log.color(
                &format!("  ℹ️  已处理同一目标仓库，跳过重复项: {clone_owner}/{target_repo_name}"),
                NC,
            );
            log.flush();
            continue;
        }

        // 改造一：克隆前预筛，顺带学习作者身份（Zero 下载即可判定是否需要处理）
        let probe = probe_user_commits(
            app,
            &clone_owner,
            &target_repo_name,
            &app.origin_username,
            &mut log,
        );
        if let Some(items) = &probe {
            learn_identities(app, items, &mut log);
        }
        let no_user_commits = probe.is_some_and(|items| items.is_empty());
        if no_user_commits && !app.cache_file(&target_repo_name).exists() {
            log.color("  ⏭️  该仓库无用户提交，跳过克隆", NC);
            log.flush();
            continue;
        }

        jobs.push_back(Job {
            head: log,
            repo_path: temp_dir.join(&target_repo_name),
            owner: clone_owner,
            repo_name: target_repo_name,
            clone_url,
        });
    }

    // Phase B（并发）：克隆 + git log/show 分析，日志按仓库整块输出
    let any_changed = Mutex::new(false);
    if !jobs.is_empty() {
        let queue = Arc::new(Mutex::new(jobs));
        let thread_count = CONCURRENCY.min(active_repo_names.len()).max(1);

        std::thread::scope(|scope| {
            for _ in 0..thread_count {
                let queue = Arc::clone(&queue);
                let any_changed = &any_changed;
                let temp_dir = &temp_dir;
                scope.spawn(move || loop {
                    let job = queue.lock().ok().and_then(|mut queue| queue.pop_front());
                    let Some(job) = job else { break };
                    if process_job(app, job, temp_dir) {
                        if let Ok(mut changed) = any_changed.lock() {
                            *changed = true;
                        }
                    }
                });
            }
        });
    }
    let mut any_changed = any_changed.into_inner().unwrap_or(false);

    print_color("\n  🧹 清理临时文件...", YELLOW);
    if temp_dir.exists() {
        if let Err(err) = fs::remove_dir_all(&temp_dir) {
            print_color(&format!("  ⚠️  清理临时目录失败: {err}"), YELLOW);
        }
    }

    if !active_repo_names.is_empty() && cleanup_stale_cache_files(app, &active_repo_names) {
        any_changed = true;
    }

    any_changed
}

/// 克隆（或更新）单个仓库并分析其 commits
fn process_job(app: &App, job: Job, temp_dir: &Path) -> bool {
    let mut log = job.head;
    let repo_path = job.repo_path;

    if repo_path.exists() {
        log.color("  🔄 更新本地仓库...", YELLOW);
        run_command("git", &["fetch", "origin"], Some(&repo_path));
    } else {
        log.color("  📥 克隆仓库...", YELLOW);
        let (_, code) = run_command(
            "git",
            &[
                "clone",
                "--filter=blob:none",
                "--no-checkout",
                "--single-branch",
                "--no-tags",
                &job.clone_url,
                &job.repo_name,
            ],
            Some(temp_dir),
        );
        if code != 0 || !repo_path.exists() {
            log.color("  ⚠️  克隆仓库失败，跳过", YELLOW);
            log.flush();
            return false;
        }
    }

    let ctx = RepoContext {
        repo_path: Some(repo_path),
        owner: job.owner,
        repo_name: job.repo_name,
        username: app.origin_username.clone(),
    };

    let changed = analyze_commits(app, &ctx, &mut log);
    log.flush();
    changed
}

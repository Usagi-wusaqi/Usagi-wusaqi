#!/usr/bin/env python3
"""GitHub Contributions Statistics Script

## 核心功能
- 统计所有仓库的贡献（additions/deletions、images数量）
- 智能缓存系统，避免重复分析已处理的 commits
- 支持 Fork 仓库（自动分析上游仓库）
- 自动更新 README.md 统计数据和时间

## 数据源
- 本地 git log：完整历史数据
- GitHub API：最新数据（最多 1000 个 commits）
- 智能合并：取两者优势，确保数据完整性

## 缓存机制
每个仓库一个 JSON 文件，包含：
- 元数据：总 commits 数、总 additions/deletions 数、总 images 数
- 详细数据：每个 commit 的统计数据

## 更新策略
- 只有运行脚本时才更新数据
- 使用正则匹配替换，保持 README.md 原有格式
- 永久保存历史数据，智能清理过期缓存
"""

import os
import subprocess
import json
import re
import shutil
import argparse
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import Optional, Tuple, List, Dict, cast

# ============================================================================
# 类型定义
# ============================================================================

FileData = Dict[str, str | int]
AuthorData = Dict[str, str]
CommitDetailData = Dict[str, AuthorData]
CommitData = Dict[str, str | int | FileData | CommitDetailData | List[FileData]]
CacheData = Dict[str, List[CommitData]]
RepoInfo = Dict[str, str | bool | Dict[str, str] | None]
StatsData = Dict[str, int]

# ============================================================================
# 常量定义
# ============================================================================

GITHUB_API = "https://api.github.com"
SEPARATOR_LENGTH = 60
MAX_API_PAGES = 10
PER_PAGE = 100
PROGRESS_INTERVAL = 10
IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.ico']
README_FILE_PATH = Path(__file__).parent.parent / "README.md"
CACHE_DIR = Path(__file__).parent / "stats_cache"

# 时间和格式常量
TIME_FORMAT = "%Y-%m-%d %H:%M:%S UTC+8"
TIME_PATTERN = r'(Last updated: )\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}( UTC\+8)?'
STATS_PATTERN = r'(➕additions: )\d+( ➖deletions: )\d+( 🖼️images: )\d+'

# 占位符映射
PLACEHOLDER_MAPPINGS = {
    'ORIGIN_USERNAME': 'ORIGIN_USERNAME',
    'UPSTREAM_USERNAME': 'UPSTREAM_USERNAME',
    'TOTAL_ADDITIONS': 'total_additions',
    'TOTAL_DELETIONS': 'total_deletions',
    'TOTAL_IMAGES': 'total_images',
    'LAST_UPDATED': 'current_time'
}


# ============================================================================
# 辅助函数
# ============================================================================

def get_default_from_readme(var_name: str) -> Optional[str]:
    """从 README.md 中读取默认的用户名变量"""
    if not README_FILE_PATH.exists():
        return None

    try:
        with open(README_FILE_PATH, 'r', encoding='utf-8') as f:
            content = f.read()

        # 查找变量定义
        pattern = rf'{var_name} = ([^\n\r]+)'
        match = re.search(pattern, content)
        if match:
            return match.group(1).strip()
    except Exception:
        pass

    return None


# ============================================================================
# 配置
# ============================================================================

ORIGIN_USERNAME = (
    os.environ.get("ORIGIN_USERNAME") or
    get_default_from_readme("ORIGIN_USERNAME") or
    ""
)
UPSTREAM_USERNAME = (
    os.environ.get("UPSTREAM_USERNAME") or
    get_default_from_readme("UPSTREAM_USERNAME") or
    ""
)
TOKEN = os.environ.get("GH_TOKEN")


# ============================================================================
# 工具函数
# ============================================================================

class Colors:
    """终端颜色定义"""
    RED = '\033[0;31m'
    GREEN = '\033[0;32m'
    YELLOW = '\033[1;33m'
    NC = '\033[0m'

def print_color(message: str, color: str = Colors.NC) -> None:
    """彩色输出"""
    print(f"{color}{message}{Colors.NC}")

def print_separator(title: str | None = None, color: str = Colors.GREEN) -> None:
    """打印分隔线，可选标题"""
    separator = "=" * SEPARATOR_LENGTH
    print_color(separator, color)
    if title:
        print_color(title, color)
        print_color(separator, color)

def handle_error(operation: str, error: Exception, return_value: str | None = None) -> str | None:
    """统一的错误处理"""
    print_color(f"❌ {operation}失败: {error}", Colors.RED)
    return return_value


def is_image_file(filename: str) -> bool:
    """检查文件是否为图片"""
    return any(filename.lower().endswith(ext) for ext in IMAGE_EXTENSIONS)


def print_stats_summary(additions: int, deletions: int, images: int, include_images: bool = True, prefix: str = "") -> None:
    """打印统计摘要"""
    print_color(f"{prefix}✅ 代码贡献: +{additions} additions, -{deletions} deletions", Colors.GREEN)
    if include_images:
        print_color(f"{prefix}✅ 图片贡献: {images} images", Colors.GREEN)

def run_command(cmd: str, cwd: Optional[str] = None) -> Tuple[str, int]:
    """运行命令并返回输出"""
    try:
        result = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            cwd=cwd
        )
        return result.stdout.strip(), result.returncode
    except Exception as e:
        print_color(f"❌ 命令执行失败: {e}", Colors.RED)
        return "", 1

def replace_placeholders(content: str, replacements: Dict[str, str]) -> str:
    """通用占位符替换函数"""
    for placeholder, value in replacements.items():
        content = content.replace(f'{{{{{placeholder}}}}}', str(value))
    return content

def update_variable_definition(content: str, var_name: str, var_value: str) -> str:
    """通用变量定义更新函数"""
    pattern = rf'({var_name} = )([^\n\r]+)'
    if re.search(pattern, content):
        content = re.sub(pattern, f'\\1{var_value}', content)
        print_color(f"✅ 已更新 {var_name} 定义为: {var_value}", Colors.GREEN)
    return content

def get_current_time() -> str:
    """获取当前时间字符串"""
    china_tz = timezone(timedelta(hours=8))
    return datetime.now(china_tz).strftime(TIME_FORMAT)

def calculate_cache_statistics(cache_data: CacheData) -> Tuple[int, int, int, int]:
    """计算缓存数据的统计信息

    返回: (total_commits, total_additions, total_deletions, total_images)
    """
    total_commits = 0
    total_additions = 0
    total_deletions = 0
    total_images = 0

    for _, commits in cache_data.items():
        commits_list: List[CommitData] = commits
        # 新格式：数组结构
        total_commits += len(commits_list)
        for commit in commits_list:
            commit_dict = cast(Dict[str, str | int], commit)
            additions = commit_dict.get('additions', 0)
            deletions = commit_dict.get('deletions', 0)
            images = commit_dict.get('images', 0)
            total_additions += additions if isinstance(additions, int) else 0
            total_deletions += deletions if isinstance(deletions, int) else 0
            total_images += images if isinstance(images, int) else 0

    return total_commits, total_additions, total_deletions, total_images


def sort_and_reindex_commits(cache_data: CacheData) -> CacheData:
    """对缓存数据进行排序和重新编号"""
    sorted_cache_data: CacheData = {}

    for repo_name, commits in cache_data.items():
        # 按 timestamp 从旧到新排序（老的在前，新的在后）
        sorted_commits: List[CommitData] = sorted(commits, key=lambda x: str(x.get('timestamp', '')))

        # 重新编号 index（从 1 开始）
        for idx, commit in enumerate(sorted_commits, start=1):
            commit['index'] = idx

        sorted_cache_data[repo_name] = sorted_commits

    return sorted_cache_data

# ============================================================================
# 缓存管理
# ============================================================================

def load_cache(repo_name: str) -> CacheData:
    """加载指定仓库的缓存数据"""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"{repo_name}.json"

    try:
        with open(cache_file, 'r', encoding='utf-8') as f:
            cache_data = json.load(f)
            print_color(f"💾 已加载缓存: {cache_file}", Colors.GREEN)

            metadata = cache_data.get('_metadata', {})
            print_color(f"   缓存包含 {metadata.get('total_commits', 0)} 个commits", Colors.NC)
            return cache_data.get('data', {})
    except (json.JSONDecodeError, IOError) as e:
        print_color(f"⚠️  加载缓存失败: {e}", Colors.YELLOW)
        return {}


def save_cache(repo_name: str, cache_data: CacheData) -> bool:
    """保存指定仓库的缓存数据

    功能：
    - 按时间戳排序 commits（从旧到新）
    - 重新编号 commit index（从 1 开始）
    - 统计总 commits 数、总增删行数和总图片数
    - 保存为带 metadata 的 JSON 格式

    参数：
    - repo_name: 仓库名称
    - cache_data: 缓存数据字典

    JSON 输出格式：
    {
      "_metadata": {
        "total_commits": int,    // 总 commit 数
        "total_additions": int,  // 总增加行数
        "total_deletions": int,  // 总删除行数
        "total_images": int      // 总图片数
      },
      "data": { ... }            // commit 数据
    }
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"{repo_name}.json"

    try:
        # 排序和重新编号
        sorted_cache_data = sort_and_reindex_commits(cache_data)

        # 计算统计信息
        total_commits, total_additions, total_deletions, total_images = calculate_cache_statistics(sorted_cache_data)

        cache_data_with_metadata: Dict[str, Dict[str, int] | CacheData] = {
            '_metadata': {
                'total_commits': total_commits,
                'total_additions': total_additions,
                'total_deletions': total_deletions,
                'total_images': total_images
            },
            'data': sorted_cache_data
        }

        with open(cache_file, 'w', encoding='utf-8') as f:
            json.dump(cache_data_with_metadata, f, indent=2, ensure_ascii=False)

        print_color(f"✅ 缓存已保存: {cache_file}", Colors.GREEN)
        print_color(f"   commits: {total_commits}", Colors.NC)
        print_color(f"   additions: {total_additions}", Colors.NC)
        print_color(f"   deletions: {total_deletions}", Colors.NC)
        print_color(f"   images: {total_images}", Colors.NC)
        return True
    except Exception as e:
        print_color(f"❌ 保存缓存失败: {e}", Colors.RED)
        return False


def extract_sha_from_cache_item(item: str | CommitData, is_list_format: bool) -> str:
    """从缓存项中提取SHA值"""
    if is_list_format:
        if isinstance(item, dict):
            url = item.get('url', '')
            if isinstance(url, str):
                return url.split('/')[-1] if url else ''
        return ''
    else:
        return item if isinstance(item, str) else ''


def should_preserve_commit(cached_commit_time: str, oldest_current_time: Optional[str]) -> bool:
    """判断是否应该保留commit（永久历史数据）"""
    if not oldest_current_time or not cached_commit_time:
        return False
    return cached_commit_time < oldest_current_time


def clean_stale_cache(cache_data: CacheData, current_commits_with_data: List[CommitData], repo_key: str) -> CacheData:
    """清理过期的缓存（检测变基等导致的commit哈希变化）

    策略：
    1. 只清除在当前合并数据中消失的 commits（可能被变基、压缩或重写）
    2. 永久保存比当前最老 commit 还要久远的缓存数据（查不到的历史）
    3. 更新新的 commits 到缓存

    参数：
    - current_commits_with_data: 当前合并后的完整 commit 对象列表（包含时间戳）
    """
    if repo_key not in cache_data:
        return cache_data

    # 获取当前数据的 sha 集合和最老的时间戳
    current_commit_set: set[str] = set()
    oldest_current_time: str | None = None

    for commit in current_commits_with_data:
        sha = commit.get('sha')
        if isinstance(sha, str):
            current_commit_set.add(sha)

        # 获取 commit 时间戳
        commit_dict = commit.get('commit', {})
        if isinstance(commit_dict, dict):
            author_dict = commit_dict.get('author', {})
            if isinstance(author_dict, dict):
                commit_time = author_dict.get('date', '')
                if oldest_current_time is None or commit_time < oldest_current_time:
                    oldest_current_time = commit_time

    # 获取缓存中的SHA集合
    cached_shas: set[str] = set()

    # 新格式：数组结构
    for item in cache_data[repo_key]:
        sha = extract_sha_from_cache_item(item, True)
        if sha:
            cached_shas.add(sha)

    # 找出在当前合并数据中消失的 commits
    stale_commits: set[str] = cached_shas - current_commit_set

    if stale_commits:
        print_color(f"    🧹 检测到 {len(stale_commits)} 个消失的commits", Colors.YELLOW)
        print_color(f"       原因：可能被变基、压缩或重写", Colors.YELLOW)

        deleted_count = 0
        preserved_count = 0

        # 新格式：过滤数组
        new_cache_list: List[CommitData] = []
        for item in cache_data[repo_key]:
            sha = extract_sha_from_cache_item(item, True)
            cached_commit_time = item.get('timestamp', '')
            if not isinstance(cached_commit_time, str):
                cached_commit_time = str(cached_commit_time)

            # 判断是否应该删除
            if sha in stale_commits:
                if should_preserve_commit(cached_commit_time, oldest_current_time):
                    # 保留永久历史数据
                    new_cache_list.append(item)
                    preserved_count += 1
                else:
                    # 删除在当前数据范围内消失的 commits
                    deleted_count += 1
            else:
                new_cache_list.append(item)

        cache_data[repo_key] = new_cache_list

        print_color(f"    ✅ 已清除 {deleted_count} 个过期的commit缓存及其统计数据", Colors.GREEN)
        if preserved_count > 0:
            print_color(f"    ℹ️  保留 {preserved_count} 个永久历史数据（比当前最老数据更久远）", Colors.NC)

        # 检查缓存是否为空并清理
        if not cache_data[repo_key]:
            del cache_data[repo_key]
            print_color(f"    ℹ️  仓库缓存已清空", Colors.NC)
    else:
        print_color(f"    ✅ 缓存数据完整，无消失的commits", Colors.GREEN)

    return cache_data


# ============================================================================
# GitHub API 操作
# ============================================================================

def get_repos() -> List[RepoInfo]:
    """获取用户的所有仓库（包括公开和私有仓库）"""
    print_color("📡 获取所有仓库列表...", Colors.YELLOW)

    # 使用 curl 获取仓库列表
    curl_cmd = f'curl -s -H "Authorization: token {TOKEN}" -H "Accept: application/vnd.github.v3+json" "{GITHUB_API}/users/{ORIGIN_USERNAME}/repos?per_page={PER_PAGE}&type=all"'
    output, returncode = run_command(curl_cmd)

    if returncode != 0:
        print_color("❌ 获取仓库列表失败", Colors.RED)
        return []

    # 解析 JSON
    try:
        parsed_data: List[Dict[str, str | bool | Dict[str, str] | None]] = json.loads(output)

        repos: List[RepoInfo] = []
        for repo in parsed_data:
            repo_info: RepoInfo = repo
            repos.append(repo_info)

        print_color(f"✅ 获取到 {len(repos)} 个仓库", Colors.GREEN)
        for repo in repos:
            repo_name = repo.get('name', 'Unknown')
            is_fork = repo.get('fork', False)
            print_color(f"   - {repo_name} ({'Fork' if is_fork else '原创'})", Colors.NC)
        return repos
    except json.JSONDecodeError as e:
        print_color(f"❌ JSON 解析失败: {e}", Colors.RED)
        print_color(f"数据内容: {output[:500]}", Colors.RED)
        return []


def get_upstream_repo(repo: RepoInfo) -> Tuple[Optional[str], Optional[str]]:
    """获取 fork 仓库的上游仓库信息"""
    is_fork = repo.get('fork')
    if not isinstance(is_fork, bool) or not is_fork:
        return None, None

    upstream_info = repo.get('source') or repo.get('parent')
    if isinstance(upstream_info, dict):
        upstream_dict: Dict[str, str | Dict[str, str]] = cast(Dict[str, str | Dict[str, str]], upstream_info)
        owner_dict = upstream_dict.get('owner')
        if isinstance(owner_dict, dict):
            upstream_owner = owner_dict.get('login')
            upstream_name = upstream_dict.get('name')
            if isinstance(upstream_owner, str) and isinstance(upstream_name, str):
                return upstream_owner, upstream_name
    return None, None


# ============================================================================
# Commits 数据获取
# ============================================================================

def get_commits_from_git_log(repo_path: str, username: str, default_branch: str) -> Optional[List[CommitData]]:
    """从本地 git log 获取用户的所有 commits（完整历史）"""
    git_cmd = f'git log origin/{default_branch} --author="{username}" --format="%H"'
    output, returncode = run_command(git_cmd, cwd=repo_path)

    if returncode == 0:
        commit_hashes = [h.strip() for h in output.split('\n') if h.strip()]
        all_commits: List[CommitData] = [{'sha': h} for h in commit_hashes]
        print_color(f"    ℹ️  git log 获取 {len(all_commits)} 个commits", Colors.NC)
        return all_commits
    else:
        print_color(f"    ⚠️  git log 失败", Colors.YELLOW)
        return None


def get_commits_from_api(owner: str, repo_name: str, username: str, default_branch: str = 'main', max_pages: int = MAX_API_PAGES) -> List[CommitData]:
    """从 GitHub API 获取用户的最近 commits（分页，最多 10 页）

    只获取默认分支的 commits，避免统计未合并 PR 的 commits
    很久以前的 commits 从缓存读取
    """
    page = 1
    per_page = PER_PAGE
    all_commits: List[CommitData] = []

    while page <= max_pages:
        api_url = f"{GITHUB_API}/repos/{owner}/{repo_name}/commits?author={username}&sha={default_branch}&per_page={per_page}&page={page}"
        print_color(f"    🔍 获取commits (第{page}页)...", Colors.NC)

        curl_cmd = f'curl -s -H "Authorization: token {TOKEN}" -H "Accept: application/vnd.github.v3+json" "{api_url}"'
        output, returncode = run_command(curl_cmd)

        if returncode != 0:
            print_color("    ❌ API调用失败", Colors.RED)
            return all_commits if all_commits else []

        try:
            parsed_commits: List[Dict[str, str | int | FileData | CommitDetailData | List[FileData]]] = json.loads(output)
            if not parsed_commits:
                break

            for commit in parsed_commits:
                commit_data: CommitData = commit
                all_commits.append(commit_data)

            print_color(f"    📊 已获取 {len(all_commits)} 个commits", Colors.NC)

            if len(parsed_commits) < per_page:
                break

            page += 1

        except json.JSONDecodeError as e:
            print_color(f"    ❌ JSON 解析失败: {e}", Colors.RED)
            return all_commits if all_commits else []

    if page > max_pages:
        print_color(f"    ℹ️  已达到最大页数限制 ({max_pages} 页)，共 {len(all_commits)} 个commits", Colors.NC)
        print_color(f"    ℹ️  更久以前的 commits 将从缓存读取", Colors.NC)

    return all_commits


def merge_commits(git_commits: Optional[List[CommitData]], api_commits: Optional[List[CommitData]]) -> List[CommitData]:
    """合并 git log 和 API 的 commits 数据

    策略（数据相交）：
    1. 同时使用 git log（完整历史）和 API（最近 10 页）的数据
    2. 对于相同的 commits：比较时间戳，谁的数据更新就用谁的
    3. 对于不同的 commits：保留各自的数据
    4. 结果：git log 的老数据 + API 的新数据 + 最新的更新

    这样可以处理：
    - git log 没更新的情况（用 API 的新数据）
    - API 限流或没更新的情况（用 git log 的数据）
    - 两个数据源都有各自独特的数据（都保留）
    """
    git_count = len(git_commits) if git_commits else 0
    api_count = len(api_commits) if api_commits else 0

    print_color(f"    📊 合并数据源:", Colors.YELLOW)
    print_color(f"       - git log: {git_count} 个commits（完整历史）", Colors.NC)
    print_color(f"       - API: {api_count} 个commits（最多 10 页）", Colors.NC)

    if not git_commits and not api_commits:
        print_color(f"    ❌ 两个数据源都无数据", Colors.RED)
        return []

    if not git_commits:
        print_color(f"    ✅ 仅使用 API 数据", Colors.GREEN)
        return api_commits or []

    if not api_commits:
        print_color(f"    ✅ 仅使用 git log 数据", Colors.GREEN)
        return git_commits or []

    # 构建 commit 映射（sha -> commit 对象）
    git_map: Dict[str, CommitData] = {str(c.get('sha')): c for c in git_commits if c.get('sha')}
    api_map: Dict[str, CommitData] = {str(c.get('sha')): c for c in api_commits if c.get('sha')}

    # 找出相同和不同的 commits
    git_shas = set(git_map.keys())
    api_shas = set(api_map.keys())
    common_shas = git_shas & api_shas
    git_only_shas = git_shas - api_shas
    api_only_shas = api_shas - git_shas

    print_color(f"    📊 数据分析:", Colors.YELLOW)
    print_color(f"       - 相同 commits: {len(common_shas)}", Colors.NC)
    print_color(f"       - 仅在 git log: {len(git_only_shas)}", Colors.NC)
    print_color(f"       - 仅在 API: {len(api_only_shas)}", Colors.NC)

    # 合并结果
    merged: Dict[str, CommitData] = {}

    #1. 处理相同的 commits：比较时间戳，谁的新用谁的
    for sha in common_shas:
        git_commit = git_map[sha]
        api_commit = api_map[sha]

        git_commit_dict = git_commit.get('commit', {})
        api_commit_dict = api_commit.get('commit', {})
        if isinstance(git_commit_dict, dict) and isinstance(api_commit_dict, dict):
            git_author_dict = git_commit_dict.get('author', {})
            api_author_dict = api_commit_dict.get('author', {})
            if isinstance(git_author_dict, dict) and isinstance(api_author_dict, dict):
                git_time = git_author_dict.get('date', '')
                api_time = api_author_dict.get('date', '')
                if api_time > git_time:
                    # API 数据更新
                    merged[sha] = api_commit
                else:
                    # git log 数据更新或相同
                    merged[sha] = git_commit
            else:
                # Fallback: prefer API commit if author dict check fails
                merged[sha] = api_commit
        else:
            # Fallback: prefer API commit if commit dict check fails
            merged[sha] = api_commit

    # 2. 保留 git log 独有的 commits（老数据）
    for sha in git_only_shas:
        merged[sha] = git_map[sha]

    # 3. 保留 API 独有的 commits（新数据）
    for sha in api_only_shas:
        merged[sha] = api_map[sha]

    result: List[CommitData] = list(merged.values())
    print_color(f"    ✅ 合并完成，共 {len(result)} 个commits", Colors.GREEN)
    return result


# ============================================================================
# Commits 分析
# ============================================================================

def analyze_commits(repo_path: str, owner: str, repo_name: str, username: str, include_images: bool = True) -> Tuple[int, int, int]:
    """同时分析代码行数和图片贡献

    返回: (additions, deletions, total_images)
    """
    print_color(f"    📊 开始分析commits...", Colors.YELLOW)

    # 加载缓存
    cache_data = load_cache(repo_name)

    # 获取 commits（同时尝试 git log 和 API，选择最新的）
    git_commits = None
    api_commits = None
    default_branch = 'main'

    # 1. 尝试从本地 git log 获取
    if repo_path:
        git_cmd = 'git symbolic-ref refs/remotes/origin/HEAD | sed "s@^refs/remotes/origin/@@"'
        output, returncode = run_command(git_cmd, cwd=repo_path)
        default_branch = output.strip() if returncode == 0 else 'main'

        print_color(f"    ℹ️  默认分支: {default_branch}", Colors.NC)
        git_commits = get_commits_from_git_log(repo_path, username, default_branch)

    # 2. 尝试从 API 获取
    api_commits = get_commits_from_api(owner, repo_name, username, default_branch)

    # 3. 合并两个数据源（数据相交策略）
    all_commits = merge_commits(git_commits, api_commits)

    if not all_commits:
        print_color(f"    ℹ️  未找到commits", Colors.NC)
        return 0, 0, 0

    total_commits = len(all_commits)
    print_color(f"    📊 最终使用 {total_commits} 个commits", Colors.NC)

    # 清理过期缓存（传入完整的 commit 对象以获取时间戳）
    cache_data = clean_stale_cache(cache_data, all_commits, repo_name)

    # 统计数据
    total_additions = 0
    total_deletions = 0
    total_images = 0
    processed = 0
    cache_hits = 0
    cache_misses = 0

    for commit in all_commits:
        sha = commit.get('sha')
        if not sha:
            continue

        processed += 1
        if processed % PROGRESS_INTERVAL == 0:
            print_color(f"    📊 处理中: {processed}/{total_commits} ({processed*100//total_commits}%)", Colors.NC)

        # 检查缓存
        commit_url = f"https://github.com/{owner}/{repo_name}/commit/{sha}"
        cached_data = None
        if repo_name in cache_data:
            # 新格式：数组结构
            for item in cache_data[repo_name]:
                if item.get('url') == commit_url:
                    cached_data = item
                    break

        if cached_data:
            cached_additions = cached_data.get('additions', 0)
            cached_deletions = cached_data.get('deletions', 0)
            cached_images = cached_data.get('images', 0)
            if isinstance(cached_additions, int):
                total_additions += cached_additions
            if isinstance(cached_deletions, int):
                total_deletions += cached_deletions
            if isinstance(cached_images, int):
                total_images += cached_images
            cache_hits += 1
            continue

        cache_misses += 1
        commit_data: CommitData = {}

        # 获取 commit 详情
        if repo_path:
            # 本地仓库用 git show
            # 先获取文件状态（A=added, M=modified, D=deleted 等）
            git_cmd = f'git show --name-status --pretty="" {sha}'
            status_output, returncode = run_command(git_cmd, cwd=repo_path)

            # 再获取文件的行数统计
            git_cmd = f'git show --numstat --pretty="" {sha}'
            numstat_output, returncode = run_command(git_cmd, cwd=repo_path)

            if returncode == 0:
                commit_data['files'] = []

                # 构建状态映射
                status_map: Dict[str, str] = {}
                for line in status_output.split('\n'):
                    if line.strip():
                        parts = line.split('\t')
                        if len(parts) >= 2:
                            status = parts[0]  # A, M, D 等
                            filename = parts[1]
                            status_map[filename] = status

                # 处理行数统计
                for line in numstat_output.split('\n'):
                    if line.strip():
                        parts = line.split('\t')
                        if len(parts) >= 3:
                            try:
                                add_count = int(parts[0]) if parts[0] != '-' else 0
                                del_count = int(parts[1]) if parts[1] != '-' else 0
                                filename = parts[2]

                                # 从状态映射中获取真实的状态
                                file_status = status_map.get(filename, 'modified')

                                commit_data['files'].append({
                                    'additions': add_count,
                                    'deletions': del_count,
                                    'filename': filename,
                                    'status': 'added' if file_status == 'A' else 'modified'
                                })
                            except ValueError:
                                continue
        else:
            # 远程仓库用 API
            commit_url = f"{GITHUB_API}/repos/{owner}/{repo_name}/commits/{sha}"
            curl_cmd = f'curl -s -H "Authorization: token {TOKEN}" -H "Accept: application/vnd.github.v3+json" "{commit_url}"'
            output, returncode = run_command(curl_cmd)
            if returncode == 0:
                try:
                    commit_data = json.loads(output)
                except json.JSONDecodeError:
                    continue

        # 统计 additions/deletions 和 images
        additions = 0
        deletions = 0
        images = 0

        files_list = commit_data.get('files', [])
        if isinstance(files_list, list):
            for file in files_list:
                file_data: FileData = file
                # 代码行数统计
                file_additions = file_data.get('additions', 0)
                file_deletions = file_data.get('deletions', 0)
                if isinstance(file_additions, int):
                    additions += file_additions
                if isinstance(file_deletions, int):
                    deletions += file_deletions

                # 图片统计
                if include_images:
                    file_status = file.get('status', '')
                    if file_status == 'added':
                        filename = file.get('filename', '')
                        if isinstance(filename, str) and is_image_file(filename):
                            images += 1

        total_additions += additions
        total_deletions += deletions
        total_images += images

        # 获取 commit 的时间戳（用于缓存清理时的永久历史判断）
        commit_dict = commit.get('commit', {})
        commit_timestamp: str = ''
        if isinstance(commit_dict, dict):
            author_dict = commit_dict.get('author', {})
            if isinstance(author_dict, dict):
                commit_timestamp = author_dict.get('date', '')
        if not commit_timestamp:
            commit_timestamp = datetime.now().isoformat()

        # 更新缓存（数组结构）
        if repo_name not in cache_data:
            cache_data[repo_name] = []
        cache_data[repo_name].append({
            'index': processed,  # 第几个 commit
            'url': commit_url,  # commit 链接
            'additions': additions,
            'deletions': deletions,
            'images': images,  # 只保存图片数量
            'timestamp': commit_timestamp  # 使用 commit 的时间戳，而不是当前时间
        })

    # 显示统计信息
    print_color("    💾 缓存统计:", Colors.YELLOW)
    print_color(f"       - 缓存命中: {cache_hits} 个commit", Colors.NC)
    print_color(f"       - 缓存未命中: {cache_misses} 个commit", Colors.NC)
    if total_commits > 0:
        cache_hit_rate = (cache_hits / total_commits * 100)
        print_color(f"       - 缓存命中率: {cache_hit_rate:.1f}%", Colors.NC)

    print_stats_summary(total_additions, total_deletions, total_images, include_images, "    ")

    # 保存缓存
    save_cache(repo_name, cache_data)

    return total_additions, total_deletions, total_images


# ============================================================================
# 仓库处理
# ============================================================================

def process_repos(repos: List[RepoInfo], include_images: bool = True) -> StatsData:
    """处理所有仓库

    Args:
        repos: 仓库列表
        include_images: 是否统计图片贡献
    """
    print_separator("开始处理仓库...")

    total_additions = 0
    total_deletions = 0
    total_images = 0
    temp_dir = Path.cwd() / "temp_repos"
    temp_dir.mkdir(parents=True, exist_ok=True)

    for repo in repos:
        repo_name = repo.get('name')
        repo_url = repo.get('html_url')
        is_fork = repo.get('fork', False)

        if not repo_name or not repo_url:
            continue

        print_separator(f"📦 仓库: {repo_name}", Colors.YELLOW)
        print_color("  URL: " + str(repo_url), Colors.NC)
        print_color("  类型: " + ('Fork 仓库' if is_fork else '原创仓库'), Colors.NC)

        # 克隆仓库到临时目录
        repo_path = temp_dir / str(repo_name)
        if repo_path.exists():
            print_color(f"  🔄 更新本地仓库...", Colors.YELLOW)
            # 更新默认分支
            run_command("git fetch origin", cwd=str(repo_path))
        else:
            print_color(f"  📥 克隆仓库...", Colors.YELLOW)
            clone_url = str(repo_url).replace("https://github.com/", f"https://{TOKEN}@github.com/")
            # 克隆仓库
            run_command(f"git clone {clone_url}", cwd=str(temp_dir))

        # 确定要分析的仓库（fork 仓库用上游仓库）
        owner = ORIGIN_USERNAME
        target_repo_name = str(repo_name)

        upstream_owner, upstream_name = get_upstream_repo(repo)
        if upstream_owner and upstream_name:
            owner = upstream_owner
            target_repo_name = str(upstream_name)

        # 同时分析代码行数和图片贡献
        # 注意：repo_path 用于获取 git log，owner/repo_name 用于 API
        repo_additions, repo_deletions, repo_images = analyze_commits(
            str(repo_path), owner or ORIGIN_USERNAME, target_repo_name, ORIGIN_USERNAME, include_images
        )

        total_images += repo_images

        # 显示结果
        if repo_additions == 0 and repo_deletions == 0 and repo_images == 0:
            print_color("  ⚠️  用户没有代码或图片贡献", Colors.YELLOW)
        else:
            print_stats_summary(repo_additions, repo_deletions, repo_images, include_images, "  ")

            # 累加到总计
            total_additions += repo_additions
            total_deletions += repo_deletions

    # 清理临时目录
    print_color("\n  🧹 清理临时文件...", Colors.YELLOW)
    if temp_dir.exists():
        shutil.rmtree(temp_dir)

    print_separator("📈 汇总统计")
    print_color(f"  ➕ 总 additions: {total_additions}", Colors.GREEN)
    print_color(f"  ➖ 总 deletions: {total_deletions}", Colors.GREEN)
    if include_images:
        print_color(f"  🖼️ 总 images: {total_images} images", Colors.GREEN)
    print_separator()

    return {
        'total_additions': total_additions,
        'total_deletions': total_deletions,
        'total_images': total_images
    }


# ============================================================================
# README 更新
# ============================================================================

def update_usernames_in_readme(content: str) -> str:
    """智能更新 README 中的用户名（支持双向替换）

    策略：
    - 更新 README 顶部的变量定义：ORIGIN_USERNAME = 和 UPSTREAM_USERNAME =
    - 智能识别当前状态：如果是占位符就替换为真实用户名，如果是真实用户名就保持不变
    - 支持可重复运行：每次运行都能正确处理
    """
    # 更新变量定义
    content = update_variable_definition(content, 'ORIGIN_USERNAME', ORIGIN_USERNAME)
    content = update_variable_definition(content, 'UPSTREAM_USERNAME', UPSTREAM_USERNAME)

    # 智能替换占位符
    placeholder_count = content.count('{{ORIGIN_USERNAME}}') + content.count('{{UPSTREAM_USERNAME}}')

    if placeholder_count > 0:
        # 发现占位符，进行替换
        replacements = {
            'ORIGIN_USERNAME': ORIGIN_USERNAME,
            'UPSTREAM_USERNAME': UPSTREAM_USERNAME
        }
        content = replace_placeholders(content, replacements)
        print_color(f"✅ 已替换 {placeholder_count} 个占位符为真实用户名", Colors.GREEN)
    else:
        # 没有占位符，说明已经是真实用户名了
        print_color(f"ℹ️  未发现占位符，内容已包含真实用户名", Colors.YELLOW)

    return content

def generate_readme_from_template(template_path: Path, stats: StatsData) -> str:
    """从模板生成 README 内容"""
    with open(template_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # 准备替换数据
    current_time = get_current_time()
    replacements = {
        'ORIGIN_USERNAME': ORIGIN_USERNAME,
        'UPSTREAM_USERNAME': UPSTREAM_USERNAME,
        'TOTAL_ADDITIONS': str(stats.get('total_additions', 0)),
        'TOTAL_DELETIONS': str(stats.get('total_deletions', 0)),
        'TOTAL_IMAGES': str(stats.get('total_images', 0)),
        'LAST_UPDATED': current_time
    }

    # 替换所有占位符
    content = replace_placeholders(content, replacements)
    print_color("✅ 已从模板生成完整的 README", Colors.GREEN)

    return content

def update_existing_readme(content: str, stats: StatsData) -> str:
    """更新现有 README 内容"""
    # 替换统计数字
    replacement = f'\\g<1>{stats.get("total_additions", 0)}\\g<2>{stats.get("total_deletions", 0)}\\g<3>{stats.get("total_images", 0)}'
    content = re.sub(STATS_PATTERN, replacement, content)

    # 替换更新时间
    current_time = get_current_time()
    time_replacement = f'\\g<1>{current_time}'
    content = re.sub(TIME_PATTERN, time_replacement, content)

    # 更新用户名
    content = update_usernames_in_readme(content)

    return content

def save_readme_content(content: str) -> bool:
    """保存 README 内容到文件"""
    try:
        with open(README_FILE_PATH, 'w', encoding='utf-8') as f:
            f.write(content)
        return True
    except Exception as e:
        print_color(f"❌ 保存 README 失败: {e}", Colors.RED)
        return False

def print_update_summary(stats: StatsData) -> None:
    """打印更新结果摘要"""
    current_time = get_current_time()
    print_color("✅ README.md 更新成功！", Colors.GREEN)
    print_color(f"   ➕ 增加行数: {stats.get('total_additions', 0)}", Colors.NC)
    print_color(f"   ➖ 删除行数: {stats.get('total_deletions', 0)}", Colors.NC)
    print_color(f"   🖼️ 图片数量: {stats.get('total_images', 0)}", Colors.NC)
    print_color(f"   🕒 更新时间: {current_time}", Colors.NC)
    print_color(f"   👤 当前用户名: {ORIGIN_USERNAME}", Colors.NC)
    print_color(f"   👑 上游用户名: {UPSTREAM_USERNAME}", Colors.NC)

def update_readme(stats: StatsData) -> bool:
    """更新 README.md 中的统计数据和时间（支持模板系统）

    功能：
    - 如果存在 README.template.md，从模板生成完整的 README
    - 如果不存在模板，使用正则表达式更新现有 README
    - 支持可重复运行，完美解决占位符替换问题

    参数：
    - stats: 统计数据字典，包含 total_additions, total_deletions, total_images
    """
    print_color("📝 更新 README.md...", Colors.YELLOW)

    template_path = Path(__file__).parent.parent / "README.template.md"

    if template_path.exists():
        # 使用模板系统
        print_color("📄 使用模板系统生成 README", Colors.GREEN)
        content = generate_readme_from_template(template_path, stats)
    else:
        # 使用传统方式更新现有 README
        print_color("⚠️  未发现模板文件，更新现有 README", Colors.YELLOW)

        if not README_FILE_PATH.exists():
            print_color("❌ README.md 不存在！", Colors.RED)
            return False

        # 读取现有 README.md
        with open(README_FILE_PATH, 'r', encoding='utf-8') as f:
            existing_content = f.read()

        content = update_existing_readme(existing_content, stats)

    # 保存 README.md
    if not save_readme_content(content):
        return False

    # 显示更新结果
    print_update_summary(stats)
    return True


# ============================================================================
# 主函数
# ============================================================================

def main() -> int:
    """主函数"""
    parser = argparse.ArgumentParser(description='生成 GitHub 统计')
    parser.add_argument('--no-images', action='store_true', help='不统计图片贡献')
    parser.add_argument('--clear-cache', action='store_true', help='清除缓存文件')
    args = parser.parse_args()

    print_separator("🚀 开始生成 GitHub 统计...")
    print_color("📊 统计配置:", Colors.YELLOW)
    print_color(f"   - 图片统计: {'关闭' if args.no_images else '开启'}", Colors.NC)
    if not args.no_images:
        print_color(f"   - 缓存目录: {CACHE_DIR}", Colors.NC)
    print_separator()

    # 处理清除缓存
    if args.clear_cache:
        if CACHE_DIR.exists():
            print_color(f"🗑️  清除缓存目录: {CACHE_DIR}", Colors.YELLOW)
            shutil.rmtree(CACHE_DIR)
            print_color("✅ 缓存已清除", Colors.GREEN)
        else:
            print_color("ℹ️  缓存目录不存在: " + str(CACHE_DIR), Colors.NC)
        return 0

    # 检查 TOKEN
    if not TOKEN:
        print_color("❌ 错误: GH_TOKEN 环境变量未设置", Colors.RED)
        return 1

    # 获取仓库列表
    repos = get_repos()
    if not repos:
        print_color("⚠️  没有找到仓库", Colors.YELLOW)
        return 1

    # 处理仓库
    stats = process_repos(repos, include_images=not args.no_images)

    # 更新 README.md
    update_readme(stats)

    print_separator("✅ 脚本执行完成！")
    return 0


if __name__ == "__main__":
    exit(main())

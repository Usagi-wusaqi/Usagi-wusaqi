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

# ============================================================================
# 配置
# ============================================================================

GITHUB_API = "https://api.github.com"
USERNAME = os.environ.get("USERNAME", "Usagi-wusaqi")
TOKEN = os.environ.get("GH_TOKEN")
CACHE_DIR = Path(__file__).parent / "stats_cache"


# ============================================================================
# 工具函数
# ============================================================================

class Colors:
    """终端颜色定义"""
    RED = '\033[0;31m'
    GREEN = '\033[0;32m'
    YELLOW = '\033[1;33m'
    NC = '\033[0m'


def print_color(message, color=Colors.NC):
    """彩色输出"""
    print(f"{color}{message}{Colors.NC}")


def run_command(cmd, cwd=None):
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
        print_color(f"命令执行失败: {e}", Colors.RED)
        return "", 1


# ============================================================================
# 缓存管理
# ============================================================================

def load_cache(repo_name):
    """加载指定仓库的缓存数据"""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"{repo_name}.json"

    try:
        with open(cache_file, 'r', encoding='utf-8') as f:
            cache_data = json.load(f)
            print_color(f"💾 已加载缓存: {cache_file}", Colors.GREEN)

            # 处理新旧缓存格式
            if '_metadata' in cache_data:
                metadata = cache_data['_metadata']
                print_color(f"   缓存包含 {metadata.get('total_commits', 0)} 个commits", Colors.NC)
                return cache_data.get('data', {})
            else:
                # 旧格式，直接返回
                print_color(f"   缓存包含 {len(cache_data)} 个commits的数据", Colors.NC)
                return cache_data
    except (json.JSONDecodeError, IOError) as e:
        print_color(f"⚠️  加载缓存失败: {e}", Colors.YELLOW)
        return {}


def save_cache(repo_name, cache_data):
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
        # 对每个仓库的 commits 按时间戳排序（从旧到新）
        sorted_cache_data = {}
        total_commits = 0
        total_images = 0
        total_additions = 0
        total_deletions = 0

        for repo_name, commits in cache_data.items():
            if isinstance(commits, list):
                # 按 timestamp 从旧到新排序（老的在前，新的在后）
                sorted_commits = sorted(commits, key=lambda x: x.get('timestamp', ''))

                # 重新编号 index（从 1 开始）并统计各项数据
                repo_images = 0
                repo_additions = 0
                repo_deletions = 0
                for idx, commit in enumerate(sorted_commits, start=1):
                    commit['index'] = idx
                    repo_additions += commit.get('additions', 0)
                    repo_deletions += commit.get('deletions', 0)
                    repo_images += commit.get('images', 0)

                sorted_cache_data[repo_name] = sorted_commits
                total_commits += len(sorted_commits)
                total_additions += repo_additions
                total_deletions += repo_deletions
                total_images += repo_images
            else:
                # 旧格式，保持原样
                sorted_cache_data[repo_name] = commits
                total_commits += len(commits)
                # 旧格式也尝试统计各项数据
                if isinstance(commits, dict):
                    for commit_data in commits.values():
                        total_additions += commit_data.get('additions', 0)
                        total_deletions += commit_data.get('deletions', 0)
                        total_images += commit_data.get('images', 0)

        cache_data_with_metadata = {
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
        print_color(f"   commits: {cache_data_with_metadata['_metadata']['total_commits']}", Colors.NC)
        print_color(f"   additions: {cache_data_with_metadata['_metadata']['total_additions']}", Colors.NC)
        print_color(f"   deletions: {cache_data_with_metadata['_metadata']['total_deletions']}", Colors.NC)
        print_color(f"   images: {cache_data_with_metadata['_metadata']['total_images']}", Colors.NC)
        return True
    except Exception as e:
        print_color(f"⚠️  保存缓存失败: {e}", Colors.YELLOW)
        return False


def clean_stale_cache(cache_data, current_commits_with_data, repo_key):
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
    current_commit_set = set()
    oldest_current_time = None

    for commit in current_commits_with_data:
        sha = commit.get('sha')
        if sha:
            current_commit_set.add(sha)

        # 获取 commit 时间戳
        commit_time = commit.get('commit', {}).get('author', {}).get('date', '')
        if commit_time:
            if oldest_current_time is None or commit_time < oldest_current_time:
                oldest_current_time = commit_time

    # 新格式：数组结构
    if isinstance(cache_data[repo_key], list):
        # 从 URL 中提取 sha
        cached_shas = set()
        for item in cache_data[repo_key]:
            url = item.get('url', '')
            if url:
                sha = url.split('/')[-1]  # 从 URL 末尾提取 sha
                cached_shas.add(sha)
    else:
        # 旧格式：对象结构
        cached_shas = set(cache_data[repo_key].keys())

    # 找出在当前合并数据中消失的 commits
    stale_commits = cached_shas - current_commit_set

    if stale_commits:
        print_color(f"    🧹 检测到 {len(stale_commits)} 个消失的commits", Colors.YELLOW)
        print_color(f"       原因：可能被变基、压缩或重写", Colors.YELLOW)

        deleted_count = 0
        preserved_count = 0

        if isinstance(cache_data[repo_key], list):
            # 新格式：过滤数组
            new_cache_list = []
            for item in cache_data[repo_key]:
                url = item.get('url', '')
                sha = url.split('/')[-1] if url else ''
                cached_commit_time = item.get('timestamp', '')

                # 判断是否应该删除
                if sha in stale_commits:
                    if oldest_current_time and cached_commit_time < oldest_current_time:
                        # 保留永久历史数据
                        new_cache_list.append(item)
                        preserved_count += 1
                    else:
                        # 删除在当前数据范围内消失的 commits
                        deleted_count += 1
                else:
                    new_cache_list.append(item)

            cache_data[repo_key] = new_cache_list
        else:
            # 旧格式：删除字典键
            repo_cache = cache_data[repo_key]
            for commit_sha in list(stale_commits):
                cached_commit_time = repo_cache[commit_sha].get('timestamp', '')

                if oldest_current_time and cached_commit_time < oldest_current_time:
                    preserved_count += 1
                else:
                    del repo_cache[commit_sha]
                    deleted_count += 1

        print_color(f"    ✅ 已清除 {deleted_count} 个过期的commit缓存及其统计数据", Colors.GREEN)
        if preserved_count > 0:
            print_color(f"    ℹ️  保留 {preserved_count} 个永久历史数据（比当前最老数据更久远）", Colors.NC)

        # 如果仓库缓存为空，删除该仓库的缓存条目
        if not repo_cache:
            del cache_data[repo_key]
            print_color(f"    ℹ️  仓库缓存已清空", Colors.NC)
    else:
        print_color(f"    ✅ 缓存数据完整，无消失的commits", Colors.GREEN)

    return cache_data


# ============================================================================
# GitHub API 操作
# ============================================================================

def get_repos():
    """获取用户的所有仓库（包括公开和私有仓库）"""
    print_color("📡 获取所有仓库列表...", Colors.YELLOW)

    # 使用 curl 获取仓库列表
    curl_cmd = f'curl -s -H "Authorization: token {TOKEN}" -H "Accept: application/vnd.github.v3+json" "{GITHUB_API}/users/{USERNAME}/repos?per_page=100&type=all"'
    output, returncode = run_command(curl_cmd)

    if returncode != 0:
        print_color("❌ 获取仓库列表失败", Colors.RED)
        return []

    # 解析 JSON
    try:
        repos = json.loads(output)
        if not isinstance(repos, list):
            print_color(f"❌ API 返回的数据格式错误: {type(repos)}", Colors.RED)
            print_color(f"数据内容: {output[:500]}", Colors.RED)
            return []

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


def get_upstream_repo(repo):
    """获取 fork 仓库的上游仓库信息"""
    if not repo.get('fork'):
        return None, None

    upstream_info = repo.get('source') or repo.get('parent') or {}
    if upstream_info:
        upstream_owner = upstream_info.get('owner', {}).get('login')
        upstream_name = upstream_info.get('name')
        if upstream_owner and upstream_name:
            return upstream_owner, upstream_name
    return None, None


# ============================================================================
# Commits 数据获取
# ============================================================================

def get_commits_from_git_log(repo_path, username, default_branch):
    """从本地 git log 获取用户的所有 commits（完整历史）"""
    git_cmd = f'git log origin/{default_branch} --author="{username}" --format="%H"'
    output, returncode = run_command(git_cmd, cwd=repo_path)

    if returncode == 0:
        commit_hashes = [h.strip() for h in output.split('\n') if h.strip()]
        all_commits = [{'sha': h} for h in commit_hashes]
        print_color(f"    ℹ️  git log 获取 {len(all_commits)} 个commits", Colors.NC)
        return all_commits
    else:
        print_color(f"    ⚠️  git log 失败", Colors.YELLOW)
        return None


def get_commits_from_api(owner, repo_name, username, max_pages=10):
    """从 GitHub API 获取用户的最近 commits（分页，最多 10 页）

    只获取最近的 commits，很久以前的 commits 从缓存读取
    """
    page = 1
    per_page = 100
    all_commits = []

    while page <= max_pages:
        api_url = f"{GITHUB_API}/repos/{owner}/{repo_name}/commits?author={username}&per_page={per_page}&page={page}"
        print_color(f"    🔍 获取commits (第{page}页)...", Colors.NC)

        curl_cmd = f'curl -s -H "Authorization: token {TOKEN}" -H "Accept: application/vnd.github.v3+json" "{api_url}"'
        output, returncode = run_command(curl_cmd)

        if returncode != 0:
            print_color("    ❌ API调用失败", Colors.RED)
            return all_commits if all_commits else []

        try:
            commits = json.loads(output)
            if not isinstance(commits, list):
                print_color("    ❌ API返回数据格式错误", Colors.RED)
                return all_commits if all_commits else []

            if not commits:
                break

            all_commits.extend(commits)
            print_color(f"    📊 已获取 {len(all_commits)} 个commits", Colors.NC)

            if len(commits) < per_page:
                break

            page += 1

        except json.JSONDecodeError as e:
            print_color(f"    ❌ JSON 解析失败: {e}", Colors.RED)
            return all_commits if all_commits else []

    if page > max_pages:
        print_color(f"    ℹ️  已达到最大页数限制 ({max_pages} 页)，共 {len(all_commits)} 个commits", Colors.NC)
        print_color(f"    ℹ️  更久以前的 commits 将从缓存读取", Colors.NC)

    return all_commits


def merge_commits(git_commits, api_commits):
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
        return api_commits

    if not api_commits:
        print_color(f"    ✅ 仅使用 git log 数据", Colors.GREEN)
        return git_commits

    # 构建 commit 映射（sha -> commit 对象）
    git_map = {c.get('sha'): c for c in git_commits if c.get('sha')}
    api_map = {c.get('sha'): c for c in api_commits if c.get('sha')}

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
    merged = {}

    # 1. 处理相同的 commits：比较时间戳，谁的新用谁的
    for sha in common_shas:
        git_commit = git_map[sha]
        api_commit = api_map[sha]

        git_time = git_commit.get('commit', {}).get('author', {}).get('date', '')
        api_time = api_commit.get('commit', {}).get('author', {}).get('date', '')

        # 比较时间戳（ISO 格式可以直接字符串比较）
        if api_time > git_time:
            # API 数据更新
            merged[sha] = api_commit
        else:
            # git log 数据更新或相同
            merged[sha] = git_commit

    # 2. 保留 git log 独有的 commits（老数据）
    for sha in git_only_shas:
        merged[sha] = git_map[sha]

    # 3. 保留 API 独有的 commits（新数据）
    for sha in api_only_shas:
        merged[sha] = api_map[sha]

    result = list(merged.values())
    print_color(f"    ✅ 合并完成，共 {len(result)} 个commits", Colors.GREEN)
    return result


# ============================================================================
# Commits 分析
# ============================================================================

def analyze_commits(repo_path, owner, repo_name, username, include_images=True):
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
    api_commits = get_commits_from_api(owner, repo_name, username)

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
        if processed % 10 == 0:
            print_color(f"    📊 处理中: {processed}/{total_commits} ({processed*100//total_commits}%)", Colors.NC)

        # 检查缓存
        commit_url = f"https://github.com/{owner}/{repo_name}/commit/{sha}"
        cached_data = None
        if repo_name in cache_data and isinstance(cache_data[repo_name], list):
            # 新格式：数组结构
            for item in cache_data[repo_name]:
                if item.get('url') == commit_url:
                    cached_data = item
                    break

        if cached_data:
            total_additions += cached_data.get('additions', 0)
            total_deletions += cached_data.get('deletions', 0)
            if include_images:
                total_images += cached_data.get('images', 0)
            cache_hits += 1
            continue

        cache_misses += 1
        commit_data = {}

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
                status_map = {}
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

        for file in commit_data.get('files', []):
            # 代码行数统计
            if 'additions' in file and 'deletions' in file:
                additions += file.get('additions', 0)
                deletions += file.get('deletions', 0)

            # 图片统计
            if include_images and file.get('status') == 'added':
                filename = file.get('filename', '')
                if any(filename.lower().endswith(ext) for ext in ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.ico']):
                    images += 1

        total_additions += additions
        total_deletions += deletions
        total_images += images

        # 获取 commit 的时间戳（用于缓存清理时的永久历史判断）
        commit_timestamp = commit.get('commit', {}).get('author', {}).get('date', '')
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

    print_color(f"    ✅ 代码贡献: +{total_additions} additions, -{total_deletions} deletions", Colors.GREEN)
    if include_images:
        print_color(f"    ✅ 图片贡献: {total_images} images", Colors.GREEN)

    # 保存缓存
    save_cache(repo_name, cache_data)

    return total_additions, total_deletions, total_images


# ============================================================================
# 仓库处理
# ============================================================================

def process_repos(repos, include_images=True):
    """处理所有仓库

    Args:
        repos: 仓库列表
        include_images: 是否统计图片贡献
    """
    print_color("=" * 60, Colors.GREEN)
    print_color("开始处理仓库...", Colors.GREEN)
    print_color("=" * 60, Colors.GREEN)

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

        print_color("\n" + "=" * 60, Colors.GREEN)
        print_color(f"📦 仓库: {repo_name}", Colors.YELLOW)
        print_color("=" * 60, Colors.GREEN)
        print_color("  URL: " + repo_url, Colors.NC)
        print_color("  类型: " + ('Fork 仓库' if is_fork else '原创仓库'), Colors.NC)

        # 克隆仓库到临时目录
        repo_path = temp_dir / repo_name
        if repo_path.exists():
            print_color(f"  🔄 更新本地仓库...", Colors.YELLOW)
            # 更新默认分支
            run_command("git fetch origin", cwd=str(repo_path))
        else:
            print_color(f"  📥 克隆仓库...", Colors.YELLOW)
            clone_url = repo_url.replace("https://github.com/", f"https://{TOKEN}@github.com/")
            # 克隆仓库
            run_command(f"git clone {clone_url}", cwd=str(temp_dir))

        # 确定要分析的仓库（fork 仓库用上游仓库）
        owner = USERNAME
        target_repo_name = repo_name

        upstream_owner, upstream_name = get_upstream_repo(repo)
        if upstream_owner and upstream_name:
            owner = upstream_owner
            target_repo_name = upstream_name

        # 同时分析代码行数和图片贡献
        # 注意：repo_path 用于获取 git log，owner/repo_name 用于 API
        repo_additions, repo_deletions, repo_images = analyze_commits(
            str(repo_path), owner, target_repo_name, USERNAME, include_images
        )

        total_images += repo_images

        # 显示结果
        if repo_additions == 0 and repo_deletions == 0 and repo_images == 0:
            print_color("  ⚠️  用户没有代码或图片贡献", Colors.YELLOW)
        else:
            print_color(f"  ✅ 代码贡献: +{repo_additions} additions, -{repo_deletions} deletions", Colors.GREEN)
            if include_images:
                print_color(f"  ✅ 图片贡献: {repo_images} images", Colors.GREEN)

            # 累加到总计
            total_additions += repo_additions
            total_deletions += repo_deletions

    # 清理临时目录
    print_color("\n  🧹 清理临时文件...", Colors.YELLOW)
    if temp_dir.exists():
        shutil.rmtree(temp_dir)

    print_color("\n" + "=" * 60, Colors.GREEN)
    print_color("📈 汇总统计", Colors.GREEN)
    print_color("=" * 60, Colors.GREEN)
    print_color(f"  ➕ 总 additions: {total_additions}", Colors.GREEN)
    print_color(f"  ➖ 总 deletions: {total_deletions}", Colors.GREEN)
    if include_images:
        print_color(f"  🖼️ 总 images: {total_images} images", Colors.GREEN)
    print_color("=" * 60, Colors.GREEN)

    return {
        'total_additions': total_additions,
        'total_deletions': total_deletions,
        'total_images': total_images
    }


# ============================================================================
# README 更新
# ============================================================================

def update_readme(stats):
    """更新 README.md 中的统计数据和时间

    功能：
    - 使用正则表达式匹配替换统计数字
    - 使用正则表达式匹配替换更新时间
    - 保持原有 HTML 格式和样式不变

    替换内容：
    1. ➕additions: 数字 ➖deletions: 数字 🖼️images: 数字
    2. 最后更新: YYYY-MM-DD HH:MM:SS

    参数：
    - stats: 统计数据字典，包含 total_additions, total_deletions, total_images
    """
    print_color("📝 更新 README.md...", Colors.YELLOW)

    readme_file = Path("README.md")

    if not readme_file.exists():
        print_color("❌ README.md 不存在！", Colors.RED)
        return False

    # 读取 README.md
    with open(readme_file, 'r', encoding='utf-8') as f:
        content = f.read()

    # 只替换统计数字和更新时间，保持表格结构不变
    # 匹配模式：➕additions: 数字 ➖deletions: 数字 🖼️images: 数字
    pattern = r'(➕additions: )\d+( ➖deletions: )\d+( 🖼️images: )\d+'
    replacement = f'\\g<1>{stats.get("total_additions", 0)}\\g<2>{stats.get("total_deletions", 0)}\\g<3>{stats.get("total_images", 0)}'
    content = re.sub(pattern, replacement, content)

    # 只替换更新时间，使用中国时区 (UTC+8)
    china_tz = timezone(timedelta(hours=8))
    current_time = datetime.now(china_tz).strftime("%Y-%m-%d %H:%M:%S UTC+8")
    time_pattern = r'(Last updated: )\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}( UTC\+8)?'
    time_replacement = f'\\g<1>{current_time}'
    content = re.sub(time_pattern, time_replacement, content)

    # 写回 README.md
    with open(readme_file, 'w', encoding='utf-8') as f:
        f.write(content)

    print_color("✅ README.md 更新成功！", Colors.GREEN)
    print_color(f"   ➕ 增加行数: {stats.get('total_additions', 0)}", Colors.NC)
    print_color(f"   ➖ 删除行数: {stats.get('total_deletions', 0)}", Colors.NC)
    print_color(f"   🖼️ 图片数量: {stats.get('total_images', 0)}", Colors.NC)
    print_color(f"   🕒 更新时间: {current_time}", Colors.NC)
    return True


# ============================================================================
# 主函数
# ============================================================================

def main():
    """主函数"""
    parser = argparse.ArgumentParser(description='生成 GitHub 统计')
    parser.add_argument('--no-images', action='store_true', help='不统计图片贡献')
    parser.add_argument('--clear-cache', action='store_true', help='清除缓存文件')
    args = parser.parse_args()

    print_color("=" * 60, Colors.GREEN)
    print_color("🚀 开始生成 GitHub 统计...", Colors.GREEN)
    print_color("=" * 60, Colors.GREEN)
    print_color("📊 统计配置:", Colors.YELLOW)
    print_color(f"   - 图片统计: {'关闭' if args.no_images else '开启'}", Colors.NC)
    if not args.no_images:
        print_color(f"   - 缓存目录: {CACHE_DIR}", Colors.NC)
    print_color("=" * 60, Colors.GREEN)

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

    print_color("=" * 60, Colors.GREEN)
    print_color("✅ 脚本执行完成！", Colors.GREEN)
    print_color("=" * 60, Colors.GREEN)
    return 0


if __name__ == "__main__":
    exit(main())

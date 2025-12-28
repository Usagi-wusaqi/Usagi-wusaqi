#!/usr/bin/env python3

import os
import subprocess
import json
import re
from pathlib import Path
from datetime import datetime

# GitHub API 配置
GITHUB_API = "https://api.github.com"
USERNAME = os.environ.get("USERNAME", "Usagi-wusaqi")
TOKEN = os.environ.get("GH_TOKEN")

# 缓存目录
CACHE_DIR = Path(__file__).parent / "stats_cache"

# 颜色定义（终端输出）
class Colors:
    RED = '\033[0;31m'
    GREEN = '\033[0;32m'
    YELLOW = '\033[1;33m'
    NC = '\033[0m'

def print_color(message, color=Colors.NC):
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

def load_cache(owner, repo_name):
    """加载指定仓库的缓存数据"""
    cache_dir = CACHE_DIR
    cache_dir.mkdir(parents=True, exist_ok=True)

    cache_file = cache_dir / f"{repo_name}.json"

    try:
        with open(cache_file, 'r', encoding='utf-8') as f:
            cache_data = json.load(f)
            print_color(f"💾 已加载缓存: {cache_file}", Colors.GREEN)

            # 处理新旧缓存格式
            if '_metadata' in cache_data:
                metadata = cache_data['_metadata']
                print_color(f"   缓存包含 {metadata.get('total_commits', 0)} 个commits", Colors.NC)
                print_color(f"   最后更新时间: {metadata.get('last_updated', '未知')}", Colors.NC)
                return cache_data.get('data', {})
            else:
                # 旧格式，直接返回
                print_color(f"   缓存包含 {len(cache_data)} 个commits的数据", Colors.NC)
                return cache_data
    except (json.JSONDecodeError, IOError) as e:
        print_color(f"⚠️  加载缓存失败: {e}", Colors.YELLOW)
        return {}

def save_cache(owner, repo_name, cache_data):
    """保存指定仓库的缓存数据，记录更新时间"""
    cache_dir = CACHE_DIR
    cache_dir.mkdir(parents=True, exist_ok=True)

    cache_file = cache_dir / f"{repo_name}.json"

    try:
        # 添加更新时间戳
        cache_data_with_metadata = {
            '_metadata': {
                'last_updated': datetime.now().isoformat(),
                'total_commits': len(cache_data)
            },
            'data': cache_data
        }

        with open(cache_file, 'w', encoding='utf-8') as f:
            json.dump(cache_data_with_metadata, f, indent=2, ensure_ascii=False)

        print_color(f"✅ 缓存已保存: {cache_file}", Colors.GREEN)
        print_color(f"   更新时间: {cache_data_with_metadata['_metadata']['last_updated']}", Colors.NC)
        print_color(f"   commits: {cache_data_with_metadata['_metadata']['total_commits']}", Colors.NC)
        return True
    except Exception as e:
        print_color(f"⚠️  保存缓存失败: {e}", Colors.YELLOW)
        return False

def get_cache_key(owner, repo_name):
    """获取仓库的缓存键"""
    return f"{owner}/{repo_name}"

def clean_stale_cache(cache_data, current_commits, repo_key):
    """清理过期的缓存（检测变基等导致的commit哈希变化）"""
    if repo_key not in cache_data:
        return cache_data

    repo_cache = cache_data[repo_key]
    current_commit_set = set(current_commits)
    cached_commits = set(repo_cache.keys())

    # 找出不再存在的commit（可能被变基删除）
    stale_commits = cached_commits - current_commit_set

    if stale_commits:
        print_color(f"    🧹 清理 {len(stale_commits)} 个过期的commit缓存", Colors.YELLOW)
        for commit in stale_commits:
            del repo_cache[commit]

        # 如果仓库缓存为空，删除该仓库的缓存条目
        if not repo_cache:
            del cache_data[repo_key]

    return cache_data

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

def get_user_contributed_images_from_api(owner, repo_name, username):
    """使用 GitHub API 获取用户贡献的图片文件数量（带缓存）"""
    print_color(f"    🖼️  使用API统计图片贡献: {owner}/{repo_name}", Colors.YELLOW)

    repo_key = get_cache_key(owner, repo_name)

    # 加载该仓库的缓存
    cache_data = load_cache(owner, repo_name)

    # 获取用户的所有commits（分页获取）
    page = 1
    per_page = 100
    all_commits = []
    total_commits = 0

    while True:
        api_url = f"{GITHUB_API}/repos/{owner}/{repo_name}/commits?author={username}&per_page={per_page}&page={page}"
        print_color(f"    🔍 获取commits (第{page}页)...", Colors.NC)

        curl_cmd = f'curl -s -H "Authorization: token {TOKEN}" -H "Accept: application/vnd.github.v3+json" "{api_url}"'
        output, returncode = run_command(curl_cmd)

        if returncode != 0:
            print_color("    ❌ API调用失败", Colors.RED)
            return 0

        try:
            commits = json.loads(output)
            if not isinstance(commits, list):
                print_color("    ❌ API返回数据格式错误", Colors.RED)
                return 0

            if not commits:
                break

            all_commits.extend(commits)
            total_commits = len(all_commits)

            print_color(f"    📊 已获取 {total_commits} 个commits", Colors.NC)

            # 如果返回的commits少于per_page，说明已经到最后一页
            if len(commits) < per_page:
                break

            page += 1

        except json.JSONDecodeError as e:
            print_color(f"    ❌ JSON 解析失败: {e}", Colors.RED)
            return 0

    print_color(f"    📊 总共找到 {total_commits} 个commits", Colors.NC)

    # 清理过期的缓存（检测变基等导致的commit哈希变化）
    current_commit_hashes = [commit.get('sha') for commit in all_commits if commit.get('sha')]
    cache_data = clean_stale_cache(cache_data, current_commit_hashes, repo_key)

    # 统计新增的图片文件
    image_files = set()
    processed = 0
    cache_hits = 0
    cache_misses = 0
    api_calls = 0

    for commit in all_commits:
        sha = commit.get('sha')
        if not sha:
            continue

        processed += 1
        if processed % 10 == 0:
            print_color(f"    📊 处理中: {processed}/{total_commits} ({processed*100//total_commits}%)", Colors.NC)

        # 检查缓存
        if repo_key in cache_data and sha in cache_data[repo_key]:
            cached_data = cache_data[repo_key][sha]
            cached_images = cached_data.get('images', [])
            image_files.update(cached_images)
            cache_hits += 1
            continue

        # 缓存未命中，调用API获取commit详情
        cache_misses += 1
        api_calls += 1

        commit_url = f"{GITHUB_API}/repos/{owner}/{repo_name}/commits/{sha}"
        curl_cmd = f'curl -s -H "Authorization: token {TOKEN}" -H "Accept: application/vnd.github.v3+json" "{commit_url}"'
        output, returncode = run_command(curl_cmd)

        if returncode != 0:
            continue

        try:
            commit_data = json.loads(output)
            files = commit_data.get('files', [])

            commit_images = []
            for file in files:
                filename = file.get('filename', '')
                status = file.get('status', '')

                # 只统计新增的图片文件
                if status == 'added':
                    if any(filename.lower().endswith(ext) for ext in ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp', '.ico']):
                        image_files.add(filename)
                        commit_images.append(filename)

            # 更新缓存（记录所有检查过的commit）
            if repo_key not in cache_data:
                cache_data[repo_key] = {}
            cache_data[repo_key][sha] = {
                'images': commit_images,
                'image_count': len(commit_images),
                'timestamp': datetime.now().isoformat()
            }

        except json.JSONDecodeError:
            continue

    image_count = len(image_files)

    # 显示统计信息
    print_color("    💾 缓存统计:", Colors.YELLOW)
    print_color(f"       - 缓存命中: {cache_hits} 个commit", Colors.NC)
    print_color(f"       - 缓存未命中: {cache_misses} 个commit", Colors.NC)
    print_color(f"       - API调用: {api_calls} 次", Colors.NC)
    if total_commits > 0:
        cache_hit_rate = (cache_hits / total_commits * 100) if total_commits > 0 else 0
        print_color(f"       - 缓存命中率: {cache_hit_rate:.1f}%", Colors.NC)

    if image_count > 0:
        print_color(f"    ✅ 图片贡献总数: {image_count} 个", Colors.GREEN)
        for file in sorted(image_files):
            print_color(f"       - {file}", Colors.NC)
    else:
        print_color(f"    ℹ️  图片贡献总数: {image_count} 个", Colors.NC)

    # 保存该仓库的缓存
    save_cache(owner, repo_name, cache_data)

    return image_count

def get_user_contributed_lines_from_api(owner, repo_name, username):
    """使用 GitHub API 获取用户贡献的代码行数"""
    api_url = f"{GITHUB_API}/repos/{owner}/{repo_name}/stats/contributors"
    print_color(f"    🔍 API请求: {api_url}", Colors.YELLOW)

    # 使用 GitHub API 获取贡献者统计
    curl_cmd = f'curl -s -w "\n%{{http_code}}" -H "Authorization: token {TOKEN}" -H "Accept: application/vnd.github.v3+json" "{api_url}"'
    output, returncode = run_command(curl_cmd)

    if returncode != 0:
        print_color(f"    ❌ API调用失败: {owner}/{repo_name}", Colors.RED)
        return 0, 0

    # 分离HTTP状态码和响应体
    lines = output.split('\n')
    if len(lines) >= 2:
        http_code = lines[-1].strip()
        response_body = '\n'.join(lines[:-1])
    else:
        http_code = "200"
        response_body = output

    print_color("    📡 HTTP状态码: " + http_code, Colors.NC)

    # 检查HTTP状态码
    if http_code == "202":
        print_color("    ⏳ GitHub正在计算贡献统计，暂时无法获取数据", Colors.YELLOW)
        return 0, 0

    # 解析 JSON
    try:
        contributors = json.loads(response_body)
        if not isinstance(contributors, list):
            print_color("    ❌ API返回数据格式错误: " + str(type(contributors)), Colors.RED)
            print_color("    数据内容: " + response_body[:500], Colors.RED)
            return 0, 0

        print_color(f"    👥 API返回了 {len(contributors)} 个贡献者", Colors.NC)

        # 如果返回空数组，打印详细信息
        if len(contributors) == 0:
            print_color("    ⚠️  API返回空数组，可能仓库没有代码贡献或GitHub正在计算", Colors.YELLOW)
            return 0, 0

        # 查找当前用户的贡献
        user_contrib = None
        for contrib in contributors:
            author = contrib.get('author')
            if author and author.get('login') == username:
                user_contrib = contrib
                break

        if not user_contrib:
            print_color("    ⚠️  未找到用户 " + username + " 的贡献数据", Colors.YELLOW)
            # 打印所有贡献者名称用于调试
            contrib_names = [c.get('author', {}).get('login', 'unknown') for c in contributors if c.get('author')]
            if contrib_names:
                print_color("    📋 贡献者列表: " + ", ".join(contrib_names), Colors.NC)
            return 0, 0

        weeks = user_contrib.get('weeks', [])

        # 手动计算贡献行数（遍历 weeks 数组）
        total_additions = 0
        total_deletions = 0
        for week in weeks:
            additions = week.get('a', 0)
            deletions = week.get('d', 0)
            total_additions += additions
            total_deletions += deletions

        print_color(f"    ✅ 用户贡献: +{total_additions} 增加, -{total_deletions} 删除", Colors.GREEN)
        return total_additions, total_deletions

    except json.JSONDecodeError as e:
        print_color(f"    ❌ JSON 解析失败: {e}", Colors.RED)
        print_color(f"    数据内容: {response_body[:500]}", Colors.RED)
        return 0, 0

def get_user_contributed_lines(username, repo_name, repo_info=None):
    """获取用户实际贡献的代码行数"""

    owner = USERNAME
    target_repo_name = repo_name

    is_fork = repo_info.get('fork', False) if repo_info else False
    print_color("    📌 仓库类型: " + ('Fork 仓库' if is_fork else '原创仓库'), Colors.NC)

    # 对于 fork 仓库，从上游仓库获取贡献统计
    if is_fork and repo_info:
        # 获取上游仓库信息
        upstream_info = repo_info.get('source') or repo_info.get('parent') or {}
        if upstream_info:
            upstream_owner = upstream_info.get('owner', {}).get('login')
            upstream_name = upstream_info.get('name')
            if upstream_owner and upstream_name:
                owner = upstream_owner
                target_repo_name = upstream_name
                print_color("    🔗 从上游仓库获取: " + owner + "/" + target_repo_name, Colors.YELLOW)

    # 使用确定的owner和repo_name获取贡献统计
    return get_user_contributed_lines_from_api(owner, target_repo_name, username)

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
    total_image_count = 0

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

        # 获取代码贡献统计（不需要克隆）
        print_color("  📊 统计代码贡献...", Colors.YELLOW)
        repo_additions, repo_deletions = get_user_contributed_lines(USERNAME, repo_name, repo)

        repo_image_count = 0

        # 统计图片贡献
        if include_images:
            # 使用API统计（不需要克隆）
            owner = USERNAME
            target_repo_name = repo_name

            if is_fork and repo:
                upstream_info = repo.get('source') or repo.get('parent') or {}
                if upstream_info:
                    upstream_owner = upstream_info.get('owner', {}).get('login')
                    upstream_name = upstream_info.get('name')
                    if upstream_owner and upstream_name:
                        owner = upstream_owner
                        target_repo_name = upstream_name

            repo_image_count = get_user_contributed_images_from_api(owner, target_repo_name, USERNAME)
        else:
            print_color("  ⏭️  跳过图片统计（未启用）", Colors.YELLOW)

        total_image_count += repo_image_count

        # 显示结果
        if repo_additions == 0 and repo_deletions == 0 and repo_image_count == 0:
            print_color("  ⚠️  用户没有贡献代码或图片", Colors.YELLOW)
        else:
            print_color(f"  ✅ 代码贡献: +{repo_additions} 增加, -{repo_deletions} 删除", Colors.GREEN)
            print_color(f"  ✅ 图片贡献: {repo_image_count} 个", Colors.GREEN)

            # 累加到总计
            total_additions += repo_additions
            total_deletions += repo_deletions

    print_color("\n" + "=" * 60, Colors.GREEN)
    print_color("📈 汇总统计", Colors.GREEN)
    print_color("=" * 60, Colors.GREEN)
    print_color(f"  ➕ 总增加行数: {total_additions}", Colors.GREEN)
    print_color(f"  ➖ 总删除行数: {total_deletions}", Colors.GREEN)
    print_color(f"  🖼️ 总图片贡献: {total_image_count} 个", Colors.GREEN)
    print_color("=" * 60, Colors.GREEN)

    return {
        'total_additions': total_additions,
        'total_deletions': total_deletions,
        'image_count': total_image_count
    }

def update_readme(stats):
    """更新 README.md"""
    print_color("📝 更新 README.md...", Colors.YELLOW)

    readme_file = Path("README.md")

    if not readme_file.exists():
        print_color("❌ README.md 不存在！", Colors.RED)
        return False

    # 读取 README.md
    with open(readme_file, 'r', encoding='utf-8') as f:
        content = f.read()

    # 只替换统计数字，保持表格结构不变
    # 匹配模式：➕ 增加行数: 数字 ➖ 删除行数: 数字 🖼️ 图片贡献: 数字
    pattern = r'(➕ 增加行数: )\d+( ➖ 删除行数: )\d+( 🖼️ 图片贡献: )\d+'
    replacement = f'\\g<1>{stats.get("total_additions", 0)}\\g<2>{stats.get("total_deletions", 0)}\\g<3>{stats.get("image_count", 0)}'
    content = re.sub(pattern, replacement, content)

    # 写回 README.md
    with open(readme_file, 'w', encoding='utf-8') as f:
        f.write(content)

    print_color("✅ README.md 更新成功！", Colors.GREEN)
    print_color(f"   ➕ 增加行数: {stats.get('total_additions', 0)}", Colors.NC)
    print_color(f"   ➖ 删除行数: {stats.get('total_deletions', 0)}", Colors.NC)
    print_color(f"   🖼️ 图片贡献: {stats.get('image_count', 0)}", Colors.NC)
    return True

def main():
    import argparse

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
            import shutil
            shutil.rmtree(CACHE_DIR)
            print_color("✅ 缓存已清除", Colors.GREEN)
        else:
            print_color("ℹ️  缓存目录不存在: " + str(CACHE_DIR), Colors.NC)
        return 0

    # 检查 TOKEN
    if not TOKEN:
        print_color("❌ 错误: GITHUB_TOKEN 环境变量未设置", Colors.RED)
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

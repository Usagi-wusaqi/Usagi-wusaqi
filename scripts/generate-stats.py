#!/usr/bin/env python3
"""GitHub Contributions Statistics Script

## 核心功能
- 统计所有仓库的图片贡献（images 数量）
- 智能缓存系统，避免重复分析已处理的 commits
- 支持 Fork 仓库（直接克隆上游仓库获取完整历史）
- 从模板生成 README.md，输出 stats.json 供 Vercel 卡片读取

## 数据源策略
- Git log 优先：完整历史数据，准确可靠
- API 仅兜底：仅在 git log 失败时使用（有分页限制，最多 1000 条）

## Fork 仓库处理
- 直接克隆上游仓库（不是 Fork 仓库本身）
- 从 origin 获取 Git log，保证获取完整的 commit 历史

## 缓存清理策略
- Git log 模式：对比所有 commits，删除消失的（被变基/压缩/重写）
- API 兜底模式：只对比 API 时间戳范围内的 commits，范围外的老数据保留

## 缓存机制
每个仓库一个 JSON 文件，包含：
- 元数据：总 commits 数、总 images 数
- 详细数据：每个 commit 的统计数据

## 更新策略
- 只有运行脚本时才更新数据
- 从模板生成 README，替换用户名占位符
- 永久保存历史数据，智能清理过期缓存
"""

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import cast

# ============================================================================
# 类型定义
# ============================================================================

FileData = dict[str, str | int]
AuthorData = dict[str, str]
CommitDetailData = dict[str, AuthorData]
CommitData = dict[str, str | int | FileData | CommitDetailData | list[FileData]]
CacheData = dict[str, list[CommitData]]
RepoInfo = dict[str, str | bool | dict[str, str] | None]
StatsData = dict[str, int | str]


@dataclass
class RepoContext:
    """仓库上下文信息，用于减少函数参数数量"""

    repo_path: str  # 本地仓库路径
    owner: str  # 仓库所有者（Fork 仓库时为上游 owner）
    repo_name: str  # 仓库名称（Fork 仓库时为上游名称）
    username: str  # 要统计的用户名


# ============================================================================
# 常量定义
# ============================================================================

GITHUB_API = "https://api.github.com"
SEPARATOR_LENGTH = 60
MAX_API_PAGES = 10
PER_PAGE = 100
RATE_LIMIT_WARN_THRESHOLD = 50
PROGRESS_INTERVAL = 10
IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".webp", ".ico"]
README_FILE_PATH = Path(__file__).parent.parent / "README.md"
STATS_JSON_PATH = Path(__file__).parent.parent / "stats.json"
CACHE_DIR = Path(__file__).parent / "stats_cache"
AUTHOR_IDENTITIES_FILE = CACHE_DIR / "author_identities.json"

# 时间格式常量
TIME_FORMAT = "%Y-%m-%d %H:%M:%S UTC+8"

# Git 解析常量
MIN_STATUS_PARTS = 2  # git show --name-status 输出至少需要的字段数


# ============================================================================
# 辅助函数
# ============================================================================


def get_default_from_readme(var_name: str) -> str | None:
    """从 README.md 中读取默认的用户名变量"""
    if not README_FILE_PATH.exists():
        return None

    try:
        with README_FILE_PATH.open(encoding="utf-8") as f:
            content = f.read()

        # 查找变量定义
        pattern = rf"{var_name} = ([^\n\r]+)"
        match = re.search(pattern, content)
        if match:
            return match.group(1).strip()
    except (OSError, UnicodeDecodeError):
        pass

    return None


# ============================================================================
# 配置
# ============================================================================

ORIGIN_USERNAME = (
    os.environ.get("ORIGIN_USERNAME")
    or get_default_from_readme("ORIGIN_USERNAME")
    or ""
)
UPSTREAM_USERNAME = (
    os.environ.get("UPSTREAM_USERNAME")
    or get_default_from_readme("UPSTREAM_USERNAME")
    or ""
)
TOKEN = os.environ.get("GH_TOKEN")


# ============================================================================
# 作者身份管理（自动学习）
# ============================================================================

# 运行时已知的作者身份（脚本启动时从文件加载）
KNOWN_AUTHOR_IDENTITIES: set[str] = set()


def load_author_identities() -> set[str]:
    """加载已知的作者身份列表

    存储格式: Base64 编码的 JSON
    兼容旧格式: 纯 JSON（自动迁移到新格式）
    """
    if not AUTHOR_IDENTITIES_FILE.exists():
        return set()

    try:
        with AUTHOR_IDENTITIES_FILE.open(encoding="utf-8") as f:
            raw_data = f.read().strip()
            if not raw_data:
                return set()

            # 尝试 Base64 解码（新格式）
            try:
                decoded_bytes = base64.b64decode(raw_data)
                data = json.loads(decoded_bytes.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                # 回退到纯 JSON 解码（旧格式兼容）
                data = json.loads(raw_data)
                # 触发迁移：下次保存时会自动转换为 Base64 格式

            identities = set(data.get("identities", []))
            if identities:
                print_color(f"💾 已加载 {len(identities)} 个已知作者身份", Colors.GREEN)
            return identities
    except (OSError, json.JSONDecodeError) as e:
        print_color(f"⚠️  加载作者身份失败: {e}", Colors.YELLOW)
        return set()


def save_author_identities(identities: set[str]) -> None:
    """保存作者身份列表（Base64 编码，人类不可读）"""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    try:
        # 构建 JSON 数据
        data = {"identities": sorted(identities)}
        json_str = json.dumps(data, ensure_ascii=False)
        # Base64 编码
        encoded_data = base64.b64encode(json_str.encode("utf-8")).decode("ascii")

        with AUTHOR_IDENTITIES_FILE.open("w", encoding="utf-8") as f:
            f.write(encoded_data)
        print_color(f"💾 已保存 {len(identities)} 个作者身份", Colors.GREEN)
    except OSError as e:
        print_color(f"⚠️  保存作者身份失败: {e}", Colors.YELLOW)


def extract_author_from_commit(commit: CommitData) -> str | None:
    """从 commit 对象提取 'Name <email>' 格式的作者身份"""
    commit_dict = commit.get("commit", {})
    if not isinstance(commit_dict, dict):
        return None

    author_dict = commit_dict.get("author", {})
    if not isinstance(author_dict, dict):
        return None

    name = author_dict.get("name", "")
    email = author_dict.get("email", "")
    if name and email:
        return f"{name} <{email}>"
    return None


def learn_author_identities_from_api(
    owner: str,
    repo_name: str,
    username: str,
) -> set[str]:
    """从 GitHub API 学习用户的作者身份

    通过 API 获取用户的 commits，提取所有不同的 author 身份
    """
    print_color("    🔍 从 API 学习作者身份...", Colors.YELLOW)

    identities: set[str] = set()

    # 只请求 1 页（100 条 commits），足够学习常见身份
    api_url = (
        f"{GITHUB_API}/repos/{owner}/{repo_name}/commits"
        f"?author={username}&per_page={PER_PAGE}&page=1"
    )
    output, returncode = github_api_request(api_url)

    if returncode == 0:
        try:
            commits: list[CommitData] = json.loads(output)
            for commit in commits:
                if identity := extract_author_from_commit(commit):
                    identities.add(identity)
        except json.JSONDecodeError:
            pass

    if identities:
        print_color(f"    ✅ 发现 {len(identities)} 个作者身份", Colors.GREEN)
        for identity in sorted(identities):
            print_color(f"       - {identity}", Colors.NC)

    return identities


# ============================================================================
# 工具函数
# ============================================================================


class Colors:
    """终端颜色定义"""

    RED = "\033[0;31m"
    GREEN = "\033[0;32m"
    YELLOW = "\033[1;33m"
    NC = "\033[0m"


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


def is_image_file(filename: str) -> bool:
    """检查文件是否为图片"""
    return any(filename.lower().endswith(ext) for ext in IMAGE_EXTENSIONS)


def print_stats_summary(
    additions: int,
    deletions: int,
    images: int,
    *,
    include_images: bool = True,
    prefix: str = "",
) -> None:
    """打印统计摘要"""
    net = additions - deletions
    net_sign = "+" if net >= 0 else ""
    print_color(
        f"{prefix}✅ +{additions:,} / -{deletions:,} (net {net_sign}{net:,})",
        Colors.GREEN,
    )
    if include_images:
        print_color(f"{prefix}   🖼️ 图片: {images} images", Colors.GREEN)


def run_command(cmd: str | list[str], cwd: str | None = None) -> tuple[str, int]:
    """运行命令并返回输出

    cmd 为 str 时使用 shell=True，为 list 时使用 shell=False（更安全）。
    """
    use_shell = isinstance(cmd, str)
    try:
        result = subprocess.run(
            cmd,
            shell=use_shell,
            capture_output=True,
            text=True,
            cwd=cwd,
            check=False,
        )
        return result.stdout.strip(), result.returncode
    except (OSError, subprocess.SubprocessError) as e:
        print_color(f"❌ 命令执行失败: {e}", Colors.RED)
        return "", 1


class RateLimitError(Exception):
    """GitHub API 配额耗尽时抛出"""


def github_api_request(api_url: str) -> tuple[str, int]:
    """执行 GitHub API 请求

    使用 urllib 替代 curl，支持连接复用和 rate limit 检测。
    当 API 配额耗尽时抛出 RateLimitError。

    返回: (output, returncode)
    """
    req = urllib.request.Request(api_url)
    req.add_header("Accept", "application/vnd.github.v3+json")
    if TOKEN:
        req.add_header("Authorization", f"token {TOKEN}")

    try:
        with urllib.request.urlopen(req) as resp:
            remaining = resp.headers.get("X-RateLimit-Remaining", "")
            if remaining.isdigit() and int(remaining) < RATE_LIMIT_WARN_THRESHOLD:
                print_color(f"⚠️  API 配额剩余: {remaining}", Colors.YELLOW)
            return resp.read().decode("utf-8"), 0
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        if e.code in (403, 429):
            remaining = e.headers.get("X-RateLimit-Remaining", "")
            if remaining.isdigit() and int(remaining) == 0:
                try:
                    msg = json.loads(body).get("message", f"HTTP {e.code}")
                except json.JSONDecodeError:
                    msg = f"HTTP {e.code}"
                raise RateLimitError(f"GitHub API 配额耗尽: {msg}") from e
        return body, 1
    except urllib.error.URLError as e:
        print_color(f"❌ 网络请求失败: {e.reason}", Colors.RED)
        return "", 1


def replace_placeholders(content: str, replacements: dict[str, str]) -> str:
    """通用占位符替换函数"""
    for placeholder, value in replacements.items():
        content = content.replace(f"{{{{{placeholder}}}}}", str(value))
    return content


def update_variable_definition(content: str, var_name: str, var_value: str) -> str:
    """通用变量定义更新函数"""
    pattern = rf"({var_name} = )([^\n\r]+)"
    if re.search(pattern, content):
        content = re.sub(pattern, f"\\1{var_value}", content)
        print_color(f"✅ 已更新 {var_name} 定义为: {var_value}", Colors.GREEN)
    return content


def _parse_iso_timestamp(ts: str) -> datetime:
    """ISO 8601 时间戳解析为时区感知 datetime，解析失败返回 epoch"""
    try:
        return datetime.fromisoformat(ts)
    except (ValueError, TypeError):
        return datetime.min.replace(tzinfo=timezone.utc)


def get_current_time() -> str:
    """获取当前时间字符串"""
    china_tz = timezone(timedelta(hours=8))
    return datetime.now(china_tz).strftime(TIME_FORMAT)


def calculate_cache_statistics(cache_data: CacheData) -> tuple[int, int, int, int]:
    """计算缓存数据的统计信息

    返回: (total_commits, total_additions, total_deletions, total_images)
    """
    total_commits = 0
    total_additions = 0
    total_deletions = 0
    total_images = 0

    for commits in cache_data.values():
        commits_list: list[CommitData] = commits
        total_commits += len(commits_list)
        for commit in commits_list:
            commit_dict = cast("dict[str, str | int]", commit)
            a = commit_dict.get("additions", 0)
            d = commit_dict.get("deletions", 0)
            img = commit_dict.get("images", 0)
            total_additions += a if isinstance(a, int) else 0
            total_deletions += d if isinstance(d, int) else 0
            total_images += img if isinstance(img, int) else 0

    return total_commits, total_additions, total_deletions, total_images


def sort_and_reindex_commits(cache_data: CacheData) -> CacheData:
    """对缓存数据进行排序和重新编号"""
    sorted_cache_data: CacheData = {}

    for repo_name, commits in cache_data.items():
        # 按 timestamp 从旧到新排序（ISO 8601 时区感知比较）
        sorted_commits: list[CommitData] = sorted(
            commits,
            key=lambda x: _parse_iso_timestamp(str(x.get("timestamp", ""))),
        )

        # 重新编号 index（从 1 开始），使用浅拷贝避免修改原始数据
        sorted_cache_data[repo_name] = [
            {**commit, "index": idx}
            for idx, commit in enumerate(sorted_commits, start=1)
        ]

    return sorted_cache_data


# ============================================================================
# 缓存管理
# ============================================================================


def load_cache(repo_name: str) -> CacheData:
    """加载指定仓库的缓存数据"""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"{repo_name}.json"

    try:
        with cache_file.open(encoding="utf-8") as f:
            cache_data = json.load(f)
            print_color(f"💾 已加载缓存: {cache_file}", Colors.GREEN)

            metadata = cache_data.get("_metadata", {})
            print_color(
                f"   缓存包含 {metadata.get('total_commits', 0)} 个commits",
                Colors.NC,
            )
            return cache_data.get("data", {})
    except (OSError, json.JSONDecodeError) as e:
        print_color(f"⚠️  加载缓存失败: {e}", Colors.YELLOW)
        return {}


def _serialize_cache(data: dict[str, dict[str, int | str] | CacheData]) -> str:
    """将缓存数据序列化为紧凑 JSON 格式

    格式：metadata 和 data 键使用 2 空格缩进，
    每条 commit 记录独占一行（6 空格缩进）。
    """
    lines = ["{"]

    metadata = json.dumps(data["_metadata"], ensure_ascii=False)
    lines.append(f'  "_metadata": {metadata},')

    repo_data = cast(CacheData, data["data"])
    repo_names = list(repo_data.keys())
    for ri, repo_name in enumerate(repo_names):
        commits = repo_data[repo_name]
        if ri == 0:
            lines.append(f'  "data": {{"{repo_name}": [')
        else:
            lines.append(f'    "{repo_name}": [')
        for ci, commit in enumerate(commits):
            entry = json.dumps(commit, ensure_ascii=False)
            comma = "," if ci < len(commits) - 1 else ""
            lines.append(f"      {entry}{comma}")
        bracket_comma = "," if ri < len(repo_names) - 1 else ""
        lines.append(f"    ]{bracket_comma}")

    if not repo_names:
        lines.append('  "data": {}')
    else:
        lines.append("  }")
    lines.append("}")
    return "\n".join(lines) + "\n"


def save_cache(repo_name: str, cache_data: CacheData) -> bool:
    """保存指定仓库的缓存数据

    功能：
    - 按时间戳排序 commits（从旧到新）
    - 重新编号 commit index（从 1 开始）
    - 统计总 commits 数和总图片数
    - 保存为带 metadata 的 JSON 格式

    参数：
    - repo_name: 仓库名称
    - cache_data: 缓存数据字典

    JSON 输出格式：
    {
      "_metadata": {
        "total_commits": int,               // 总 commit 数
        "total_additions": int,             // 总新增行数
        "total_deletions": int,             // 总删除行数
        "total_images": int,                // 总图片数
        "latest_commit_timestamp": str      // 最新 commit 的时间戳
      },
      "data": { ... }                       // commit 数据
    }
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"{repo_name}.json"

    try:
        # 排序和重新编号
        sorted_cache_data = sort_and_reindex_commits(cache_data)

        # 计算统计信息
        total_commits, total_additions, total_deletions, total_images = (
            calculate_cache_statistics(sorted_cache_data)
        )

        # 取最新 commit 的时间戳（时区感知比较，排序后不一定是最后一条）
        latest_dt = datetime.min.replace(tzinfo=timezone.utc)
        latest_ts = ""
        for commits in sorted_cache_data.values():
            for c in commits:
                ts = str(c.get("timestamp", ""))
                dt = _parse_iso_timestamp(ts)
                if dt > latest_dt:
                    latest_dt = dt
                    latest_ts = ts

        metadata: dict[str, int | str] = {
            "total_commits": total_commits,
            "total_additions": total_additions,
            "total_deletions": total_deletions,
            "total_images": total_images,
            "latest_commit_timestamp": latest_ts,
        }
        cache_data_with_metadata: dict[str, dict[str, int | str] | CacheData] = {
            "_metadata": metadata,
            "data": sorted_cache_data,
        }

        serialized = _serialize_cache(cache_data_with_metadata)
        with cache_file.open("w", encoding="utf-8", newline="\n") as f:
            f.write(serialized)

        print_color(f"✅ 缓存已保存: {cache_file}", Colors.GREEN)
        print_color(f"   commits: {total_commits}", Colors.NC)
        print_color(
            f"   additions: {total_additions}  deletions: {total_deletions}  images: {total_images}",
            Colors.NC,
        )
    except (OSError, TypeError, ValueError) as e:
        print_color(f"❌ 保存缓存失败: {e}", Colors.RED)
        return False
    else:
        return True


def aggregate_stats_from_cache() -> StatsData:
    """从所有缓存文件的 _metadata 汇总统计数据

    遍历 CACHE_DIR 下每个仓库的 JSON 缓存文件，
    读取各自 _metadata 中的 total_additions / total_deletions / total_images /
    latest_commit_timestamp，累加数值并取最大时间戳后返回全局统计。
    """
    total_additions = 0
    total_deletions = 0
    total_images = 0
    latest_dt = datetime.min.replace(tzinfo=timezone.utc)
    latest_ts = ""

    if not CACHE_DIR.exists():
        return {
            "total_additions": 0,
            "total_deletions": 0,
            "total_images": 0,
            "latest_commit_timestamp": "",
        }

    latest_dt = datetime.min.replace(tzinfo=timezone.utc)
    latest_ts = ""

    for cache_file in sorted(CACHE_DIR.glob("*.json")):
        if cache_file.name == "author_identities.json":
            continue
        try:
            with cache_file.open(encoding="utf-8") as f:
                data = json.load(f)
            metadata = data.get("_metadata", {})
            if not isinstance(metadata, dict):
                continue
            meta: dict[str, int | str] = cast("dict[str, int | str]", metadata)
            a = meta.get("total_additions", 0)
            d = meta.get("total_deletions", 0)
            i = meta.get("total_images", 0)
            total_additions += a if isinstance(a, int) else 0
            total_deletions += d if isinstance(d, int) else 0
            total_images += i if isinstance(i, int) else 0
            ts = str(meta.get("latest_commit_timestamp", ""))
            dt = _parse_iso_timestamp(ts)
            if dt > latest_dt:
                latest_dt = dt
                latest_ts = ts
        except (OSError, json.JSONDecodeError):
            continue

    return {
        "total_additions": total_additions,
        "total_deletions": total_deletions,
        "total_images": total_images,
        "latest_commit_timestamp": latest_ts,
    }


def extract_sha_from_cache_item(item: CommitData) -> str:
    """从缓存项中提取SHA值"""
    url = item.get("url", "")
    if isinstance(url, str):
        return url.split("/")[-1] if url else ""
    return ""


def _extract_commit_timestamps(
    commits: list[CommitData],
) -> tuple[set[str], str, str]:
    """从 commits 提取 SHA 集合和时间戳范围

    返回: (sha_set, min_timestamp, max_timestamp)
    """
    sha_set: set[str] = set()
    min_ts = ""
    max_ts = ""

    for commit in commits:
        sha = commit.get("sha")
        if isinstance(sha, str):
            sha_set.add(sha)

        commit_dict = commit.get("commit", {})
        if isinstance(commit_dict, dict):
            author_dict = commit_dict.get("author", {})
            if isinstance(author_dict, dict):
                ts = author_dict.get("date", "")
                if ts:
                    if not min_ts or ts < min_ts:
                        min_ts = ts
                    if not max_ts or ts > max_ts:
                        max_ts = ts

    return sha_set, min_ts, max_ts


def _partition_cached_items(
    cached_items: list[CommitData],
    min_timestamp: str,
    max_timestamp: str,
    *,
    is_api_fallback: bool,
) -> tuple[list[CommitData], list[CommitData]]:
    """将缓存项分为范围内和范围外两组

    返回: (in_range_items, out_of_range_items)
    """
    in_range: list[CommitData] = []
    out_of_range: list[CommitData] = []

    for item in cached_items:
        item_ts = item.get("timestamp", "")
        if not isinstance(item_ts, str):
            in_range.append(item)
            continue
        if (
            is_api_fallback
            and min_timestamp
            and max_timestamp
            and item_ts < min_timestamp
        ):
            out_of_range.append(item)
        else:
            in_range.append(item)

    return in_range, out_of_range


def _log_cache_cleanup_mode(
    *,
    is_api_fallback: bool,
    min_timestamp: str,
    max_timestamp: str,
    out_of_range_count: int,
) -> None:
    """打印缓存清理模式信息"""
    if is_api_fallback:
        min_ts = min_timestamp[:10] if min_timestamp else "?"
        max_ts = max_timestamp[:10] if max_timestamp else "?"
        mode_desc = f"API 兜底模式（检查范围: {min_ts} ~ {max_ts}）"
        if out_of_range_count > 0:
            print_color(f"    ℹ️  {mode_desc}", Colors.NC)
            print_color(
                f"       保留 {out_of_range_count} 个超出 API 范围的老数据", Colors.NC
            )
    else:
        print_color("    ℹ️  Git log 模式（完整历史）", Colors.NC)


def clean_stale_cache(
    cache_data: CacheData,
    current_commits_with_data: list[CommitData],
    repo_key: str,
    *,
    is_api_fallback: bool = False,
) -> CacheData:
    """清理过期的缓存（检测变基等导致的commit哈希变化）

    策略：
    - Git log 模式（完整历史）：对比所有 commits，删除消失的
    - API 兜底模式：只对比 API 返回的时间戳范围内的 commits，范围外的保留

    参数：
    - current_commits_with_data: 当前数据源的 commit 对象列表（包含时间戳）
    - is_api_fallback: 是否为 API 兜底模式
    """
    if repo_key not in cache_data:
        return cache_data

    # 提取当前 commits 的 SHA 集合和时间戳范围
    current_commit_set, min_timestamp, max_timestamp = _extract_commit_timestamps(
        current_commits_with_data,
    )

    # 将缓存项分组
    cached_items_in_range, cached_items_out_of_range = _partition_cached_items(
        cache_data[repo_key],
        min_timestamp,
        max_timestamp,
        is_api_fallback=is_api_fallback,
    )

    # 获取范围内缓存的 SHA 集合
    cached_shas_in_range: set[str] = {
        sha
        for item in cached_items_in_range
        if (sha := extract_sha_from_cache_item(item))
    }

    # 找出消失的 commits
    stale_commits = cached_shas_in_range - current_commit_set

    # 打印模式信息
    _log_cache_cleanup_mode(
        is_api_fallback=is_api_fallback,
        min_timestamp=min_timestamp,
        max_timestamp=max_timestamp,
        out_of_range_count=len(cached_items_out_of_range),
    )

    # 处理过期缓存
    if stale_commits:
        print_color(
            f"    🧹 检测到 {len(stale_commits)} 个消失的commits", Colors.YELLOW
        )
        print_color("       原因：被变基、压缩或重写", Colors.YELLOW)

        # 保留范围外的 + 范围内未过期的
        new_cache_list = list(cached_items_out_of_range) + [
            item
            for item in cached_items_in_range
            if extract_sha_from_cache_item(item) not in stale_commits
        ]
        cache_data[repo_key] = new_cache_list

        print_color(
            f"    ✅ 已清除 {len(stale_commits)} 个过期的commit缓存", Colors.GREEN
        )

        if not cache_data[repo_key]:
            del cache_data[repo_key]
            print_color("    ℹ️  仓库缓存已清空", Colors.NC)
    else:
        print_color("    ✅ 缓存数据完整，无消失的commits", Colors.GREEN)

    return cache_data


# ============================================================================
# GitHub API 操作
# ============================================================================


def get_repos() -> list[RepoInfo]:
    """获取用户的所有仓库（支持分页，私有仓库需要 PAT 权限）"""
    print_color("📡 获取所有仓库列表...", Colors.YELLOW)

    repos: list[RepoInfo] = []
    page = 1
    max_pages = MAX_API_PAGES

    while page <= max_pages:
        api_url = (
            f"{GITHUB_API}/users/{ORIGIN_USERNAME}/repos"
            f"?per_page={PER_PAGE}&type=all&page={page}"
        )
        output, returncode = github_api_request(api_url)

        if returncode != 0:
            print_color("❌ 获取仓库列表失败", Colors.RED)
            return repos if repos else []

        try:
            parsed_data: list[RepoInfo] | dict[str, str] = json.loads(output)

            # 检查 API 错误响应
            if isinstance(parsed_data, dict):
                error_msg = parsed_data.get("message", "")
                if error_msg:
                    print_color(f"❌ API 错误: {error_msg}", Colors.RED)
                    return repos if repos else []
                break  # dict 但无 message，异常情况

            if not parsed_data:
                break

            for repo in parsed_data:
                repo_info: RepoInfo = repo
                repos.append(repo_info)

            print_color(f"   第 {page} 页：获取到 {len(parsed_data)} 个仓库", Colors.NC)

            if len(parsed_data) < PER_PAGE:
                break

            page += 1

        except json.JSONDecodeError as e:
            print_color(f"❌ JSON 解析失败: {e}", Colors.RED)
            print_color(f"数据内容: {output[:500]}", Colors.RED)
            return repos if repos else []

    print_color(f"✅ 获取到 {len(repos)} 个仓库", Colors.GREEN)
    for repo in repos:
        repo_name = repo.get("name", "Unknown")
        is_fork = repo.get("fork", False)
        print_color(
            f"   - {repo_name} ({'Fork' if is_fork else '原创'})",
            Colors.NC,
        )
    return repos


def get_upstream_repo(repo: RepoInfo) -> tuple[str | None, str | None]:
    """获取 fork 仓库的上游仓库信息

    注意：/users/{username}/repos 列表 API 不返回 source/parent 字段，
    需要额外调用 /repos/{owner}/{repo} 获取详情。
    """
    is_fork = repo.get("fork")
    if not isinstance(is_fork, bool) or not is_fork:
        return None, None

    # 列表 API 可能已包含 source/parent（某些情况下）
    upstream_info = repo.get("source") or repo.get("parent")

    # 如果列表 API 未返回上游信息，额外调用详情 API
    if not upstream_info:
        repo_name = repo.get("name")
        if not repo_name:
            return None, None

        api_url = f"{GITHUB_API}/repos/{ORIGIN_USERNAME}/{repo_name}"
        output, returncode = github_api_request(api_url)
        if returncode == 0:
            try:
                repo_detail = json.loads(output)
                upstream_info = repo_detail.get("source") or repo_detail.get("parent")
            except json.JSONDecodeError:
                return None, None

    if isinstance(upstream_info, dict):
        upstream_dict: dict[str, str | dict[str, str]] = cast(
            "dict[str, str | dict[str, str]]",
            upstream_info,
        )
        owner_dict = upstream_dict.get("owner")
        if isinstance(owner_dict, dict):
            upstream_owner = owner_dict.get("login")
            upstream_name = upstream_dict.get("name")
            if isinstance(upstream_owner, str) and isinstance(upstream_name, str):
                print_color(
                    f"    📡 检测到上游仓库: {upstream_owner}/{upstream_name}",
                    Colors.NC,
                )
                return upstream_owner, upstream_name
    return None, None


# ============================================================================
# Commits 数据获取
# ============================================================================


def get_commits_from_git_log(
    repo_path: str,
    default_branch: str,
) -> list[CommitData] | None:
    """从本地 git log 获取用户的所有 commits（完整历史）

    作者匹配：仅使用 API 学习到的完整身份 "Name <email>"
    这确保只匹配属于用户的 commits，防止同名冒充

    返回包含 sha 和 commit.author.date 的完整结构，方便时间戳比较
    """
    # 仅使用已知身份（从 API 自动学习的 "Name <email>" 格式）
    # 不使用单独的用户名，防止同名冒充
    if not KNOWN_AUTHOR_IDENTITIES:
        print_color("    ⚠️  没有已知作者身份，需要先从 API 学习", Colors.YELLOW)
        return None

    authors = KNOWN_AUTHOR_IDENTITIES
    print_color(f"    ℹ️  使用 {len(authors)} 个作者身份匹配", Colors.NC)

    # 使用集合去重（避免同一 commit 被多次匹配）
    all_shas: set[str] = set()
    all_commits: list[CommitData] = []

    for author in authors:
        safe_author = author.replace('"', '\\"')
        git_cmd = [
            "git",
            "log",
            f"origin/{default_branch}",
            f"--author={safe_author}",
            "--format=%H%n%aI",
        ]
        output, returncode = run_command(git_cmd, cwd=repo_path)

        if returncode != 0:
            continue

        lines = [line.strip() for line in output.split("\n") if line.strip()]

        # 每两行为一对：SHA 和 ISO 时间戳
        for i in range(0, len(lines), 2):
            if i + 1 < len(lines):
                sha = lines[i]
                iso_date = lines[i + 1]

                # 跳过已添加的 commit（去重）
                if sha in all_shas:
                    continue
                all_shas.add(sha)

                # 构建与 API 兼容的结构
                commit_obj: CommitData = {
                    "sha": sha,
                    "commit": {"author": {"date": iso_date}},
                }
                all_commits.append(commit_obj)

    if all_commits:
        print_color(
            f"    ℹ️  git log 获取 {len(all_commits)} 个commits",
            Colors.NC,
        )
        return all_commits
    print_color("    ⚠️  git log 失败", Colors.YELLOW)
    return None


def get_commits_from_api(
    owner: str,
    repo_name: str,
    username: str,
    default_branch: str = "main",
    max_pages: int = MAX_API_PAGES,
) -> list[CommitData]:
    """从 GitHub API 获取用户的最近 commits（分页，最多 10 页）

    仅作为 git log 失败时的兜底方案
    注意: API 有分页限制，超出范围的老 commits 将保留缓存
    """
    page = 1
    per_page = PER_PAGE
    all_commits: list[CommitData] = []

    while page <= max_pages:
        api_url = (
            f"{GITHUB_API}/repos/{owner}/{repo_name}/commits"
            f"?author={username}&sha={default_branch}"
            f"&per_page={per_page}&page={page}"
        )
        print_color(f"    🔍 API 获取commits (第{page}页)...", Colors.NC)

        output, returncode = github_api_request(api_url)

        if returncode != 0:
            print_color("    ❌ API调用失败", Colors.RED)
            return all_commits if all_commits else []

        try:
            parsed_commits: list[
                dict[str, str | int | FileData | CommitDetailData | list[FileData]]
            ] = json.loads(output)
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
        print_color(
            f"    ℹ️  已达到最大页数限制 ({max_pages} 页)，"
            f"共 {len(all_commits)} 个commits",
            Colors.NC,
        )

    return all_commits


# ============================================================================
# Commits 分析
# ============================================================================


def _fetch_commits_with_fallback(
    ctx: RepoContext,
    default_branch: str,
) -> tuple[list[CommitData], bool]:
    """获取 commits，Git log 优先，API 兜底

    因为 Fork 仓库直接克隆的是上游仓库，所以统一从 origin 获取即可。

    返回: (commits, is_api_fallback)
    """
    # 每个仓库都尝试学习身份（每次只 1 次 API 调用）
    new_identities = learn_author_identities_from_api(
        ctx.owner, ctx.repo_name, ctx.username
    )
    if new_identities:
        old_count = len(KNOWN_AUTHOR_IDENTITIES)
        KNOWN_AUTHOR_IDENTITIES.update(new_identities)
        if len(KNOWN_AUTHOR_IDENTITIES) > old_count:
            print_color(
                f"    ✅ 发现新身份，共 {len(KNOWN_AUTHOR_IDENTITIES)} 个",
                Colors.GREEN,
            )
            save_author_identities(KNOWN_AUTHOR_IDENTITIES)

    # 1. 优先尝试从本地 git log 获取（使用已学习的身份）
    if ctx.repo_path:
        commits = get_commits_from_git_log(ctx.repo_path, default_branch)
        if commits:
            print_color(
                f"    ✅ 使用 Git log（完整历史）: {len(commits)} 个commits",
                Colors.GREEN,
            )
            return commits, False

    # 2. Git log 失败时，使用 API 兜底
    print_color("    ⚠️  Git log 无数据，尝试 API 兜底...", Colors.YELLOW)

    api_commits = get_commits_from_api(
        ctx.owner, ctx.repo_name, ctx.username, default_branch
    )

    if api_commits:
        print_color(
            f"    ✅ 使用 API 兜底数据: {len(api_commits)} 个commits", Colors.GREEN
        )
        print_color(
            "    ⚠️  注意: API 有分页限制，超出范围的老数据将保留缓存", Colors.YELLOW
        )
        return api_commits, True

    return [], False


def _get_commit_details_from_git(
    repo_path: str,
    sha: str,
) -> CommitData:
    """从本地 git 获取 commit 详情（文件状态 + 增删行数）

    注意：--name-status 和 --shortstat 是互斥的 diff 输出格式，
    合并使用时后者会被忽略。因此拆成两条 git 命令分别获取。
    """
    commit_data: CommitData = {"files": [], "stats": {"additions": 0, "deletions": 0}}

    # 命令 1：--shortstat 获取增删行数汇总
    output, rc = run_command(
        ["git", "show", "--shortstat", "--pretty=format:", sha], cwd=repo_path
    )
    if rc == 0:
        for line in output.split("\n"):
            stripped = line.strip()
            if not stripped:
                continue
            # "3 files changed, 10 insertions(+), 5 deletions(-)"
            if "changed" in stripped and (
                "insertion" in stripped or "deletion" in stripped
            ):
                ins_match = re.search(r"(\d+) insertion", stripped)
                del_match = re.search(r"(\d+) deletion", stripped)
                stat_dict = cast("dict[str, int]", commit_data.get("stats", {}))
                if ins_match:
                    stat_dict["additions"] = int(ins_match.group(1))
                if del_match:
                    stat_dict["deletions"] = int(del_match.group(1))
                break

    # 命令 2：--name-status 获取文件状态（用于图片计数）
    output, rc = run_command(
        ["git", "show", "--name-status", "--pretty=format:", sha], cwd=repo_path
    )
    if rc == 0:
        for line in output.split("\n"):
            parts = line.split("\t")
            if len(parts) >= MIN_STATUS_PARTS:
                status_code = parts[0].rstrip("0123456789")  # R100->R, C100->C
                if status_code in ("R", "C") and len(parts) >= 3:
                    filename = parts[2]
                    status = "added" if status_code == "C" else "modified"
                else:
                    filename = parts[1]
                    status = "added" if parts[0] == "A" else "modified"
                files = commit_data.get("files", [])
                if isinstance(files, list):
                    files.append({"filename": filename, "status": status})

    return commit_data


def _get_commit_details_from_api(owner: str, repo_name: str, sha: str) -> CommitData:
    """从 API 获取 commit 详情"""
    api_url = f"{GITHUB_API}/repos/{owner}/{repo_name}/commits/{sha}"
    output, returncode = github_api_request(api_url)
    if returncode == 0:
        try:
            return json.loads(output)
        except json.JSONDecodeError:
            pass
    return {}


def _calculate_commit_stats(
    commit_data: CommitData,
    *,
    include_images: bool,
) -> tuple[int, int, int]:
    """计算单个 commit 的统计数据

    返回: (additions, deletions, images)
    """
    # 提取增删行数（git --shortstat 或 API stats 字段）
    stats = commit_data.get("stats", {})
    additions = 0
    deletions = 0
    if isinstance(stats, dict):
        a = stats.get("additions", 0)
        d = stats.get("deletions", 0)
        additions = a if isinstance(a, int) else 0
        deletions = d if isinstance(d, int) else 0

    # 统计图片（仅 status=added 的图片文件）
    images = 0
    if include_images:
        files_list = commit_data.get("files", [])
        if isinstance(files_list, list):
            for file in files_list:
                if file.get("status") == "added":
                    filename = file.get("filename", "")
                    if isinstance(filename, str) and is_image_file(filename):
                        images += 1

    return additions, deletions, images


def _get_commit_timestamp(commit: CommitData) -> str:
    """从 commit 获取时间戳"""
    commit_dict = commit.get("commit", {})
    if isinstance(commit_dict, dict):
        author_dict = commit_dict.get("author", {})
        if isinstance(author_dict, dict):
            ts = author_dict.get("date", "")
            if ts:
                return ts
    return datetime.now(tz=timezone.utc).isoformat()


def analyze_commits(
    ctx: RepoContext,
    *,
    include_images: bool = True,
) -> None:
    """分析代码贡献并保存缓存

    数据获取策略：
    - Fork 仓库：直接克隆上游仓库，从 origin 获取 Git log（完整历史）
    - 非 Fork 仓库：克隆自己的仓库，从 origin 获取 Git log（完整历史）
    - API 仅在 git log 失败时兜底（有分页限制）

    结果写入缓存文件，由 aggregate_stats_from_cache() 汇总。
    """
    print_color("    📊 开始分析commits...", Colors.YELLOW)

    # 加载缓存
    cache_data = load_cache(ctx.repo_name)

    # 获取默认分支
    default_branch = "main"
    if ctx.repo_path:
        git_cmd = "git symbolic-ref refs/remotes/origin/HEAD"
        output, returncode = run_command(git_cmd, cwd=ctx.repo_path)
        if returncode == 0:
            default_branch = output.strip().removeprefix("refs/remotes/origin/")
        else:
            default_branch = "main"
        print_color(f"    ℹ️  默认分支: {default_branch}", Colors.NC)

    # 获取 commits（Git log 优先，API 兜底）
    all_commits, is_api_fallback = _fetch_commits_with_fallback(ctx, default_branch)

    if not all_commits:
        print_color("    ℹ️  未找到commits", Colors.NC)
        return

    total_commits = len(all_commits)
    print_color(f"    📊 最终使用 {total_commits} 个commits", Colors.NC)

    # 清理过期缓存（消失的 SHA 删除）
    cache_data = clean_stale_cache(
        cache_data,
        all_commits,
        ctx.repo_name,
        is_api_fallback=is_api_fallback,
    )

    # 处理所有 commits（不变的跳过，新的/旧格式的重新获取）
    total_additions, total_deletions, total_images, cache_hits, cache_misses = (
        _process_all_commits(
            all_commits=all_commits,
            cache_data=cache_data,
            ctx=ctx,
            include_images=include_images,
        )
    )

    # 显示统计信息
    _print_cache_stats(cache_hits, cache_misses, total_commits)
    print_stats_summary(
        total_additions,
        total_deletions,
        total_images,
        include_images=include_images,
        prefix="    ",
    )

    # 保存缓存（累加写入文件头 _metadata）
    save_cache(ctx.repo_name, cache_data)


def _process_all_commits(
    *,
    all_commits: list[CommitData],
    cache_data: CacheData,
    ctx: RepoContext,
    include_images: bool,
) -> tuple[int, int, int, int, int]:
    """处理所有 commits 并统计

    返回: (total_additions, total_deletions, total_images, cache_hits, cache_misses)
    """
    total_additions = 0
    total_deletions = 0
    total_images = 0
    cache_hits = 0
    cache_misses = 0
    processed = 0
    total_commits = len(all_commits)

    # 构建缓存索引 O(1) 查找
    cache_index: dict[str, CommitData] = {}
    for item in cache_data.get(ctx.repo_name, []):
        url = item.get("url")
        if isinstance(url, str):
            cache_index[url] = item

    for commit in all_commits:
        sha = commit.get("sha")
        if not sha or not isinstance(sha, str):
            continue

        processed += 1
        if processed % PROGRESS_INTERVAL == 0:
            pct = processed * 100 // total_commits
            print_color(
                f"    📊 处理中: {processed}/{total_commits} ({pct}%)", Colors.NC
            )

        commit_url = f"https://github.com/{ctx.owner}/{ctx.repo_name}/commit/{sha}"
        cached_entry = cache_index.get(commit_url)

        # 缓存命中：旧格式（无 additions 字段）视为未命中
        if cached_entry and "additions" in cached_entry:
            a = cached_entry.get("additions", 0)
            d = cached_entry.get("deletions", 0)
            total_additions += a if isinstance(a, int) else 0
            total_deletions += d if isinstance(d, int) else 0
            if include_images:
                img = cached_entry.get("images", 0)
                total_images += img if isinstance(img, int) else 0
            cache_hits += 1
            continue

        # 缓存未命中，获取详情
        cache_misses += 1
        if ctx.repo_path:
            commit_data = _get_commit_details_from_git(ctx.repo_path, sha)
        else:
            commit_data = _get_commit_details_from_api(ctx.owner, ctx.repo_name, sha)

        # 计算统计
        additions, deletions, images = _calculate_commit_stats(
            commit_data, include_images=include_images
        )
        total_additions += additions
        total_deletions += deletions
        total_images += images

        # 更新缓存（--no-images 模式下不写入缓存，避免污染）
        if not include_images:
            continue
        if ctx.repo_name not in cache_data:
            cache_data[ctx.repo_name] = []

        # 移除旧格式缓存条目（如果存在）
        if cached_entry:
            cache_data[ctx.repo_name] = [
                c for c in cache_data[ctx.repo_name] if c.get("url") != commit_url
            ]

        cache_data[ctx.repo_name].append(
            {
                "index": processed,
                "additions": additions,
                "deletions": deletions,
                "images": images,
                "timestamp": _get_commit_timestamp(commit),
                "url": commit_url,
            }
        )

    return total_additions, total_deletions, total_images, cache_hits, cache_misses


def _print_cache_stats(cache_hits: int, cache_misses: int, total_commits: int) -> None:
    """打印缓存统计信息"""
    print_color("    💾 缓存统计:", Colors.YELLOW)
    print_color(f"       - 缓存命中: {cache_hits} 个commit", Colors.NC)
    print_color(f"       - 缓存未命中: {cache_misses} 个commit", Colors.NC)
    if total_commits > 0:
        cache_hit_rate = cache_hits / total_commits * 100
        print_color(f"       - 缓存命中率: {cache_hit_rate:.1f}%", Colors.NC)


# ============================================================================
# 仓库处理
# ============================================================================


def process_repos(repos: list[RepoInfo], *, include_images: bool = True) -> None:
    """处理所有仓库：克隆 → 分析 → 保存缓存

    最终统计由 aggregate_stats_from_cache() 从缓存文件汇总，
    本函数仅负责处理和保存每个仓库的缓存。

    Args:
        repos: 仓库列表
        include_images: 是否统计图片贡献
    """
    print_separator("开始处理仓库...")

    temp_dir = Path.cwd() / "temp_repos"
    temp_dir.mkdir(parents=True, exist_ok=True)

    try:
        for repo in repos:
            repo_name = repo.get("name")
            repo_url = repo.get("html_url")
            is_fork = repo.get("fork", False)

            if not repo_name or not repo_url:
                continue

            print_separator(f"📦 仓库: {repo_name}", Colors.YELLOW)
            print_color("  URL: " + str(repo_url), Colors.NC)
            print_color(
                "  类型: " + ("Fork 仓库" if is_fork else "原创仓库"), Colors.NC
            )

            # 确定要克隆的仓库（Fork 仓库直接克隆上游）
            upstream_owner, upstream_name = get_upstream_repo(repo)
            if upstream_owner and upstream_name:
                clone_owner = upstream_owner
                clone_repo_name = upstream_name
                target_repo_name = upstream_name
                clone_url = (
                    f"https://{TOKEN}@github.com/{upstream_owner}/{upstream_name}.git"
                )
                print_color(
                    f"  📡 直接克隆上游仓库: {upstream_owner}/{upstream_name}",
                    Colors.NC,
                )
            else:
                clone_owner = ORIGIN_USERNAME
                clone_repo_name = str(repo_name)
                target_repo_name = str(repo_name)
                clone_url = str(repo_url).replace(
                    "https://github.com/",
                    f"https://{TOKEN}@github.com/",
                )

            # 克隆仓库到临时目录
            repo_path = temp_dir / clone_repo_name
            if repo_path.exists():
                print_color("  🔄 更新本地仓库...", Colors.YELLOW)
                _, rc = run_command(
                    "git fetch --unshallow origin",
                    cwd=str(repo_path),
                )
                if rc != 0:
                    run_command("git fetch origin", cwd=str(repo_path))
            else:
                print_color("  📥 克隆仓库...", Colors.YELLOW)
                _, returncode = run_command(
                    f"git clone --no-single-branch {clone_url}",
                    cwd=str(temp_dir),
                )
                if returncode != 0 or not repo_path.exists():
                    print_color("  ⚠️  克隆仓库失败，跳过", Colors.YELLOW)
                    continue

            ctx = RepoContext(
                repo_path=str(repo_path),
                owner=clone_owner,
                repo_name=target_repo_name,
                username=ORIGIN_USERNAME,
            )

            # 分析代码贡献（结果写入缓存文件）
            analyze_commits(ctx, include_images=include_images)
    finally:
        print_color("\n  🧹 清理临时文件...", Colors.YELLOW)
        if temp_dir.exists():
            try:
                shutil.rmtree(temp_dir)
            except OSError as e:
                print_color(f"  ⚠️  清理临时目录失败: {e}", Colors.YELLOW)


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
    content = update_variable_definition(content, "ORIGIN_USERNAME", ORIGIN_USERNAME)
    content = update_variable_definition(
        content,
        "UPSTREAM_USERNAME",
        UPSTREAM_USERNAME,
    )

    # 智能替换占位符
    placeholder_count = content.count("{{ORIGIN_USERNAME}}") + content.count(
        "{{UPSTREAM_USERNAME}}",
    )

    if placeholder_count > 0:
        # 发现占位符，进行替换
        replacements = {
            "ORIGIN_USERNAME": ORIGIN_USERNAME,
            "UPSTREAM_USERNAME": UPSTREAM_USERNAME,
        }
        content = replace_placeholders(content, replacements)
        print_color(f"✅ 已替换 {placeholder_count} 个占位符为真实用户名", Colors.GREEN)
    else:
        # 没有占位符，说明已经是真实用户名了
        print_color("ℹ️  未发现占位符，内容已包含真实用户名", Colors.YELLOW)

    return content


def generate_readme_from_template(template_path: Path, *, mode: str = "actions") -> str:
    """从模板生成 README 内容"""
    with template_path.open(encoding="utf-8") as f:
        content = f.read()

    # 根据模式选择贡献卡片来源
    if mode == "actions":
        card_src = "contributions.svg"
    else:
        card_src = (
            f"https://usagi-wusaqi.vercel.app/api/contributions"
            f"?username={ORIGIN_USERNAME}"
            f"&hide_border=true&custom_title=Code%20Contributions&cache_seconds=86400"
        )

    # 准备替换数据
    replacements = {
        "ORIGIN_USERNAME": ORIGIN_USERNAME,
        "UPSTREAM_USERNAME": UPSTREAM_USERNAME,
        "CONTRIBUTIONS_CARD_SRC": card_src,
    }

    # 替换所有占位符
    content = replace_placeholders(content, replacements)
    print_color("✅ 已从模板生成完整的 README", Colors.GREEN)

    return content


def update_existing_readme(content: str) -> str:
    """更新现有 README 内容（回退路径：仅更新用户名）"""
    return update_usernames_in_readme(content)


def save_readme_content(content: str) -> bool:
    """保存 README 内容到文件"""
    try:
        with README_FILE_PATH.open("w", encoding="utf-8", newline="\n") as f:
            f.write(content)
    except OSError as e:
        print_color(f"❌ 保存 README 失败: {e}", Colors.RED)
        return False
    else:
        return True


def print_update_summary(stats: StatsData) -> None:
    """打印更新结果摘要"""
    add = int(stats.get("total_additions", 0))
    dele = int(stats.get("total_deletions", 0))
    imgs = int(stats.get("total_images", 0))
    latest_ts = stats.get("latest_commit_timestamp", "")
    net = add - dele
    net_sign = "+" if net >= 0 else ""
    print_color("✅ README.md 更新成功！", Colors.GREEN)
    print_color(f"   ✍️  +{add:,} / -{dele:,} (net {net_sign}{net:,})", Colors.NC)
    print_color(f"   🖼️  图片数量: {imgs:,}", Colors.NC)
    print_color(f"   🕒 最新 commit: {latest_ts}", Colors.NC)
    print_color(f"   👤 远端用户名: {ORIGIN_USERNAME}", Colors.NC)
    print_color(f"   👑 上游用户名: {UPSTREAM_USERNAME}", Colors.NC)


def save_stats_json(stats: StatsData) -> None:
    """输出 stats.json 供 Vercel Serverless Function 读取

    last_updated 使用最新 commit 的时间戳（而非脚本运行时间），
    这样没有新代码时文件内容不变 → git 无 diff → 不产生空提交。
    """
    latest_ts = stats.get("latest_commit_timestamp", "")
    # 统一用 ISO 8601 格式；无 commit 时回退到当前时间的 ISO 格式
    if latest_ts:
        last_updated = str(latest_ts)
    else:
        last_updated = datetime.now(tz=timezone(timedelta(hours=8))).isoformat()

    comment = "generate-stats.py 自动生成。Vercel API 读取 total_images；Actions SVG 读取全部字段"
    try:
        with STATS_JSON_PATH.open("w", encoding="utf-8", newline="\n") as f:
            # 第一行：_comment（静态）；第二行：数据字段（动态，git diff 只变这行）
            f.write('{"_comment":' + json.dumps(comment, ensure_ascii=False) + ",\n")
            rest: dict[str, int | str] = {
                "total_additions": stats.get("total_additions", 0),
                "total_deletions": stats.get("total_deletions", 0),
                "total_images": stats.get("total_images", 0),
                "last_updated": last_updated,
            }
            f.write(
                json.dumps(rest, ensure_ascii=False, separators=(",", ":"))[1:] + "\n"
            )
        print_color(f"✅ stats.json 已更新: {STATS_JSON_PATH}", Colors.GREEN)
    except OSError as e:
        print_color(f"⚠️  保存 stats.json 失败: {e}", Colors.RED)


def _read_current_stats() -> StatsData | None:
    """从 stats.json 中读取当前的统计数字

    返回: 包含统计数据的字典，或 None
    """
    if not STATS_JSON_PATH.exists():
        return None

    try:
        with STATS_JSON_PATH.open(encoding="utf-8") as f:
            data = json.load(f)
        if "total_images" in data:
            return {
                "total_additions": int(data.get("total_additions", 0)),
                "total_deletions": int(data.get("total_deletions", 0)),
                "total_images": int(data["total_images"]),
            }
    except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError):
        pass

    return None


def update_readme(stats: StatsData, *, mode: str = "actions") -> bool:
    """更新 README.md（支持模板系统）

    功能：
    - 如果存在 README.template.md，从模板生成完整的 README
    - 如果不存在模板，仅更新现有 README 中的用户名

    注意：变更检测已由 main() 完成，本函数无条件执行更新。

    参数：
    - stats: 统计数据字典
    - mode: 运行模式 (actions/api)
    """
    print_color("📝 更新 README.md...", Colors.YELLOW)

    template_path = Path(__file__).parent.parent / "README.template.md"

    if template_path.exists():
        # 使用模板系统
        print_color("📄 使用模板系统生成 README", Colors.GREEN)
        content = generate_readme_from_template(template_path, mode=mode)
    else:
        # 回退：仅更新用户名
        print_color("⚠️  未发现模板文件，更新现有 README", Colors.YELLOW)

        if not README_FILE_PATH.exists():
            print_color("❌ README.md 不存在！", Colors.RED)
            return False

        # 读取现有 README.md
        with README_FILE_PATH.open(encoding="utf-8") as f:
            existing_content = f.read()

        content = update_existing_readme(existing_content)

    # 保存 README.md
    if not save_readme_content(content):
        return False

    # 显示更新结果
    print_update_summary(stats)
    return True


# ============================================================================
# SVG 卡片生成（Actions 模式）
# ============================================================================

SVG_CARD_PATH = Path(__file__).parent.parent / "contributions.svg"


def _format_number(num: int) -> str:
    """千分位格式化数字"""
    return f"{num:,}"


def _escape_html(text: str) -> str:
    """HTML 转义"""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def generate_contributions_svg(
    stats: StatsData,
    display_name: str,
    *,
    custom_title: str | None = None,
    title_color: str = "#2f80ed",
    text_color: str = "#434d58",
    bg_color: str = "#fffefe",
    border_color: str = "#e4e2e2",
) -> str:
    """生成贡献统计 SVG 卡片（与 Vercel 版本 renderContributionsCard 对齐）"""
    additions = int(stats.get("total_additions", 0))
    deletions = int(stats.get("total_deletions", 0))
    images = int(stats.get("total_images", 0))
    net = additions - deletions
    net_sign = "+" if net >= 0 else ""
    add_color = "#28a745"
    del_color = "#d73a49"
    net_color = add_color if net >= 0 else del_color
    img_color = "#6f42c1"

    if custom_title is not None:
        title_text = _escape_html(custom_title)
    else:
        suffix = "" if _escape_html(display_name).rstrip().endswith("s") else "s"
        title_text = f"{_escape_html(display_name)}&apos;{suffix} Code Contributions"

    width = 1200
    height = 200
    padding = 67
    title_y = 70
    stats_y = 120
    value_gap = 36
    col_width = (width - padding) // 4

    return f"""\
<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" fill="none" role="img">
  <style>
    .header {{ font: 600 48px 'Segoe UI', Ubuntu, Sans-Serif; fill: {title_color}; }}
    @supports(-moz-appearance: auto) {{ .header {{ font-size: 41px; }} }}
    .stat {{ font: 600 20px 'Segoe UI', Ubuntu, "Helvetica Neue", Sans-Serif; fill: {text_color}; }}
    .bold {{ font: 700 36px 'Segoe UI', Ubuntu, "Helvetica Neue", Sans-Serif; }}
  </style>
  <rect x="0.5" y="0.5" width="{width - 1}" height="{height - 1}" rx="4.5" fill="{bg_color}" stroke="{border_color}" stroke-width="1"/>
  <text x="{padding}" y="{title_y}" class="header">{title_text}</text>
  <g transform="translate({padding}, {stats_y})">
    <text x="0" y="0" class="stat">Additions</text>
    <text x="0" y="{value_gap}" class="stat bold" style="fill:{add_color}">+{_format_number(additions)}</text>
  </g>
  <g transform="translate({padding + col_width}, {stats_y})">
    <text x="0" y="0" class="stat">Deletions</text>
    <text x="0" y="{value_gap}" class="stat bold" style="fill:{del_color}">-{_format_number(deletions)}</text>
  </g>
  <g transform="translate({padding + col_width * 2}, {stats_y})">
    <text x="0" y="0" class="stat">Net</text>
    <text x="0" y="{value_gap}" class="stat bold" style="fill:{net_color}">{net_sign}{_format_number(net)}</text>
  </g>
  <g transform="translate({padding + col_width * 3}, {stats_y})">
    <text x="0" y="0" class="stat">Images</text>
    <text x="0" y="{value_gap}" class="stat bold" style="fill:{img_color}">{_format_number(images)}</text>
  </g>
</svg>"""


def save_contributions_svg(stats: StatsData, *, custom_title: str | None = None) -> bool:
    """生成并保存贡献统计 SVG 卡片"""
    display_name = ORIGIN_USERNAME
    svg_content = generate_contributions_svg(stats, display_name, custom_title=custom_title)
    try:
        with SVG_CARD_PATH.open("w", encoding="utf-8", newline="\n") as f:
            f.write(svg_content)
            f.write("\n")
        print_color(f"✅ SVG 卡片已生成: {SVG_CARD_PATH}", Colors.GREEN)
    except OSError as e:
        print_color(f"❌ 保存 SVG 失败: {e}", Colors.RED)
        return False
    else:
        return True


# ============================================================================
# 主函数
# ============================================================================


def main() -> int:
    """主函数"""
    parser = argparse.ArgumentParser(description="生成 GitHub 统计")
    parser.add_argument("--no-images", action="store_true", help="不统计图片贡献")
    parser.add_argument("--custom-title", default=None, help="自定义 SVG 卡片标题（默认带用户名）")
    parser.add_argument("--clear-cache", action="store_true", help="清除缓存文件")
    parser.add_argument(
        "--mode",
        choices=["actions", "api"],
        default="actions",
        help="运行模式: actions=生成本地SVG+更新README, api=仅stats.json供Vercel读取+更新README (默认: actions)",
    )
    args = parser.parse_args()

    print_separator("🚀 开始生成 GitHub 统计...")
    print_color("📊 统计配置:", Colors.YELLOW)
    print_color(f"   - 运行模式: {args.mode}", Colors.NC)
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

    # 加载已知作者身份（后续处理仓库时会增量学习新身份）
    KNOWN_AUTHOR_IDENTITIES.clear()
    KNOWN_AUTHOR_IDENTITIES.update(load_author_identities())

    # 获取仓库列表
    repos = get_repos()
    if not repos:
        print_color("⚠️  没有找到仓库", Colors.YELLOW)
        return 1

    # 处理仓库（克隆 → 分析 → 保存缓存）
    try:
        process_repos(repos, include_images=not args.no_images)
    except RateLimitError as e:
        print_color(f"❌ {e}", Colors.RED)
        return 1

    # 从所有缓存文件的 _metadata 汇总统计
    stats = aggregate_stats_from_cache()
    add = int(stats.get("total_additions", 0))
    dele = int(stats.get("total_deletions", 0))
    imgs = int(stats.get("total_images", 0))
    net = add - dele
    net_sign = "+" if net >= 0 else ""
    print_separator("📈 汇总统计（来自缓存文件 _metadata）")
    print_color(f"  ✍️  +{add:,} / -{dele:,} (net {net_sign}{net:,})", Colors.GREEN)
    print_color(f"  🖼️  总 images: {imgs:,}", Colors.GREEN)
    print_separator()

    # 先读旧数据做变更检测（必须在 save_stats_json 之前）
    old_stats = _read_current_stats()
    stats_changed = old_stats is None or any(
        old_stats.get(k) != stats.get(k, 0)
        for k in ("total_additions", "total_deletions", "total_images")
    )

    if not stats_changed:
        print_color("ℹ️  统计数据未变化，跳过全部更新", Colors.YELLOW)
    else:
        # 写入 stats.json（last_updated = 最新 commit 时间戳）
        save_stats_json(stats)

        # Actions 模式：从 stats 数据生成本地 SVG 卡片
        if args.mode == "actions" and not save_contributions_svg(stats, custom_title=args.custom_title):
            return 1

        # 更新 README.md
        if not update_readme(stats, mode=args.mode):
            return 1

    print_separator("✅ 脚本执行完成！")
    return 0


if __name__ == "__main__":
    sys.exit(main())

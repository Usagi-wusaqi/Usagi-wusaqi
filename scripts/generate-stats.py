#!/usr/bin/env python3
"""GitHub Contributions Statistics Script

## 核心功能
- 统计所有仓库的图片贡献（images 数量）
- 智能缓存系统，避免重复分析已处理的 commits
- 支持 Fork 仓库（直接克隆上游仓库获取完整历史）
- 从模板生成 README.md，直接生成 SVG 卡片

## 数据源策略
- Git log 优先：完整历史数据，准确可靠
- API 仅兜底：仅在 git log 失败时使用（有分页限制，最多 1000 条）

## Fork 仓库处理
- 直接克隆上游仓库（不是 Fork 仓库本身）
- 从 origin 获取 Git log，保证获取完整的 commit 历史

## 缓存清理策略
- Git log 模式：对比所有 commits，删除消失的（被变基/压缩/重写）
- API 兜底模式：只对比 API 时间戳范围内的 commits，范围外的老数据保留
- 仓库列表清理：删除当前列表中已经不存在的仓库缓存文件

## 缓存机制
每个仓库一个 JSON 文件，包含：
- 元数据：总 commits 数、总 images 数
- 详细数据：每个 commit 的统计数据

## 更新策略
- 只有运行脚本时才更新数据
- 从模板生成 README，替换用户名占位符
- 永久保存历史数据，智能清理过期缓存
"""

# tomllib 返回 dict[str, Any]，嵌套 .get() 会级联产生 Unknown 类型警告，
# 以下三条指令分别抑制：成员访问 → 变量赋值 → 函数传参 三阶段的噪声。
# pyright: reportUnknownMemberType=false
# pyright: reportUnknownVariableType=false
# pyright: reportUnknownArgumentType=false

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import cast

import tomllib

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

# ---------- 路径（与脚本位置绑定，不可配置） ----------
README_FILE_PATH = Path(__file__).parent.parent / "README.md"
CONFIG_TOML_PATH = Path(__file__).parent.parent / "config.toml"
CACHE_DIR = Path(__file__).parent / "stats_cache"
GITHUB_WEB_BASE_URL = "https://github.com"

# Git 解析常量（内部使用）
MIN_STATUS_PARTS = 2  # git show --name-status 输出至少需要的字段数

# 运行时配置（main() 启动时从 config.toml 加载）
cfg = {}


@dataclass
class RuntimeConfig:
    """运行时常量（由 _apply_config() 从 config.toml 加载）"""

    github_api: str = ""
    separator_length: int = 0
    max_api_pages: int = 0
    per_page: int = 0
    rate_limit_warn_threshold: int = 0
    progress_interval: int = 0
    image_extensions: list[str] = field(default_factory=list)
    time_format: str = ""


rc = RuntimeConfig()


# ============================================================================
# 配置加载
# ============================================================================


def _load_config():
    """从 config.toml 加载配置

    config.toml 是所有可配置项的唯一来源。如果不存在，返回空字典。
    """
    if CONFIG_TOML_PATH.exists():
        try:
            with CONFIG_TOML_PATH.open("rb") as f:
                return tomllib.load(f)
        except (OSError, tomllib.TOMLDecodeError):
            pass
    return tomllib.loads("")


def _update_toml_values(content: str, updates: dict[str, str | int]) -> str:
    """正则原地替换 TOML 文件中的键值对（保留注释和格式）"""
    for key, value in updates.items():
        value_str = f'"{value}"' if isinstance(value, str) else str(value)
        new_content = re.sub(
            rf"^({re.escape(key)}\s*=\s*).*$",
            rf"\g<1>{value_str}",
            content,
            count=1,
            flags=re.MULTILINE,
        )
        if new_content == content:
            print(f"⚠️  config.toml 中未找到键 '{key}'，跳过更新")
        content = new_content
    return content


def _apply_config() -> None:
    """用 cfg 中的值刷新 rc（RuntimeConfig），供全局引用"""
    api = cfg.get("api", {})
    rc.github_api = api.get("github_api_base", "")
    rc.max_api_pages = api.get("max_api_pages", 0)
    rc.per_page = api.get("per_page", 0)
    rc.rate_limit_warn_threshold = api.get("rate_limit_warn_threshold", 0)

    beh = cfg.get("behavior", {})
    rc.separator_length = beh.get("separator_length", 0)
    rc.image_extensions = beh.get("image_extensions", [])
    rc.progress_interval = beh.get("progress_interval", 10) or 10

    # time_format 由 timezone_offset_hours 派生
    tz_hours = beh.get("timezone_offset_hours", 8)
    tz_label = f"UTC+{tz_hours}" if tz_hours >= 0 else f"UTC{tz_hours}"
    rc.time_format = f"%Y-%m-%d %H:%M:%S {tz_label}"


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
    """从 cfg 中加载已知的作者身份列表

    存储格式: config.toml → author_identities (Base64 编码的 JSON)
    """
    raw_data = cfg.get("author_identities", "")
    if not raw_data:
        return set()

    try:
        decoded_bytes = base64.b64decode(raw_data)
        data = json.loads(decoded_bytes.decode("utf-8"))
        identities = set(data.get("identities", []))
        if identities:
            print_color(f"💾 已加载 {len(identities)} 个已知作者身份", Colors.GREEN)
        return identities
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as e:
        print_color(f"⚠️  加载作者身份失败: {e}", Colors.YELLOW)
        return set()


def save_author_identities(identities: set[str]) -> None:
    """保存作者身份列表到 config.toml（Base64 编码）"""
    try:
        data = {"identities": sorted(identities)}
        json_str = json.dumps(data, ensure_ascii=False)
        encoded_data = base64.b64encode(json_str.encode("utf-8")).decode("ascii")
        cfg["author_identities"] = encoded_data

        # 正则原地替换 author_identities 值（保留注释和格式）
        content = CONFIG_TOML_PATH.read_text(encoding="utf-8")
        content = _update_toml_values(content, {"author_identities": encoded_data})
        CONFIG_TOML_PATH.write_text(content, encoding="utf-8", newline="\n")
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
        f"{rc.github_api}/repos/{owner}/{repo_name}/commits"
        f"?author={username}&per_page={rc.per_page}&page=1"
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
    separator = "=" * rc.separator_length
    print_color(separator, color)
    if title:
        print_color(title, color)
        print_color(separator, color)


def is_image_file(filename: str) -> bool:
    """检查文件是否为图片"""
    return any(filename.lower().endswith(ext) for ext in rc.image_extensions)


def print_stats_summary(
    additions: int,
    deletions: int,
    images: int,
    *,
    prefix: str = "",
) -> None:
    """打印统计摘要"""
    net = additions - deletions
    net_sign = "+" if net >= 0 else ""
    print_color(
        f"{prefix}✅ +{additions:,} / -{deletions:,} (net {net_sign}{net:,})",
        Colors.GREEN,
    )
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
            if remaining.isdigit() and int(remaining) < rc.rate_limit_warn_threshold:
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
    tz_hours = cfg.get("behavior", {}).get("timezone_offset_hours", 8)
    tz = timezone(timedelta(hours=tz_hours))
    return datetime.now(tz).strftime(rc.time_format)


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


def _cache_file_for_repo(repo_name: str) -> Path:
    """返回指定仓库对应的缓存文件路径"""
    return CACHE_DIR / f"{repo_name}.json"


def _build_commit_url(owner: str, repo_name: str, sha: str) -> str:
    """生成 commit 对应的 GitHub 页面链接"""
    return f"{GITHUB_WEB_BASE_URL}/{owner}/{repo_name}/commit/{sha}"


def _order_cache_item(item: CommitData, *, index: int | None = None) -> CommitData:
    """统一 commit 缓存字段顺序，便于 review diff"""
    item_copy = dict(item)
    if index is not None:
        item_copy["index"] = index

    ordered_item: CommitData = {}
    for key in ("timestamp", "index", "additions", "deletions", "images", "url"):
        if key in item_copy:
            ordered_item[key] = item_copy[key]

    for key, value in item_copy.items():
        if key not in ordered_item:
            ordered_item[key] = value

    return ordered_item


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
            _order_cache_item(commit, index=idx)
            for idx, commit in enumerate(sorted_commits, start=1)
        ]

    return sorted_cache_data


# ============================================================================
# 缓存管理
# ============================================================================


def load_cache(repo_name: str) -> CacheData:
    """加载指定仓库的缓存数据"""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = _cache_file_for_repo(repo_name)

    try:
        with cache_file.open(encoding="utf-8") as f:
            cache_data = json.load(f)
            print_color(f"💾 已加载缓存: {cache_file}", Colors.GREEN)

            metadata = cache_data.get("_metadata", {})
            print_color(
                f"   缓存包含 {metadata.get('total_commits', 0)} 个commits",
                Colors.NC,
            )
            data = cache_data.get("data", {})
            if isinstance(data, dict):
                normalized = normalize_cache_data(cast("CacheData", data))
                return normalized
            return {}
    except FileNotFoundError:
        print_color(f"⚠️  加载缓存失败: {cache_file} 不存在", Colors.YELLOW)
        return {}
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
            lines.append(f'    ,"{repo_name}": [')
        for ci, commit in enumerate(commits):
            entry = json.dumps(commit, ensure_ascii=False)
            prefix = "" if ci == 0 else ","
            lines.append(f"      {prefix}{entry}")
        lines.append("    ]")

    if not repo_names:
        lines.append('  "data": {}')
    else:
        lines.append("  }")
    lines.append("}")
    return "\n".join(lines) + "\n"


def save_cache(repo_name: str, cache_data: CacheData) -> bool:
    """保存指定仓库的缓存数据，并返回文件内容是否变化

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
    cache_file = _cache_file_for_repo(repo_name)

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
        old_content = ""
        if cache_file.exists():
            old_content = cache_file.read_text(encoding="utf-8")
        if old_content == serialized:
            print_color(f"✅ 缓存无变化: {cache_file}", Colors.GREEN)
            return False

        with cache_file.open("w", encoding="utf-8", newline="\n") as f:
            f.write(serialized)

        cache_data.clear()
        cache_data.update(sorted_cache_data)

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
    读取各自 _metadata 中的 total_commits / total_additions / total_deletions /
    total_images / latest_commit_timestamp，累加数值并取最大时间戳后返回全局统计。
    """
    total_commits = 0
    total_additions = 0
    total_deletions = 0
    total_images = 0
    latest_dt = datetime.min.replace(tzinfo=timezone.utc)
    latest_ts = ""

    if not CACHE_DIR.exists():
        return {
            "total_commits": 0,
            "total_additions": 0,
            "total_deletions": 0,
            "total_images": 0,
            "latest_commit_timestamp": "",
        }

    latest_dt = datetime.min.replace(tzinfo=timezone.utc)
    latest_ts = ""

    for cache_file in sorted(CACHE_DIR.glob("*.json")):
        try:
            with cache_file.open(encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                continue
            repo_data = data.get("data", {})
            if not isinstance(repo_data, dict) or cache_file.stem not in repo_data:
                continue
            metadata = data.get("_metadata", {})
            if not isinstance(metadata, dict):
                continue
            meta: dict[str, int | str] = cast("dict[str, int | str]", metadata)
            commits = meta.get("total_commits", 0)
            a = meta.get("total_additions", 0)
            d = meta.get("total_deletions", 0)
            i = meta.get("total_images", 0)
            total_commits += commits if isinstance(commits, int) else 0
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
        "total_commits": total_commits,
        "total_additions": total_additions,
        "total_deletions": total_deletions,
        "total_images": total_images,
        "latest_commit_timestamp": latest_ts,
    }


def extract_url_from_cache_item(item: CommitData) -> str:
    """从缓存项中提取 commit URL"""
    url = item.get("url", "")
    return url if isinstance(url, str) else ""


def normalize_cache_data(cache_data: CacheData) -> CacheData:
    """标准化缓存数据：统一字段顺序并按 commit URL 去重"""
    normalized_cache: CacheData = {}

    for repo_name, items in cache_data.items():
        seen_urls: set[str] = set()
        normalized_items: list[CommitData] = []
        duplicate_count = 0

        for item in items:
            item_copy = dict(item)
            url = extract_url_from_cache_item(item_copy)
            if url:
                if url in seen_urls:
                    duplicate_count += 1
                    continue
                seen_urls.add(url)

            normalized_items.append(_order_cache_item(item_copy))

        if duplicate_count > 0:
            print_color(
                f"    🧹 已按 commit URL 去重缓存: 删除 {duplicate_count} 条重复数据",
                Colors.YELLOW,
            )

        normalized_cache[repo_name] = normalized_items

    return normalized_cache


def _extract_commit_cache_urls(
    commits: list[CommitData],
    *,
    owner: str,
    repo_name: str,
) -> tuple[set[str], str, str]:
    """从 commits 提取缓存 URL 集合和时间戳范围

    返回: (url_set, min_timestamp, max_timestamp)
    """
    url_set: set[str] = set()
    min_ts = ""
    max_ts = ""

    for commit in commits:
        sha = commit.get("sha")
        if isinstance(sha, str):
            url_set.add(_build_commit_url(owner, repo_name, sha))

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

    return url_set, min_ts, max_ts


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
            and (item_ts < min_timestamp or item_ts > max_timestamp)
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
                f"       保留 {out_of_range_count} 个超出 API 范围的数据", Colors.NC
            )
    else:
        print_color("    ℹ️  Git log 模式（完整历史）", Colors.NC)


def clean_stale_cache(
    cache_data: CacheData,
    current_commits_with_data: list[CommitData],
    repo_name: str,
    *,
    owner: str,
    is_api_fallback: bool = False,
) -> CacheData:
    """清理过期的缓存（检测变基等导致的 commit 链接变化）

    策略：
    - Git log 模式（完整历史）：对比所有 commits，删除消失的
    - API 兜底模式：只对比 API 返回的时间戳范围内的 commits，范围外的保留

    参数：
    - current_commits_with_data: 当前数据源的 commit 对象列表（包含时间戳）
    - is_api_fallback: 是否为 API 兜底模式
    """
    if repo_name not in cache_data:
        return cache_data

    # 提取当前 commits 的缓存 URL 集合和时间戳范围
    current_commit_set, min_timestamp, max_timestamp = _extract_commit_cache_urls(
        current_commits_with_data,
        owner=owner,
        repo_name=repo_name,
    )

    # 将缓存项分组
    cached_items_in_range, cached_items_out_of_range = _partition_cached_items(
        cache_data[repo_name],
        min_timestamp,
        max_timestamp,
        is_api_fallback=is_api_fallback,
    )

    # 获取范围内缓存的 URL 集合
    cached_urls_in_range: set[str] = {
        url
        for item in cached_items_in_range
        if (url := extract_url_from_cache_item(item))
    }

    # 找出消失的 commits
    stale_commits = cached_urls_in_range - current_commit_set

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
            if extract_url_from_cache_item(item) not in stale_commits
        ]
        cache_data[repo_name] = new_cache_list

        print_color(
            f"    ✅ 已清除 {len(stale_commits)} 个过期的commit缓存", Colors.GREEN
        )

        if not cache_data[repo_name]:
            del cache_data[repo_name]
            print_color("    ℹ️  仓库缓存已清空", Colors.NC)
    else:
        print_color("    ✅ 缓存数据完整，无消失的commits", Colors.GREEN)

    return cache_data


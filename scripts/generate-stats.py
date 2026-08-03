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



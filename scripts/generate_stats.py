#!/usr/bin/env python3
"""GitHub 贡献统计脚本（零依赖，仅用 Python 标准库）。

直接运行，无需编译：
    python3 scripts/generate_stats.py

环境变量：
    GH_TOKEN            GitHub 令牌（必需）
    ORIGIN_USERNAME     统计目标用户名（缺省时从 README.md 读取）
    UPSTREAM_USERNAME   上游用户名（缺省时从 README.md 读取）

相比原有实现的主要改动：
    1. 每个仓库只用 2 次 git 进程（1 次取 commit 元数据、1 次批量取 diff 统计），
       取代原先每次 commit 调用 2 次 git show——冷启动时进程数从数百降到个位数。
    2. HTTP 走 urllib，不再 fork curl 子进程。
    3. 仓库级线程池并发；预筛探测也并发（限流可控）。
"""

from __future__ import annotations

import base64
import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

# ============================================================================
# 常量与终端输出
# ============================================================================

RED = "\033[0;31m"
GREEN = "\033[0;32m"
YELLOW = "\033[1;33m"
NC = "\033[0m"

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent

# 记录分隔符：\x01 分隔字段，\x1f 分隔多个 trailer（均不会出现在正常文本中）
FS = "\x01"
TS = "\x1f"

DEFAULT_CONCURRENCY = 6
DEFAULT_SEPARATOR_LENGTH = 60

_print_lock = threading.Lock()


def print_color(message: str, color: str = NC) -> None:
    with _print_lock:
        print(f"{color}{message}{NC}")


def print_separator(
    title: str | None = None, color: str = GREEN, length: int = DEFAULT_SEPARATOR_LENGTH
) -> None:
    sep = "=" * length
    print_color(sep, color)
    if title:
        print_color(title, color)
        print_color(sep, color)


class Log:
    """仓库级日志缓冲：先在内存累积，完成后整块输出，避免并发交错。"""

    def __init__(self) -> None:
        self.lines: list[str] = []

    def color(self, message: str, color: str = NC) -> None:
        self.lines.append(f"{color}{message}{NC}")

    def separator(
        self, title: str, color: str = GREEN, length: int = DEFAULT_SEPARATOR_LENGTH
    ) -> None:
        sep = "=" * length
        self.color(sep, color)
        self.color(title, color)
        self.color(sep, color)

    def flush(self) -> None:
        if not self.lines:
            return
        with _print_lock:
            sys.stdout.write("\n".join(self.lines) + "\n")
            sys.stdout.flush()
        self.lines = []


def format_number(num: int) -> str:
    """千分位格式化（对应 Rust 的 format_number）。"""
    return f"{num:,}"


def escape_html(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


# ============================================================================
# 时间戳
# ============================================================================


def parse_iso_timestamp(text: str) -> float:
    """解析 ISO 8601 为 Unix 秒；失败返回 -inf（排序时等价于 datetime.min）。"""
    if not text:
        return float("-inf")
    value = text.strip()
    # Python 3.11+ 支持 'Z'；更早版本需替换
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(value).timestamp()
    except ValueError:
        pass
    # 退化为只解析前 19 位（YYYY-MM-DDTHH:MM:SS）
    try:
        return (
            datetime.strptime(value[:19], "%Y-%m-%dT%H:%M:%S")
            .replace(tzinfo=UTC)
            .timestamp()
        )
    except ValueError:
        return float("-inf")


def now_iso_utc() -> str:
    return datetime.now(UTC).isoformat()


# ============================================================================
# 配置
# ============================================================================

SVG_DEFAULTS = {
    "custom_title": None,
    "title_color": "#2f80ed",
    "text_color": "#434d58",
    "bg_color": "#fffefe",
    "border_color": "#ffffff00",
    "add_color": "#28a745",
    "del_color": "#d73a49",
    "img_color": "#6f42c1",
    "width": 1200,
    "height": 200,
}

SVG_LAYOUT_DEFAULTS = {
    "padding": 67,
    "title_y": 70,
    "stats_y": 120,
    "value_gap": 36,
    "border_radius": 4.5,
}

SVG_FONT_DEFAULTS = {
    "family": "'Segoe UI', Ubuntu, Sans-Serif",
    "family_extended": "'Segoe UI', Ubuntu, 'Helvetica Neue', Sans-Serif",
    "header_size": "600 48px",
    "header_size_firefox": "41px",
    "stat_size": "600 20px",
    "bold_size": "700 36px",
}

SVG_LABEL_DEFAULTS = {
    "additions": "Additions",
    "deletions": "Deletions",
    "net": "Net",
    "images": "Images",
}

API_DEFAULTS = {
    "github_api_base": "https://api.github.com",
    "max_api_pages": 10,
    "per_page": 100,
    "rate_limit_warn_threshold": 50,
}

BEHAVIOR_DEFAULTS = {
    "separator_length": DEFAULT_SEPARATOR_LENGTH,
    "image_extensions": [
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".bmp",
        ".svg",
        ".webp",
        ".ico",
    ],
    "progress_interval": 10,
    "concurrency": DEFAULT_CONCURRENCY,
}


def _merged(section: dict, defaults: dict) -> dict:
    out = dict(defaults)
    out.update({k: v for k, v in section.items() if v is not None})
    return out


class App:
    def __init__(
        self, origin_username: str, upstream_username: str, token: str
    ) -> None:
        self.origin_username = origin_username
        self.upstream_username = upstream_username
        self.token = token
        set_git_auth(token)

        self.config_path = PROJECT_ROOT / "config.toml"
        self.readme_path = PROJECT_ROOT / "README.md"
        self.template_path = PROJECT_ROOT / "README.template.md"
        self.svg_path = PROJECT_ROOT / "contributions.svg"
        self.cache_dir = SCRIPT_DIR / "stats_cache"

        raw = self._load_raw_config()
        self.api = _merged(raw.get("api", {}), API_DEFAULTS)
        self.behavior = _merged(raw.get("behavior", {}), BEHAVIOR_DEFAULTS)

        svg_raw = dict(raw.get("svg", {}))
        self.svg = _merged(svg_raw, SVG_DEFAULTS)
        self.svg["layout"] = _merged(svg_raw.get("layout", {}), SVG_LAYOUT_DEFAULTS)
        self.svg["font"] = _merged(svg_raw.get("font", {}), SVG_FONT_DEFAULTS)
        self.svg["labels"] = _merged(svg_raw.get("labels", {}), SVG_LABEL_DEFAULTS)

        self.author_identities_b64: str = raw.get("author_identities", "")
        self.image_extensions = [e.lower() for e in self.behavior["image_extensions"]]

        self.identities: set[str] = set()
        self.identities_lock = threading.Lock()
        self.identities_changed = False
        self.rate_limit: str | None = None

    def _load_raw_config(self) -> dict:
        try:
            import tomllib
        except ModuleNotFoundError:  # pragma: no cover - Python < 3.11
            print_color("❌ 需要 Python 3.11+（tomllib）", RED)
            sys.exit(1)
        if not self.config_path.exists():
            return {}
        try:
            with open(self.config_path, "rb") as fh:
                return tomllib.load(fh)
        except Exception as exc:
            print_color(f"⚠️  config.toml 解析失败，使用默认配置: {exc}", YELLOW)
            return {}

    # ---- 作者身份 ----

    def load_identities(self) -> None:
        raw = self.author_identities_b64.strip()
        if not raw:
            return
        try:
            text = base64.b64decode(raw).decode("utf-8")
            data = json.loads(text)
            found = {str(i) for i in data.get("identities", [])}
        except Exception:
            print_color("⚠️  加载作者身份失败", YELLOW)
            return
        with self.identities_lock:
            self.identities = found
        if found:
            print_color(f"💾 已加载 {len(found)} 个已知作者身份", GREEN)

    def snapshot_identities(self) -> list[str]:
        with self.identities_lock:
            return sorted(self.identities)

    def merge_identities(self, new: set[str]) -> bool:
        with self.identities_lock:
            before = len(self.identities)
            self.identities |= new
            changed = len(self.identities) > before
        if changed:
            self.identities_changed = True
        return changed

    def set_rate_limit(self, message: str) -> None:
        if self.rate_limit is None:
            self.rate_limit = message

    # ---- 路径 ----

    def cache_file(self, repo_name: str) -> Path:
        return self.cache_dir / f"{repo_name}.json"


def save_author_identities(app: App) -> None:
    """把身份集合写回 config.toml（Base64 JSON），保留注释与格式。"""
    identities = app.snapshot_identities()
    payload = json.dumps({"identities": identities}, ensure_ascii=False)
    encoded = base64.b64encode(payload.encode("utf-8")).decode("ascii")

    try:
        content = app.config_path.read_text(encoding="utf-8")
    except OSError as exc:
        print_color(f"⚠️  保存作者身份失败: {exc}", YELLOW)
        return

    updated = update_toml_value(content, "author_identities", encoded)
    try:
        app.config_path.write_text(updated, encoding="utf-8", newline="\n")
    except OSError as exc:
        print_color(f"⚠️  保存作者身份失败: {exc}", YELLOW)
        return
    print_color(f"💾 已保存 {len(identities)} 个作者身份", GREEN)


def update_toml_value(content: str, key: str, value: str) -> str:
    """原地替换行首 `key = ` 之后的值，保留注释与其余格式。"""
    replacement = f'"{value}"'
    # 整行替换（含旧值），但保留行尾 ` # 注释`
    pattern = re.compile(rf"^({re.escape(key)}[ \t]*=[ \t]*)(.*?)([ \t]+#.*)?$")
    out: list[str] = []
    replaced = False
    for line in content.split("\n"):
        if not replaced and pattern.match(line):
            out.append(
                pattern.sub(
                    lambda m: m.group(1) + replacement + (m.group(3) or ""),
                    line,
                    count=1,
                )
            )
            replaced = True
        else:
            out.append(line)
    if not replaced:
        print_color(f"⚠️  config.toml 中未找到键 '{key}'，跳过更新", YELLOW)
    return "\n".join(out)


def get_default_from_readme(readme_path: Path, var_name: str) -> str | None:
    """从 README.md 读取 `VAR = 值` 形式的默认值。"""
    if not readme_path.exists():
        return None
    marker = f"{var_name} = "
    for line in readme_path.read_text(encoding="utf-8", errors="replace").split("\n"):
        pos = line.find(marker)
        if pos >= 0:
            value = line[pos + len(marker) :].strip()
            if value:
                return value
    return None


# ============================================================================
# HTTP（urllib，替代 curl 子进程）
# ============================================================================


class ApiError(Exception):
    def __init__(self, kind: str, message: str = "") -> None:
        super().__init__(message)
        self.kind = kind  # "rate_limit" | "failure"
        self.message = message


def github_api_request(app: App, url: str) -> str:
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "generate-stats",
    }
    if app.token:
        headers["Authorization"] = f"token {app.token}"

    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            status = resp.getcode()
            remaining = resp.headers.get("x-ratelimit-remaining")
            body = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        status = exc.code
        remaining = exc.headers.get("x-ratelimit-remaining") if exc.headers else None
        body = exc.read().decode("utf-8", "replace") if exc.headers else ""
    except Exception as exc:
        print_color("❌ 网络请求失败", RED)
        raise ApiError("failure") from exc

    if 200 <= status < 400:
        if remaining is not None:
            try:
                if int(remaining) < int(app.api["rate_limit_warn_threshold"]):
                    print_color(f"⚠️  API 配额剩余: {remaining}", YELLOW)
            except ValueError:
                pass
        return body

    if status in (403, 429):
        try:
            remaining_int = int(remaining) if remaining is not None else -1
        except ValueError:
            remaining_int = -1
        if remaining_int == 0 or status == 429:
            try:
                message = json.loads(body).get("message", f"HTTP {status}")
            except Exception:
                message = f"HTTP {status}"
            raise ApiError("rate_limit", f"GitHub API 配额耗尽: {message}")

    raise ApiError("failure")


def api_json(app: App, url: str):
    """请求并解析 JSON；配额耗尽抛 ApiError('rate_limit')，其他失败返回 None。"""
    try:
        body = github_api_request(app, url)
    except ApiError:
        raise
    try:
        return json.loads(body)
    except Exception:
        return None


# ============================================================================
# GitHub 仓库列表 / 上游 / 身份学习
# ============================================================================


def repo_owner_from_url(repo_url: str) -> str | None:
    match = re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]+/([^/]+)/", repo_url)
    if match:
        return match.group(1)
    match = re.match(r"^([^/:]+)/", repo_url)
    return match.group(1) if match else None


def get_repos(app: App) -> list[dict]:
    print_color("📡 获取所有仓库列表...", YELLOW)
    repos: list[dict] = []
    base = app.api["github_api_base"]
    per_page = int(app.api["per_page"])
    max_pages = int(app.api["max_api_pages"])

    page = 1
    while page <= max_pages:
        url = f"{base}/users/{app.origin_username}/repos?per_page={per_page}&type=all&page={page}"
        try:
            data = api_json(app, url)
        except ApiError as exc:
            if exc.kind == "rate_limit":
                raise
            print_color("❌ 获取仓库列表失败", RED)
            return repos
        if not isinstance(data, list) or not data:
            break
        repos.extend(data)
        print_color(f"   第 {page} 页：获取到 {len(data)} 个仓库", NC)
        if len(data) < per_page:
            break
        page += 1

    print_color(f"✅ 获取到 {len(repos)} 个仓库", GREEN)
    for repo in repos:
        kind = "Fork" if repo.get("fork") else "原创"
        print_color(f"   - {repo.get('name', 'Unknown')} ({kind})", NC)
    return repos


def upstream_of(repo: dict) -> dict | None:
    for key in ("source", "parent"):
        value = repo.get(key)
        if isinstance(value, dict):
            return value
    return None


def get_upstream_repo(app: App, repo: dict) -> tuple[str | None, str | None]:
    if not repo.get("fork"):
        return None, None

    upstream = upstream_of(repo)
    if upstream is None:
        name = repo.get("name")
        if not name:
            return None, None
        url = f"{app.api['github_api_base']}/repos/{app.origin_username}/{name}"
        try:
            detail = api_json(app, url)
        except ApiError as exc:
            if exc.kind == "rate_limit":
                app.set_rate_limit(exc.message)
            return None, None
        if isinstance(detail, dict):
            upstream = upstream_of(detail)

    if isinstance(upstream, dict):
        owner = (upstream.get("owner") or {}).get("login")
        name = upstream.get("name")
        if owner and name:
            print_color(f"    📡 检测到上游仓库: {owner}/{name}", NC)
            return owner, name
    return None, None


def probe_user_commits(app: App, owner: str, repo_name: str) -> list[dict] | None:
    """探测用户在某仓库是否有提交；顺带用于学习作者身份。每次探测只 1 个 API 请求。"""
    base = app.api["github_api_base"]
    per_page = int(app.api["per_page"])
    url = f"{base}/repos/{owner}/{repo_name}/commits?author={app.origin_username}&per_page={per_page}&page=1"
    try:
        data = api_json(app, url)
    except ApiError as exc:
        if exc.kind == "rate_limit":
            app.set_rate_limit(exc.message)
        return None
    return data if isinstance(data, list) else None


def learn_identities(app: App, commits: list[dict], log: Log) -> None:
    found: set[str] = set()
    for commit in commits:
        author = (commit.get("commit") or {}).get("author") or {}
        name = author.get("name") or ""
        email = author.get("email") or ""
        if name and email:
            found.add(f"{name} <{email}>")
    if not found:
        return

    log.color(f"    ✅ 发现 {len(found)} 个作者身份", GREEN)
    for identity in sorted(found):
        log.color(f"       - {identity}", NC)

    if app.merge_identities(found):
        log.color(f"    ✅ 发现新身份，共 {len(app.snapshot_identities())} 个", GREEN)


# ============================================================================
# git 操作
# ============================================================================


_GIT_AUTH: list[str] = []


def set_git_auth(token: str) -> None:
    """把令牌放进请求头而非仓库地址，避免写进 .git/config。

    通过 `-c` 传入，取值为环境变量形式，子进程（含懒拉取 blob 的 fetch）
    同样生效，仓库地址保持干净。
    """
    global _GIT_AUTH
    if not token:
        _GIT_AUTH = []
        return
    pair = base64.b64encode(f"x-access-token:{token}".encode()).decode("ascii")
    _GIT_AUTH = [
        "-c",
        f"http.https://github.com/.extraheader=AUTHORIZATION: basic {pair}",
    ]


def _run_git_raw(
    args: list[str], cwd: Path | None = None, stdin_data: str | None = None
) -> tuple[str, str, int]:
    """返回 (stdout, stderr, 退出码)，失败原因交给调用方决定是否展示。"""
    try:
        proc = subprocess.run(
            ["git", *_GIT_AUTH, *args],
            cwd=str(cwd) if cwd else None,
            input=stdin_data,
            # 令牌无效时直接失败，不等待交互式输入
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=900,
        )
        return proc.stdout.strip(), proc.stderr.strip(), proc.returncode
    except Exception as exc:
        return "", str(exc), 1


def run_git(args: list[str], cwd: Path | None = None, stdin_data: str | None = None):
    out, _, code = _run_git_raw(args, cwd, stdin_data)
    return out, code


def branch_sha(repo_path: Path, remote: str, branch: str, *, at_remote: bool) -> str:
    """取分支的 commit SHA，可指定取本地记录还是远端当前值。"""
    if not at_remote:
        out, code = run_git(
            ["rev-parse", f"refs/remotes/{remote}/{branch}"], cwd=repo_path
        )
        return out.strip() if code == 0 else ""

    out, code = run_git(["ls-remote", "--heads", remote, branch], cwd=repo_path)
    if code != 0:
        return ""
    expected = f"refs/heads/{branch}"
    for line in out.splitlines():
        sha, _, ref = line.partition("\t")
        if ref.strip() == expected:
            return sha.strip()
    return ""


def clone_or_update(repo_path: Path, clone_url: str, log: Log) -> bool:
    if repo_path.exists():
        remote = remote_name_of(repo_path)
        # 上游可能改名或转让，让远端地址始终跟随当前仓库
        run_git(["remote", "set-url", remote, clone_url], cwd=repo_path)
        _, branch = default_branch_of(repo_path, remote)
        local_sha = branch_sha(repo_path, remote, branch, at_remote=False)
        # 只比对远端分支的 SHA，没有新提交时一次网络往返即可，不触发对象协商
        if local_sha and local_sha == branch_sha(
            repo_path, remote, branch, at_remote=True
        ):
            log.color("  ✅ 已是最新", GREEN)
            return True
        log.color("  🔄 拉取新增提交...", YELLOW)
        # 显式 refspec：单分支克隆的默认 refspec 不会跟踪新分支，
        # 上游改默认分支名后仍能把新分支拉到本地
        _, code = run_git(
            [
                "fetch",
                remote,
                f"+refs/heads/{branch}:refs/remotes/{remote}/{branch}",
                "--prune",
                "--no-tags",
            ],
            cwd=repo_path,
        )
        if code == 0:
            return True
        # 本地克隆损坏、远端地址变更或网络中断：清掉重新克隆，避免沿用旧历史
        log.color("  ⚠️  更新失败，重新克隆", YELLOW)
        shutil.rmtree(repo_path, ignore_errors=True)

    log.color("  📥 克隆仓库...", YELLOW)
    # 统计只需要 commit 与 tree 对象；文件内容（blob）只在缓存未命中的少数 commit
    # 计算增删行数时才用到，git 会按需补拉。这类仓库的对象里有 96% 以上是 blob，
    # 因此用 blobless 部分克隆压掉下载量，比全量拉取省一个数量级。
    code = 1
    detail = ""
    for filter_args in (["--filter=blob:none"], []):
        _, detail, code = _run_git_raw(
            [
                "clone",
                *filter_args,
                "--no-checkout",
                "--single-branch",
                "--no-tags",
                clone_url,
                repo_path.name,
            ],
            cwd=repo_path.parent,
        )
        if code == 0 and repo_path.exists():
            break
        # 失败（如 git 版本不支持 filter）会留下半成品目录，清掉再退回全量克隆
        if repo_path.exists():
            shutil.rmtree(repo_path, ignore_errors=True)
    if code != 0 or not repo_path.exists():
        log.color("  ⚠️  克隆仓库失败，跳过", YELLOW)
        return False
    return True


def remote_name_of(repo_path: Path) -> str:
    """取第一个远程名（通常为 origin，本地克隆时可能不是）。"""
    out, code = run_git(["remote"], cwd=repo_path)
    names = [line.strip() for line in out.split("\n") if line.strip()]
    return names[0] if names else "origin"


def default_branch_of(repo_path: Path, remote: str | None = None) -> tuple[str, str]:
    """返回 (远程名, 默认分支)。本地记录缺失时向远端查询一次。"""
    remote = remote or remote_name_of(repo_path)
    prefix = f"refs/remotes/{remote}/"
    out, code = run_git(["symbolic-ref", f"refs/remotes/{remote}/HEAD"], cwd=repo_path)
    if code == 0 and out.startswith(prefix):
        return remote, out[len(prefix) :]

    # 本地没有记录符号引用时问远端，避免把 master 默认分支错猜成 main
    out, code = run_git(["ls-remote", "--symref", remote, "HEAD"], cwd=repo_path)
    if code == 0:
        for line in out.splitlines():
            # 形如 `ref: refs/heads/main\tHEAD`
            if line.startswith("ref:"):
                ref = line[4:].split()[0]
                if ref.startswith("refs/heads/"):
                    return remote, ref[len("refs/heads/") :]
    return remote, "main"


def _commit_meta_format() -> str:
    return f"{FS}%H{FS}%aI{FS}%an{FS}%ae{FS}%(trailers:key=Co-authored-by,valueonly=true,separator={TS})"


def collect_user_commits(
    repo_path: Path, remote: str, branch: str, identities: list[str]
) -> list[tuple[str, str]]:
    """一次 git log 拿到全部 commit 元数据，在 Python 侧按身份过滤。

    取代原先「每个身份 × 2 个 flag」的多次全历史扫描（4 身份 = 8 次 git log）。
    """
    out, code = run_git(
        ["log", f"{remote}/{branch}", f"--format={_commit_meta_format()}"],
        cwd=repo_path,
    )
    if code != 0:
        return []

    wanted = {i.lower() for i in identities}
    if not wanted:
        return []

    result: list[tuple[str, str]] = []
    seen: set[str] = set()
    for line in out.split("\n"):
        if not line.startswith(FS):
            continue
        parts = line[1:].split(FS)
        if len(parts) < 5:
            continue
        sha, date, name, email, trailers = (
            parts[0],
            parts[1],
            parts[2],
            parts[3],
            parts[4],
        )
        if sha in seen:
            continue

        author_id = f"{name} <{email}>".lower()
        matched = author_id in wanted
        if not matched and trailers:
            for item in trailers.split(TS):
                if item.strip().lower() in wanted:
                    matched = True
                    break
        if matched:
            seen.add(sha)
            result.append((sha, date))
    return result


def collect_commit_details(repo_path: Path, shas: list[str]) -> dict[str, dict]:
    """一次 git log 批量取所有目标 commit 的增删行数与文件状态。

    取代原先「每 commit 2 次 git show」，进程数从 2N 降到 1。
    """
    if not shas:
        return {}

    fmt = f"{FS}%H{FS}%aI"
    out, code = run_git(
        ["log", "--raw", "--numstat", "--no-walk", "--stdin", f"--format={fmt}"],
        cwd=repo_path,
        stdin_data="\n".join(shas) + "\n",
    )
    if code != 0:
        return {}

    details: dict[str, dict] = {}
    current: str | None = None
    for line in out.split("\n"):
        if line.startswith(FS):
            current = line[1:].split(FS)[0]
            details[current] = {"additions": 0, "deletions": 0, "files": []}
            continue
        if current is None or not line:
            continue
        if line.startswith(":"):
            # :<srcmode> <dstmode> <srcsha> <dstsha> <status>\t<path>[\t<oldpath>]
            fields = line[1:].split("\t")
            meta = fields[0].split()
            status = meta[-1].rstrip("0123456789") if meta else ""
            path = (
                fields[2]
                if len(fields) >= 3
                else (fields[1] if len(fields) >= 2 else "")
            )
            if path:
                kind = "added" if status in ("A", "C") else "modified"
                details[current]["files"].append({"filename": path, "status": kind})
        elif "\t" in line:
            additions, deletions, _path = line.split("\t", 2)
            if additions != "-":
                with contextlib.suppress(ValueError):
                    details[current]["additions"] += int(additions)
            if deletions != "-":
                with contextlib.suppress(ValueError):
                    details[current]["deletions"] += int(deletions)
    return details


def count_images(app: App, files: list[dict]) -> int:
    total = 0
    for item in files:
        if item.get("status") != "added":
            continue
        lower = (item.get("filename") or "").lower()
        if any(lower.endswith(ext) for ext in app.image_extensions):
            total += 1
    return total


# ============================================================================
# API 兜底
# ============================================================================


def get_commits_from_api(
    app: App, owner: str, repo_name: str, branch: str, log: Log
) -> list[tuple[str, str]]:
    base = app.api["github_api_base"]
    per_page = int(app.api["per_page"])
    max_pages = int(app.api["max_api_pages"])
    commits: list[tuple[str, str]] = []

    page = 1
    while page <= max_pages:
        url = (
            f"{base}/repos/{owner}/{repo_name}/commits"
            f"?author={app.origin_username}&sha={branch}&per_page={per_page}&page={page}"
        )
        log.color(f"    🔍 API 获取commits (第{page}页)...", NC)
        try:
            data = api_json(app, url)
        except ApiError as exc:
            if exc.kind == "rate_limit":
                app.set_rate_limit(exc.message)
            else:
                log.color("    ❌ API调用失败", RED)
            return commits
        if not isinstance(data, list) or not data:
            break
        for item in data:
            sha = item.get("sha") or ""
            date = ((item.get("commit") or {}).get("author") or {}).get(
                "date"
            ) or now_iso_utc()
            if sha:
                commits.append((sha, date))
        log.color(f"    📊 已获取 {len(commits)} 个commits", NC)
        if len(data) < per_page:
            break
        page += 1

    if page > max_pages:
        log.color(
            f"    ℹ️  已达到最大页数限制 ({max_pages} 页)，共 {len(commits)} 个commits",
            NC,
        )
    return commits


def get_details_from_api(app: App, owner: str, repo_name: str, sha: str) -> dict:
    url = f"{app.api['github_api_base']}/repos/{owner}/{repo_name}/commits/{sha}"
    try:
        data = api_json(app, url)
    except ApiError as exc:
        if exc.kind == "rate_limit":
            app.set_rate_limit(exc.message)
        return {"additions": 0, "deletions": 0, "files": []}
    if not isinstance(data, dict):
        return {"additions": 0, "deletions": 0, "files": []}
    stats = data.get("stats") or {}
    files = [
        {"filename": f.get("filename", ""), "status": f.get("status", "")}
        for f in (data.get("files") or [])
    ]
    return {
        "additions": int(stats.get("additions", 0) or 0),
        "deletions": int(stats.get("deletions", 0) or 0),
        "files": files,
    }


# ============================================================================
# 缓存
# ============================================================================


def cache_meta_of(cache_file: Path) -> dict:
    try:
        data = json.loads(cache_file.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data.get("_metadata") or {}


def cache_file_by_repo_id(app: App, repo_id: str) -> Path | None:
    """按仓库数字 ID 找缓存文件。仓库改名后 ID 不变，可据此接续历史。"""
    if not repo_id or not app.cache_dir.exists():
        return None
    for path in sorted_cache_files(app.cache_dir):
        if str(cache_meta_of(path).get("repo_id") or "") == repo_id:
            return path
    return None


def load_cache(
    app: App, repo_name: str, log: Log, repo_id: str = ""
) -> dict[str, list[dict]]:
    cache_file = app.cache_file(repo_name)
    if not cache_file.exists() and repo_id:
        previous = cache_file_by_repo_id(app, repo_id)
        if previous is not None:
            log.color(f"    🔀 沿用改名前的缓存: {previous.name}", YELLOW)
            try:
                previous.rename(cache_file)
            except OSError:
                cache_file = previous
    if not cache_file.exists():
        log.color(f"⚠️  加载缓存失败: {cache_file} 不存在", YELLOW)
        return {}

    try:
        data = json.loads(cache_file.read_text(encoding="utf-8"))
    except Exception as exc:
        log.color(f"⚠️  加载缓存失败: {exc}", YELLOW)
        return {}

    log.color(f"💾 已加载缓存: {cache_file}", GREEN)
    meta = data.get("_metadata") or {}
    log.color(f"   缓存包含 {meta.get('total_commits', 0)} 个commits", NC)

    raw_data = data.get("data") or {}
    cache: dict[str, list[dict]] = {}
    for repo, items in raw_data.items():
        entries = []
        if isinstance(items, list):
            for item in items:
                if isinstance(item, dict):
                    entries.append(
                        {
                            "timestamp": item.get("timestamp", ""),
                            "index": int(item.get("index", 0) or 0),
                            "additions": int(item.get("additions", 0) or 0),
                            "deletions": int(item.get("deletions", 0) or 0),
                            "images": int(item.get("images", 0) or 0),
                            "url": item.get("url", ""),
                        }
                    )
        cache[repo] = entries
    return normalize_cache_data(cache, log)


def normalize_cache_data(
    cache: dict[str, list[dict]], log: Log
) -> dict[str, list[dict]]:
    normalized: dict[str, list[dict]] = {}
    for repo, items in cache.items():
        seen: set[str] = set()
        kept: list[dict] = []
        duplicates = 0
        for item in items:
            url = item.get("url", "")
            if url:
                if url in seen:
                    duplicates += 1
                    continue
                seen.add(url)
            kept.append(item)
        if duplicates:
            log.color(
                f"    🧹 已按 commit URL 去重缓存: 删除 {duplicates} 条重复数据", YELLOW
            )
        normalized[repo] = kept
    return normalized


def sort_and_reindex(cache: dict[str, list[dict]]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for repo, items in cache.items():
        items = sorted(items, key=lambda e: parse_iso_timestamp(e.get("timestamp", "")))
        for idx, entry in enumerate(items, start=1):
            entry["index"] = idx
        out[repo] = items
    return out


def serialize_cache(metadata: dict, data: dict[str, list[dict]]) -> str:
    """序列化为与历史产物逐字节一致的紧凑 JSON。"""
    lines = ["{", f'  "_metadata": {json.dumps(metadata)},']

    if not data:
        lines.append('  "data": {}')
    else:
        for repo_index, (repo_name, commits) in enumerate(data.items()):
            if repo_index == 0:
                lines.append(f'  "data": {{"{repo_name}": [')
            else:
                lines.append(f'    ,"{repo_name}": [')
            for commit_index, commit in enumerate(commits):
                prefix = "" if commit_index == 0 else ","
                lines.append(f"      {prefix}{json.dumps(commit)}")
            lines.append("    ]")
        lines.append("  }")
    lines.append("}")
    return "\n".join(lines) + "\n"


def save_cache(
    app: App,
    repo_name: str,
    cache: dict[str, list[dict]],
    log: Log,
    repo_id: str = "",
    full_name: str = "",
) -> bool:
    app.cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = app.cache_file(repo_name)

    sorted_cache = sort_and_reindex(cache)
    total_commits = sum(len(v) for v in sorted_cache.values())
    total_additions = sum(e["additions"] for v in sorted_cache.values() for e in v)
    total_deletions = sum(e["deletions"] for v in sorted_cache.values() for e in v)
    total_images = sum(e["images"] for v in sorted_cache.values() for e in v)

    latest_key = float("-inf")
    latest_timestamp = ""
    for commits in sorted_cache.values():
        for commit in commits:
            key = parse_iso_timestamp(commit.get("timestamp", ""))
            if key > latest_key:
                latest_key = key
                latest_timestamp = commit.get("timestamp", "")

    metadata = {
        "total_commits": total_commits,
        "total_additions": total_additions,
        "total_deletions": total_deletions,
        "total_images": total_images,
        "latest_commit_timestamp": latest_timestamp,
    }
    # 仓库改名或转让后 ID 不变，用它接续缓存
    if repo_id:
        metadata["repo_id"] = repo_id
    if full_name:
        metadata["full_name"] = full_name

    serialized = serialize_cache(metadata, sorted_cache)
    try:
        old = cache_file.read_text(encoding="utf-8") if cache_file.exists() else ""
    except OSError:
        old = ""

    if old == serialized:
        log.color(f"✅ 缓存无变化: {cache_file}", GREEN)
        return False

    try:
        cache_file.write_text(serialized, encoding="utf-8", newline="\n")
    except OSError as exc:
        print_color(f"❌ 保存缓存失败: {exc}", RED)
        return False

    cache.clear()
    cache.update(sorted_cache)

    log.color(f"✅ 缓存已保存: {cache_file}", GREEN)
    log.color(f"   commits: {total_commits}", NC)
    log.color(
        f"   additions: {total_additions}  deletions: {total_deletions}  images: {total_images}",
        NC,
    )
    return True


def clean_stale_cache(
    cache: dict[str, list[dict]],
    current_commits: list[tuple[str, str]],
    repo_name: str,
    owner: str,
    is_api_fallback: bool,
    log: Log,
) -> None:
    if repo_name not in cache:
        return

    current_urls = {
        f"https://github.com/{owner}/{repo_name}/commit/{sha}"
        for sha, _ in current_commits
    }
    stamps = [d for _, d in current_commits if d]
    min_ts = min(stamps) if stamps else ""
    max_ts = max(stamps) if stamps else ""

    in_range: list[dict] = []
    out_of_range: list[dict] = []
    for item in cache.get(repo_name, []):
        out = (
            is_api_fallback
            and min_ts
            and max_ts
            and (
                item.get("timestamp", "") < min_ts or item.get("timestamp", "") > max_ts
            )
        )
        (out_of_range if out else in_range).append(item)

    cached_in_range = {item["url"] for item in in_range if item.get("url")}
    stale = cached_in_range - current_urls

    if is_api_fallback:
        lo = min_ts[:10] if min_ts else "?"
        hi = max_ts[:10] if max_ts else "?"
        if out_of_range:
            log.color(f"    ℹ️  API 兜底模式（检查范围: {lo} ~ {hi}）", NC)
            log.color(f"       保留 {len(out_of_range)} 个超出 API 范围的数据", NC)
    else:
        log.color("    ℹ️  Git log 模式（完整历史）", NC)

    if not stale:
        log.color("    ✅ 缓存数据完整，无消失的commits", GREEN)
        return

    log.color(f"    🧹 检测到 {len(stale)} 个消失的commits", YELLOW)
    log.color("       原因：被变基、压缩或重写", YELLOW)

    new_list = out_of_range + [
        item for item in in_range if item.get("url") not in stale
    ]
    if new_list:
        cache[repo_name] = new_list
    else:
        del cache[repo_name]
        log.color("    ℹ️  仓库缓存已清空", NC)
        return
    log.color(f"    ✅ 已清除 {len(stale)} 个过期的commit缓存", GREEN)


def sorted_cache_files(cache_dir: Path) -> list[Path]:
    if not cache_dir.exists():
        return []
    return sorted(p for p in cache_dir.glob("*.json") if p.is_file())


def cleanup_stale_cache_files(
    app: App, active_repo_names: set[str], active_repo_ids: set[str]
) -> bool:
    """删除已不在仓库列表中的缓存；改名/转让由 ID 识别，不会误删。"""
    if not app.cache_dir.exists() or not active_repo_names:
        return False
    changed = False
    for cache_file in sorted_cache_files(app.cache_dir):
        meta = cache_meta_of(cache_file)
        repo_id = str(meta.get("repo_id") or "")
        # 任一条件命中即视为仍在统计范围内：多个 fork 指向同一上游时，
        # 缓存里只记了其中一个 fork 的 ID，但文件名仍是活跃的上游名
        if repo_id and repo_id in active_repo_ids:
            continue
        if cache_file.stem in active_repo_names:
            continue
        try:
            cache_file.unlink()
            changed = True
            print_color(f"🧹 已删除不存在仓库的缓存: {cache_file}", YELLOW)
        except OSError as exc:
            print_color(f"⚠️  删除陈旧缓存失败: {exc}", YELLOW)
    return changed


def aggregate_stats_from_cache(app: App) -> dict:
    stats = {
        "total_commits": 0,
        "total_additions": 0,
        "total_deletions": 0,
        "total_images": 0,
        "latest_commit_timestamp": "",
    }
    if not app.cache_dir.exists():
        return stats

    latest_key = float("-inf")
    for cache_file in sorted_cache_files(app.cache_dir):
        try:
            data = json.loads(cache_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        data_obj = data.get("data") or {}
        if cache_file.stem not in data_obj:
            continue
        meta = data.get("_metadata") or {}
        for key in (
            "total_commits",
            "total_additions",
            "total_deletions",
            "total_images",
        ):
            stats[key] += int(meta.get(key, 0) or 0)
        stamp = meta.get("latest_commit_timestamp") or ""
        key = parse_iso_timestamp(stamp)
        if key > latest_key:
            latest_key = key
            stats["latest_commit_timestamp"] = stamp
    return stats


# ============================================================================
# 单个仓库分析
# ============================================================================


def analyze_repo(
    app: App,
    repo_path: Path | None,
    owner: str,
    repo_name: str,
    log: Log,
    repo_id: str = "",
    full_name: str = "",
) -> bool:
    log.color("    📊 开始分析commits...", YELLOW)

    cache = load_cache(app, repo_name, log, repo_id)

    remote, branch = default_branch_of(repo_path) if repo_path else ("origin", "main")
    if repo_path:
        log.color(f"    ℹ️  默认分支: {branch}", NC)

    identities = app.snapshot_identities()
    commits: list[tuple[str, str]] = []
    if not identities:
        log.color("    ⚠️  没有已知作者身份，需要先从 API 学习", YELLOW)
    elif repo_path:
        log.color(f"    ℹ️  使用 {len(identities)} 个作者身份匹配", NC)
        commits = collect_user_commits(repo_path, remote, branch, identities)

    is_api_fallback = False
    if not commits:
        if repo_path:
            log.color("    ⚠️  Git log 无数据，尝试 API 兜底...", YELLOW)
        commits = get_commits_from_api(app, owner, repo_name, branch, log)
        is_api_fallback = bool(commits)
        if commits:
            log.color(f"    ✅ 使用 API 兜底数据: {len(commits)} 个commits", GREEN)
            log.color("    ⚠️  注意: API 有分页限制，超出范围的老数据将保留缓存", YELLOW)
        else:
            log.color("    ℹ️  未找到commits", NC)
            return False
    else:
        log.color(f"    ✅ 使用 Git log（完整历史）: {len(commits)} 个commits", GREEN)

    total_commits = len(commits)
    log.color(f"    📊 最终使用 {total_commits} 个commits", NC)

    old_count = len(cache.get(repo_name, []))
    clean_stale_cache(cache, commits, repo_name, owner, is_api_fallback, log)
    stale_cleaned = len(cache.get(repo_name, [])) != old_count

    cache_index = {
        item["url"]: item for item in cache.get(repo_name, []) if item.get("url")
    }

    # 缓存未命中的 sha 一次性批量取详情
    missing: list[str] = []
    for sha, _date in commits:
        url = f"https://github.com/{owner}/{repo_name}/commit/{sha}"
        if url not in cache_index:
            missing.append(sha)

    details: dict[str, dict] = {}
    if missing and repo_path:
        details = collect_commit_details(repo_path, missing)

    total_additions = 0
    total_deletions = 0
    total_images = 0
    cache_hits = 0
    cache_misses = 0
    progress_interval = max(int(app.behavior.get("progress_interval", 10) or 10), 1)

    entries = cache.setdefault(repo_name, [])
    for processed, (sha, date) in enumerate(commits, start=1):
        if processed % progress_interval == 0:
            pct = processed * 100 // total_commits
            log.color(f"    📊 处理中: {processed}/{total_commits} ({pct}%)", NC)

        url = f"https://github.com/{owner}/{repo_name}/commit/{sha}"
        hit = cache_index.get(url)
        if hit is not None:
            total_additions += hit["additions"]
            total_deletions += hit["deletions"]
            total_images += hit["images"]
            cache_hits += 1
            continue

        cache_misses += 1
        detail = details.get(sha)
        if detail is None:
            detail = get_details_from_api(app, owner, repo_name, sha)
        additions = detail["additions"]
        deletions = detail["deletions"]
        images = count_images(app, detail["files"])

        total_additions += additions
        total_deletions += deletions
        total_images += images
        entries.append(
            {
                "timestamp": date,
                "index": processed,
                "additions": additions,
                "deletions": deletions,
                "images": images,
                "url": url,
            }
        )

    if repo_path and missing and not details:
        log.color("    ⚠️  git 详情获取失败，统计数据可能不完整", YELLOW)

    log.color("    💾 缓存统计:", YELLOW)
    log.color(f"       - 缓存命中: {cache_hits} 个commit", NC)
    log.color(f"       - 缓存未命中: {cache_misses} 个commit", NC)
    if total_commits:
        log.color(f"       - 缓存命中率: {cache_hits / total_commits * 100:.1f}%", NC)

    net = total_additions - total_deletions
    net_sign = "+" if net >= 0 else ""
    log.color(
        f"    ✅ +{format_number(total_additions)} / -{format_number(total_deletions)} "
        f"(net {net_sign}{format_number(net)})",
        GREEN,
    )
    log.color(f"      🖼️ 图片: {total_images} images", GREEN)

    saved_changed = save_cache(app, repo_name, cache, log, repo_id, full_name)
    return cache_misses > 0 or stale_cleaned or saved_changed


# ============================================================================
# SVG 卡片
# ============================================================================


def generate_contributions_svg(app: App, stats: dict, display_name: str) -> str:
    svg = app.svg
    layout = svg["layout"]
    font = svg["font"]
    labels = svg["labels"]

    additions = stats["total_additions"]
    deletions = stats["total_deletions"]
    images = stats["total_images"]
    net = additions - deletions
    net_sign = "+" if net >= 0 else ""
    net_color = svg["add_color"] if net >= 0 else svg["del_color"]

    custom_title = svg.get("custom_title")
    if custom_title is not None:
        title_text = escape_html(custom_title)
    else:
        escaped = escape_html(display_name)
        suffix = "" if escaped.rstrip().endswith("s") else "s"
        title_text = f"{escaped}&apos;{suffix} Code Contributions"

    width = int(svg["width"])
    height = int(svg["height"])
    rect_width = width - 1
    rect_height = height - 1
    padding = layout["padding"]
    title_y = layout["title_y"]
    stats_y = layout["stats_y"]
    value_gap = layout["value_gap"]
    border_radius = layout["border_radius"]
    col_width = (width - padding) // 4
    col1 = padding + col_width
    col2 = padding + col_width * 2
    col3 = padding + col_width * 3

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" fill="none" role="img">\n'
        "  <style>\n"
        f"    .header {{ font: {font['header_size']} {font['family']}; fill: {svg['title_color']}; }}\n"
        "    @supports(-moz-appearance: auto) { "
        f".header {{ font-size: {font['header_size_firefox']}; }} }}\n"
        f"    .stat {{ font: {font['stat_size']} {font['family_extended']}; fill: {svg['text_color']}; }}\n"
        f"    .bold {{ font: {font['bold_size']} {font['family_extended']}; }}\n"
        "  </style>\n"
        f'  <rect x="0.5" y="0.5" width="{rect_width}" height="{rect_height}" rx="{border_radius}" '
        f'fill="{svg["bg_color"]}" stroke="{svg["border_color"]}" stroke-width="1"/>\n'
        f'  <text x="{padding}" y="{title_y}" class="header">{title_text}</text>\n'
        f'  <g transform="translate({padding}, {stats_y})">\n'
        f'    <text x="0" y="0" class="stat">{labels["additions"]}</text>\n'
        f'    <text x="0" y="{value_gap}" class="stat bold" style="fill:{svg["add_color"]}">'
        f"+{format_number(additions)}</text>\n"
        "  </g>\n"
        f'  <g transform="translate({col1}, {stats_y})">\n'
        f'    <text x="0" y="0" class="stat">{labels["deletions"]}</text>\n'
        f'    <text x="0" y="{value_gap}" class="stat bold" style="fill:{svg["del_color"]}">'
        f"-{format_number(deletions)}</text>\n"
        "  </g>\n"
        f'  <g transform="translate({col2}, {stats_y})">\n'
        f'    <text x="0" y="0" class="stat">{labels["net"]}</text>\n'
        f'    <text x="0" y="{value_gap}" class="stat bold" style="fill:{net_color}">'
        f"{net_sign}{format_number(net)}</text>\n"
        "  </g>\n"
        f'  <g transform="translate({col3}, {stats_y})">\n'
        f'    <text x="0" y="0" class="stat">{labels["images"]}</text>\n'
        f'    <text x="0" y="{value_gap}" class="stat bold" style="fill:{svg["img_color"]}">'
        f"{format_number(images)}</text>\n"
        "  </g>\n"
        "</svg>"
    )


def save_contributions_svg(app: App, content: str) -> bool:
    try:
        app.svg_path.write_text(content + "\n", encoding="utf-8", newline="\n")
    except OSError as exc:
        print_color(f"❌ 保存 SVG 失败: {exc}", RED)
        return False
    print_color(f"✅ SVG 卡片已生成: {app.svg_path}", GREEN)
    return True


# ============================================================================
# README
# ============================================================================


def read_text_normalized(path: Path) -> str:
    return (
        path.read_text(encoding="utf-8", errors="replace")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
    )


def replace_placeholders(content: str, replacements: dict[str, str]) -> str:
    for key, value in replacements.items():
        content = content.replace("{{" + key + "}}", value)
    return content


def update_variable_definition(content: str, var_name: str, var_value: str) -> str:
    pattern = re.compile(
        rf"(^[ \t]*{re.escape(var_name)}[ \t]*=[ \t]*)(.*)$", re.MULTILINE
    )
    found = False

    def repl(match: re.Match) -> str:
        nonlocal found
        found = True
        return match.group(1) + var_value

    result = pattern.sub(repl, content)
    if found:
        print_color(f"✅ 已更新 {var_name} 定义为: {var_value}", GREEN)
    return result


def update_readme(app: App, stats: dict) -> bool:
    print_color("📝 更新 README.md...", YELLOW)

    if app.template_path.exists():
        print_color("📄 使用模板系统生成 README", GREEN)
        content = read_text_normalized(app.template_path)
        content = replace_placeholders(
            content,
            {
                "ORIGIN_USERNAME": app.origin_username,
                "UPSTREAM_USERNAME": app.upstream_username,
                "CONTRIBUTIONS_CARD_SRC": "contributions.svg",
            },
        )
        print_color("✅ 已从模板生成完整的 README", GREEN)
    elif app.readme_path.exists():
        print_color("⚠️  未发现模板文件，更新现有 README", YELLOW)
        content = read_text_normalized(app.readme_path)
        content = update_variable_definition(
            content, "ORIGIN_USERNAME", app.origin_username
        )
        content = update_variable_definition(
            content, "UPSTREAM_USERNAME", app.upstream_username
        )
        placeholders = content.count("{{ORIGIN_USERNAME}}") + content.count(
            "{{UPSTREAM_USERNAME}}"
        )
        if placeholders:
            content = replace_placeholders(
                content,
                {
                    "ORIGIN_USERNAME": app.origin_username,
                    "UPSTREAM_USERNAME": app.upstream_username,
                },
            )
            print_color(f"✅ 已替换 {placeholders} 个占位符为真实用户名", GREEN)
        else:
            print_color("ℹ️  未发现占位符，内容已包含真实用户名", YELLOW)
    else:
        print_color("❌ README.md 不存在！", RED)
        return False

    try:
        app.readme_path.write_text(content, encoding="utf-8", newline="\n")
    except OSError as exc:
        print_color(f"❌ 保存 README 失败: {exc}", RED)
        return False

    net = stats["total_additions"] - stats["total_deletions"]
    net_sign = "+" if net >= 0 else ""
    print_color("✅ README.md 更新成功！", GREEN)
    print_color(
        f"   ✍️  +{format_number(stats['total_additions'])} / "
        f"-{format_number(stats['total_deletions'])} (net {net_sign}{format_number(net)})",
        NC,
    )
    print_color(f"   🖼️  图片数量: {format_number(stats['total_images'])}", NC)
    print_color(f"   🕒 最新 commit: {stats['latest_commit_timestamp']}", NC)
    print_color(f"   👤 远端用户名: {app.origin_username}", NC)
    print_color(f"   👑 上游用户名: {app.upstream_username}", NC)
    return True


# ============================================================================
# 仓库并发处理
# ============================================================================


class Job:
    def __init__(
        self,
        log: Log,
        repo_path: Path,
        owner: str,
        repo_name: str,
        clone_url: str,
        repo_id: str = "",
        full_name: str = "",
    ) -> None:
        self.log = log
        self.repo_path = repo_path
        self.owner = owner
        self.repo_name = repo_name
        self.clone_url = clone_url
        self.repo_id = repo_id
        self.full_name = full_name


def process_job(app: App, job: Job, temp_dir: Path) -> bool:
    log = job.log
    if not clone_or_update(job.repo_path, job.clone_url, log):
        log.flush()
        return False
    changed = analyze_repo(
        app,
        job.repo_path,
        job.owner,
        job.repo_name,
        log,
        job.repo_id,
        job.full_name,
    )
    log.flush()
    return changed


def process_repos(app: App, repos: list[dict]) -> bool:
    separator_length = int(
        app.behavior.get("separator_length", DEFAULT_SEPARATOR_LENGTH)
    )
    print_separator("开始处理仓库...", GREEN, separator_length)

    temp_dir = PROJECT_ROOT / "temp_repos"
    temp_dir.mkdir(parents=True, exist_ok=True)

    active_repo_names: set[str] = set()
    active_repo_ids: set[str] = set()
    processed_targets: set[str] = set()
    jobs: list[Job] = []

    # ---- Phase A（并发预筛）：解析上游 + 探测提交 + 学习身份 ----
    preflight: list[tuple[dict, str, str, str, Log]] = []
    for repo in repos:
        repo_name = repo.get("name")
        repo_url = repo.get("html_url")
        if not repo_name or not repo_url:
            continue

        log = Log()
        log.separator(f"📦 仓库: {repo_name}", YELLOW, separator_length)
        log.color(f"  URL: {repo_url}", NC)
        log.color(f"  类型: {'Fork 仓库' if repo.get('fork') else '原创仓库'}", NC)

        up_owner, up_name = get_upstream_repo(app, repo)
        if up_owner and up_name:
            log.color(f"  📡 直接克隆上游仓库: {up_owner}/{up_name}", NC)
            clone_owner = up_owner
            target_name = up_name
            clone_url = f"https://github.com/{up_owner}/{up_name}.git"
        else:
            clone_owner = repo_owner_from_url(repo_url) or app.origin_username
            target_name = repo_name
            clone_url = repo_url

        active_repo_names.add(target_name)
        repo_id = str(repo.get("id") or "")
        full_name = str(repo.get("full_name") or f"{clone_owner}/{target_name}")
        if repo_id:
            active_repo_ids.add(repo_id)

        target_key = f"{clone_owner}/{target_name}".lower()
        if target_key in processed_targets:
            log.color(
                f"  ℹ️  已处理同一目标仓库，跳过重复项: {clone_owner}/{target_name}", NC
            )
            log.flush()
            continue
        processed_targets.add(target_key)

        preflight.append(
            (
                {
                    "owner": clone_owner,
                    "name": target_name,
                    "clone_url": clone_url,
                    "repo_path": temp_dir / target_name,
                    "repo_id": repo_id,
                    "full_name": full_name,
                },
                clone_owner,
                target_name,
                clone_url,
                log,
            )
        )

    # 并发探测（受限于 GitHub 二级限流，并发度取仓库并发度的一半，至少 2）
    concurrency = max(
        int(
            app.behavior.get("concurrency", DEFAULT_CONCURRENCY) or DEFAULT_CONCURRENCY
        ),
        1,
    )
    probe_workers = max(min(concurrency, len(preflight)) // 2, 1) if preflight else 1
    probe_workers = min(probe_workers, 4)

    def probe(item):
        meta, owner, name, _clone_url, log = item
        items = probe_user_commits(app, owner, name)
        return meta, items, log

    if preflight:
        with ThreadPoolExecutor(max_workers=probe_workers) as pool:
            results = list(pool.map(probe, preflight))

        for meta, items, log in results:
            owner = meta["owner"]
            name = meta["name"]
            if items is not None:
                learn_identities(app, items, log)
            if items is not None and not items and not app.cache_file(name).exists():
                log.color("  ⏭️  该仓库无用户提交，跳过克隆", NC)
                log.flush()
                continue
            jobs.append(
                Job(
                    log=log,
                    repo_path=meta["repo_path"],
                    owner=owner,
                    repo_name=name,
                    clone_url=meta["clone_url"],
                    repo_id=meta["repo_id"],
                    full_name=meta["full_name"],
                )
            )

    # ---- Phase B（并发）：克隆 + 分析 ----
    any_changed = False
    if jobs:
        workers = max(min(concurrency, len(jobs)), 1)
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for changed in pool.map(lambda job: process_job(app, job, temp_dir), jobs):
                any_changed = any_changed or bool(changed)

    # 本地克隆保留给下次运行复用，只清掉本轮不再出现的仓库
    kept = {job.repo_path.name for job in jobs}
    if temp_dir.exists():
        for path in sorted(temp_dir.iterdir()):
            if path.is_dir():
                if path.name in kept:
                    continue
                shutil.rmtree(path, ignore_errors=True)
            else:
                with contextlib.suppress(OSError):
                    path.unlink()

    if active_repo_names and cleanup_stale_cache_files(
        app, active_repo_names, active_repo_ids
    ):
        any_changed = True

    return any_changed


# ============================================================================
# 入口
# ============================================================================


def print_help() -> None:
    print("用法: generate_stats.py [选项]")
    print()
    print("选项:")
    print("  --clear-cache         清除缓存文件")
    print("  -h, --help            显示此帮助信息")


def run() -> int:
    args = sys.argv[1:]
    clear_cache = False
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "--clear-cache":
            clear_cache = True
        elif arg in ("--help", "-h"):
            print_help()
            return 0
        else:
            print_color(f"❌ 未知参数: {arg}", RED)
            print_help()
            return 2
        index += 1

    origin_username = os.environ.get("ORIGIN_USERNAME", "")
    upstream_username = os.environ.get("UPSTREAM_USERNAME", "")
    token = os.environ.get("GH_TOKEN", "")

    readme_path = PROJECT_ROOT / "README.md"
    if not origin_username:
        origin_username = get_default_from_readme(readme_path, "ORIGIN_USERNAME") or ""
    if not upstream_username:
        upstream_username = (
            get_default_from_readme(readme_path, "UPSTREAM_USERNAME") or ""
        )

    app = App(origin_username, upstream_username, token)
    separator_length = int(
        app.behavior.get("separator_length", DEFAULT_SEPARATOR_LENGTH)
    )

    print_separator("🚀 开始生成 GitHub 统计...", GREEN, separator_length)
    print_color("📊 统计配置:", YELLOW)
    print_color(f"   - 缓存目录: {app.cache_dir}", NC)
    print_separator(None, GREEN, separator_length)

    if clear_cache:
        if app.cache_dir.exists():
            print_color(f"🗑️  清除缓存目录: {app.cache_dir}", YELLOW)
            try:
                shutil.rmtree(app.cache_dir)
                print_color("✅ 缓存已清除", GREEN)
            except OSError as exc:
                print_color(f"❌ 清除缓存失败: {exc}", RED)
                return 1
        else:
            print_color(f"ℹ️  缓存目录不存在: {app.cache_dir}", NC)
        repos_dir = PROJECT_ROOT / "temp_repos"
        if repos_dir.exists():
            print_color(f"🗑️  清除本地克隆: {repos_dir}", YELLOW)
            try:
                shutil.rmtree(repos_dir)
                print_color("✅ 本地克隆已清除", GREEN)
            except OSError as exc:
                print_color(f"❌ 清除本地克隆失败: {exc}", RED)
                return 1
        return 0

    if not token:
        print_color("❌ 错误: GH_TOKEN 环境变量未设置", RED)
        return 1

    app.load_identities()

    try:
        repos = get_repos(app)
    except ApiError as exc:
        print_color(f"❌ {exc.message}", RED)
        return 1
    if not repos:
        print_color("⚠️  没有找到仓库", YELLOW)
        return 1

    any_changed = process_repos(app, repos)

    # 新身份统一在末尾串行写回 config.toml，避免并发写
    if app.identities_changed:
        save_author_identities(app)

    if app.rate_limit:
        print_color(f"❌ {app.rate_limit}", RED)
        return 1

    if not any_changed:
        print_separator("✅ 脚本执行完成（无变更）", GREEN, separator_length)
        return 0

    stats = aggregate_stats_from_cache(app)
    net = stats["total_additions"] - stats["total_deletions"]
    net_sign = "+" if net >= 0 else ""
    print_separator("📈 汇总统计（来自缓存文件 _metadata）", GREEN, separator_length)
    print_color(
        f"  ✍️  +{format_number(stats['total_additions'])} / "
        f"-{format_number(stats['total_deletions'])} (net {net_sign}{format_number(net)})",
        GREEN,
    )
    print_color(f"  🖼️  总 images: {format_number(stats['total_images'])}", GREEN)
    print_separator(None, GREEN, separator_length)

    svg_content = generate_contributions_svg(app, stats, app.origin_username)
    if not save_contributions_svg(app, svg_content):
        return 1

    if not update_readme(app, stats):
        return 1

    print_separator("✅ 脚本执行完成！", GREEN, separator_length)
    return 0


def main() -> None:
    sys.exit(run())


if __name__ == "__main__":
    main()

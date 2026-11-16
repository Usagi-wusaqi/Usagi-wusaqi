#!/usr/bin/env python3
"""Pages 站点的读写流水线。

由 .github/workflows/update-stats.yml 按子命令调用，也可在仓库根目录本地执行：

    python3 scripts/pipeline.py restore   # 从站点读回统计缓存
    python3 scripts/pipeline.py site      # 打包 _site/ 产物
    python3 scripts/pipeline.py purge     # 清除卡片在 camo 的缓存
    python3 scripts/pipeline.py summary   # 写入 Actions 运行摘要

只依赖 Python 标准库。
"""

from __future__ import annotations

import argparse
import html
import json
import os
import pathlib
import re
import shutil
import sys
import time
import urllib.request

PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE_DIR = PROJECT_ROOT / "scripts" / "stats_cache"
SITE_DIR = PROJECT_ROOT / "_site"
CARD = PROJECT_ROOT / "contributions.svg"
MANIFEST = "manifest.json"

USER_AGENT = "update-stats"
FETCH_TIMEOUT = 20
FETCH_RETRIES = 3

# Pages 为最终一致：部署结束后等站点同步本次产物，超时则放弃清除缓存
SYNC_TIMEOUT = 300
SYNC_INTERVAL = 10

CAMO_PATTERN = re.compile(r"https://camo\.githubusercontent\.com/[0-9a-f]+/[0-9a-f]+")

# 工作流按阶段把耗时秒数写进 $GITHUB_ENV，摘要据此列出各段用时
TIMING_PHASES = (
    ("SEC_CLONE", "恢复仓库克隆缓存"),
    ("SEC_RESTORE", "恢复统计缓存"),
    ("SEC_STATS", "统计脚本"),
    ("SEC_SITE", "打包站点"),
    ("SEC_DEPLOY", "上传并部署 Pages"),
    ("SEC_PURGE", "清除卡片缓存"),
)

INDEX_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>贡献统计</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0 auto; max-width: 46rem; padding: 3rem 1.25rem;
         font: 16px/1.7 -apple-system, "Segoe UI", "Noto Sans CJK SC", sans-serif; }
  h1 { font-size: 1.35rem; margin: 0 0 1.5rem; }
  img { max-width: 100%; height: auto; border: 1px solid #d0d7de; border-radius: 6px; }
  ul { padding-left: 1.2rem; }
  li { margin: 0.2rem 0; }
  code { font-size: 0.9em; }
  footer { margin-top: 2.5rem; font-size: 0.85rem; opacity: 0.7; }
</style>
</head>
<body>
<h1>贡献统计</h1>
<p><img src="contributions.svg" alt="贡献卡片"></p>
<p>明细清单：<a href="data/manifest.json"><code>data/manifest.json</code></a></p>
<ul>
__ITEMS__
</ul>
<footer>卡片与明细由 GitHub Actions 每日生成，仓库中不保存这些文件。</footer>
</body>
</html>
"""


def emit(**fields: object) -> None:
    """把步骤输出写入 $GITHUB_OUTPUT，本地运行时静默跳过。"""
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        for key, value in fields.items():
            handle.write(f"{key}={value}\n")


def parse_seconds(name: str) -> int | None:
    """读取工作流写入的阶段耗时，缺失或非数字时返回 None。"""
    raw = (os.environ.get(name) or "").strip()
    return int(raw) if raw.isdigit() else None


def format_duration(seconds: int) -> str:
    minutes, rest = divmod(max(seconds, 0), 60)
    return f"{minutes} 分 {rest} 秒" if minutes else f"{rest} 秒"


def site_base() -> str:
    owner = os.environ["GITHUB_REPOSITORY_OWNER"].lower()
    repo = os.environ["GITHUB_REPOSITORY"].split("/")[-1]
    return f"https://{owner}.github.io/{repo}"


def fetch(
    url: str, *, headers: dict[str, str] | None = None, timeout: int = FETCH_TIMEOUT
) -> bytes:
    """带重试的 GET；重试用于躲开站点的临时 5xx，避免退化成全量统计。"""
    request_headers = {"User-Agent": USER_AGENT}
    request_headers.update(headers or {})
    request = urllib.request.Request(url, headers=request_headers)
    last: Exception | None = None
    for attempt in range(FETCH_RETRIES):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except Exception as exc:
            last = exc
            if attempt + 1 < FETCH_RETRIES:
                time.sleep(2 * (attempt + 1))
    if last is None:
        raise RuntimeError(f"未能获取 {url}")
    raise last


def render_markdown(text: str) -> str:
    """把一段 Markdown 交给 GitHub 渲染。图片会被改写成 camo 代理地址。"""
    request = urllib.request.Request(
        "https://api.github.com/markdown",
        data=json.dumps({"text": text, "mode": "gfm"}).encode(),
        headers={
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {os.environ.get('GH_TOKEN', '')}",
        },
    )
    with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT) as response:
        return response.read().decode("utf-8", "replace")


# ---------------------------------------------------------------------------
# restore：从站点读回统计缓存
# ---------------------------------------------------------------------------


def cmd_restore(_args: argparse.Namespace) -> int:
    base = f"{site_base()}/data"
    stamp = os.environ.get("GITHUB_RUN_ID", "0")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    def cached(name: str) -> bytes:
        return fetch(
            f"{base}/{name}?t={stamp}",
            headers={"Cache-Control": "no-cache"},
        )

    try:
        names = json.loads(cached(MANIFEST))
    except Exception as exc:
        print(f"ℹ️  Pages 上暂无缓存清单，从空缓存开始全量统计（{type(exc).__name__}）")
        emit(restored=0, failed=0)
        return 0

    if not isinstance(names, list):
        print("⚠️  缓存清单格式异常，从空缓存开始全量统计")
        emit(restored=0, failed=0)
        return 0

    restored = failed = 0
    for name in names:
        if not isinstance(name, str) or name == MANIFEST:
            continue
        if not name.endswith(".json") or "/" in name or ".." in name:
            continue
        try:
            raw = cached(name)
            json.loads(raw)
        except Exception:
            failed += 1
            print(f"⚠️  {name} 恢复失败，本次重新统计该仓库")
            continue
        (CACHE_DIR / name).write_bytes(raw)
        restored += 1

    print(f"✅ 从 Pages 恢复 {restored} 份统计缓存（失败 {failed}）")
    emit(restored=restored, failed=failed)
    return 0


# ---------------------------------------------------------------------------
# site：打包 _site/ 产物
# ---------------------------------------------------------------------------


def render_index(names: list[str]) -> str:
    items = "\n".join(
        f'  <li><a href="data/{html.escape(name)}">{html.escape(name)}</a></li>'
        for name in names
    )
    return INDEX_TEMPLATE.replace("__ITEMS__", items)


def cmd_site(_args: argparse.Namespace) -> int:
    data_dir = SITE_DIR / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    if not CARD.is_file() or CARD.stat().st_size == 0:
        print("❌ 卡片文件为空或不存在", file=sys.stderr)
        return 1
    shutil.copyfile(CARD, SITE_DIR / CARD.name)

    names: list[str] = []
    for source in sorted(CACHE_DIR.glob("*.json")):
        shutil.copyfile(source, data_dir / source.name)
        names.append(source.name)
    if not names:
        print("❌ 没有生成任何统计缓存，终止部署", file=sys.stderr)
        return 1

    (data_dir / MANIFEST).write_text(
        json.dumps(names, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (SITE_DIR / "index.html").write_text(render_index(names), encoding="utf-8")

    print(f"📦 托管 {len(names)} 份统计缓存 + 1 张卡片 + 1 个索引页")
    emit(repo_count=len(names))
    return 0


# ---------------------------------------------------------------------------
# purge：清除卡片在 camo 的缓存
# ---------------------------------------------------------------------------


def cmd_purge(_args: argparse.Namespace) -> int:
    def done(result: str, detail: str) -> int:
        print(f"camo: {result} - {detail}")
        emit(result=result, detail=detail)
        return 0

    page_url = (os.environ.get("PAGE_URL") or "").rstrip("/")
    if not page_url:
        return done("skipped", "未取得页面地址")
    if not CARD.is_file():
        return done("skipped", "本地卡片不存在")

    card_url = f"{page_url}/contributions.svg"
    expected = CARD.read_bytes()

    # 先确认站点已是本次产物，否则回源会抓到旧卡片，再缓存十分钟
    deadline = time.monotonic() + SYNC_TIMEOUT
    while True:
        try:
            current = fetch(card_url, headers={"Cache-Control": "no-cache"}, timeout=10)
        except Exception:
            current = b""
        if current == expected:
            break
        if time.monotonic() >= deadline:
            return done("skipped", "站点尚未同步")
        time.sleep(SYNC_INTERVAL)

    # 借助官方 markdown 端点换出该 URL 对应的 camo 地址
    try:
        html_text = render_markdown(f"![]({card_url})")
    except Exception as exc:
        return done("failed", f"camo 地址解析失败（{type(exc).__name__}）")

    match = CAMO_PATTERN.search(html_text)
    if not match:
        return done("failed", "未解析到 camo 地址")

    try:
        request = urllib.request.Request(match.group(0), method="PURGE")
        request.add_header("User-Agent", USER_AGENT)
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT) as response:
            response.read()
    except Exception as exc:
        return done("failed", f"PURGE 未成功（{type(exc).__name__}）")
    return done("ok", "已清除，访客下次请求回源")


# ---------------------------------------------------------------------------
# summary：写入 Actions 运行摘要
# ---------------------------------------------------------------------------


def cmd_summary(_args: argparse.Namespace) -> int:
    files = sorted(CACHE_DIR.glob("*.json"))
    commits = additions = deletions = images = 0
    latest = ""
    for path in files:
        try:
            meta = (json.loads(path.read_text(encoding="utf-8")) or {}).get(
                "_metadata"
            ) or {}
        except Exception:
            continue
        commits += int(meta.get("total_commits", 0) or 0)
        additions += int(meta.get("total_additions", 0) or 0)
        deletions += int(meta.get("total_deletions", 0) or 0)
        images += int(meta.get("total_images", 0) or 0)
        stamp = meta.get("latest_commit_timestamp") or ""
        if stamp > latest:
            latest = stamp

    def env(name: str, fallback: str = "—") -> str:
        value = (os.environ.get(name) or "").strip()
        return value or fallback

    deployed = env("DEPLOY", "") == "success"
    result = env("PURGE_RESULT", "")
    detail = env("PURGE_DETAIL", "")
    if not deployed:
        purge = "未执行（本次未部署）"
    else:
        purge = {
            "ok": "已清除",
            "skipped": f"未清除（{detail or '站点尚未同步'}）",
            "failed": f"清除失败（{detail or '未知原因'}）",
        }.get(result, "未执行")

    trigger = {"schedule": "定时任务", "workflow_dispatch": "手动触发"}.get(
        env("EVENT_NAME", ""), env("EVENT_NAME")
    )

    net = additions - deletions
    page = env("PAGE_URL", "").rstrip("/")
    lines = [
        "## 贡献卡片已更新" if deployed else "## 贡献统计未发布",
        "",
        "| 项目 | 值 |",
        "| --- | --- |",
        f"| 触发方式 | {trigger} |",
        f"| 统计账号 | {env('ORIGIN')} |",
        f"| 上游账号 | {env('UPSTREAM')} |",
        f"| 缓存仓库数 | {len(files)} |",
        f"| 提交数 | {commits:,} |",
        f"| 新增 / 删除 | +{additions:,} / -{deletions:,}（净 {net:+,}） |",
        f"| 图片 | {images:,} |",
        f"| 最新提交 | {latest or '—'} |",
        f"| 缓存恢复 | {env('RESTORED', '0')} 份（失败 {env('RESTORE_FAILED', '0')}） |",
        f"| camo 缓存 | {purge} |",
        "",
    ]
    if page and deployed:
        lines += [
            f"- 卡片：{page}/contributions.svg",
            f"- 明细清单：{page}/data/manifest.json",
            "",
        ]
    elif not deployed:
        lines += ["- 本次未部署，站点内容保持上次发布的版本。", ""]

    rows = [
        (label, format_duration(seconds))
        for name, label in TIMING_PHASES
        if (seconds := parse_seconds(name)) is not None
    ]
    total = parse_seconds("SEC_TOTAL")
    if rows or total is not None:
        lines += ["## 耗时", "", "| 阶段 | 耗时 |", "| --- | --- |"]
        lines += [f"| {label} | {value} |" for label, value in rows]
        if total is not None:
            lines += [f"| **总计** | {format_duration(total)}（自确定目标用户起） |"]
        lines += [""]

    text = "\n".join(lines)
    print(text)
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as handle:
            handle.write(text + "\n")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Pages 站点的读写流水线")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("restore", help="从站点读回统计缓存").set_defaults(
        func=cmd_restore
    )
    commands.add_parser("site", help="打包 _site/ 产物").set_defaults(func=cmd_site)
    commands.add_parser("purge", help="清除卡片在 camo 的缓存").set_defaults(
        func=cmd_purge
    )
    commands.add_parser("summary", help="写入运行摘要").set_defaults(func=cmd_summary)
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

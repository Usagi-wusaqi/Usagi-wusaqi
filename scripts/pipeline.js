#!/usr/bin/env node
/**
 * Pages 站点的读写流水线。
 *
 * 由 .github/workflows/update-stats.yml 按子命令调用，也可在仓库根目录本地执行：
 *
 *     node scripts/pipeline.js restore   # 从站点读回统计缓存
 *     node scripts/pipeline.js site      # 打包 _site/ 产物
 *     node scripts/pipeline.js purge     # 清除卡片在 camo 的缓存
 *     node scripts/pipeline.js summary   # 写入 Actions 运行摘要
 *
 * 只依赖 Node 内置模块。
 */

import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(SCRIPT_DIR);
const CACHE_DIR = path.join(SCRIPT_DIR, "stats_cache");
const SITE_DIR = path.join(PROJECT_ROOT, "_site");
const CARD = path.join(PROJECT_ROOT, "contributions.svg");
const MANIFEST = "manifest.json";
// 每次运行的最终汇总随明细一起发布，下次直接读回做对比
const LATEST = "latest.json";
const PREVIOUS_SUMMARY = path.join(SCRIPT_DIR, "previous_summary.json");

const USER_AGENT = "update-stats";
const FETCH_TIMEOUT = 20_000;
const FETCH_RETRIES = 3;

// Pages 为最终一致：部署结束后等站点同步本次产物，超时则放弃清除缓存
const SYNC_TIMEOUT = 300;
const SYNC_INTERVAL = 10;

const CAMO_PATTERN = /https:\/\/camo\.githubusercontent\.com\/[0-9a-f]+\/[0-9a-f]+/;

// 工作流按阶段把耗时秒数写进 $GITHUB_ENV，摘要据此列出各段用时
const TIMING_PHASES = [
  ["SEC_CLONE", "恢复仓库克隆缓存"],
  ["SEC_RESTORE", "恢复统计缓存"],
  ["SEC_STATS", "统计脚本"],
  ["SEC_SITE", "打包站点"],
  ["SEC_DEPLOY", "上传并部署 Pages"],
  ["SEC_PURGE", "清除卡片缓存"],
];

const INDEX_TEMPLATE = `<!DOCTYPE html>
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
`;

/** 把步骤输出写入 $GITHUB_OUTPUT，本地运行时静默跳过。 */
function emit(fields) {
  const target = process.env.GITHUB_OUTPUT;
  if (!target) {
    return;
  }
  const lines = Object.entries(fields).map(([key, value]) => `${key}=${value}\n`);
  fs.appendFileSync(target, lines.join(""), { encoding: "utf8" });
}

function parseSeconds(name) {
  const raw = (process.env[name] ?? "").trim();
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
}

function formatDuration(seconds) {
  const total = Math.max(seconds, 0);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`;
}

function siteBase() {
  const owner = (process.env.GITHUB_REPOSITORY_OWNER ?? "").toLowerCase();
  const repo = (process.env.GITHUB_REPOSITORY ?? "").split("/").pop();
  return `https://${owner}.github.io/${repo}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 带重试的 GET；重试用于躲开站点的临时 5xx，避免退化成全量统计。
 */
async function fetchBytes(url, { headers = {}, timeout = FETCH_TIMEOUT } = {}) {
  const requestHeaders = { "User-Agent": USER_AGENT, ...headers };
  let last = null;
  for (let attempt = 0; attempt < FETCH_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: requestHeaders,
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (exc) {
      last = exc;
      if (attempt + 1 < FETCH_RETRIES) {
        await sleep(2 * (attempt + 1) * 1000);
      }
    }
  }
  throw last ?? new Error(`未能获取 ${url}`);
}

/** 发一次请求，方法可自定义（PURGE 用 fetch 会被拒，这里走原生 https）。 */
function requestOnce(url, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      { method, headers: { "User-Agent": USER_AGENT, ...headers } },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.setTimeout(FETCH_TIMEOUT, () => request.destroy(new Error("请求超时")));
    request.on("error", reject);
    request.end();
  });
}

/** 把一段 Markdown 交给 GitHub 渲染。图片会被改写成 camo 代理地址。 */
async function renderMarkdown(text) {
  const response = await fetch("https://api.github.com/markdown", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GH_TOKEN ?? ""}`,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ text, mode: "gfm" }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.text();
}

/** 按站点清单的既有格式输出：两空格缩进，非 ASCII 字符不转义。 */
function jsonPrettyArray(values) {
  if (!values.length) {
    return "[]\n";
  }
  const items = values.map((value) => `  ${JSON.stringify(value)}`);
  return `[\n${items.join(",\n")}\n]\n`;
}

// ---------------------------------------------------------------------------
// restore：从站点读回统计缓存
// ---------------------------------------------------------------------------

async function cmdRestore() {
  const base = `${siteBase()}/data`;
  const stamp = process.env.GITHUB_RUN_ID ?? "0";
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  // 每次运行都从站点重新取基线，避免本地旧文件混进对比
  fs.rmSync(PREVIOUS_SUMMARY, { force: true });

  const cached = (name) =>
    fetchBytes(`${base}/${name}?t=${stamp}`, {
      headers: { "Cache-Control": "no-cache" },
    });

  let names;
  try {
    names = JSON.parse((await cached(MANIFEST)).toString("utf8"));
  } catch (exc) {
    console.log(
      `ℹ️  Pages 上暂无缓存清单，从空缓存开始全量统计（${exc.name}）`,
    );
    emit({ restored: 0, failed: 0 });
    return 0;
  }

  if (!Array.isArray(names)) {
    console.log("⚠️  缓存清单格式异常，从空缓存开始全量统计");
    emit({ restored: 0, failed: 0 });
    return 0;
  }

  let restored = 0;
  let failed = 0;
  for (const name of names) {
    if (typeof name !== "string" || name === MANIFEST) {
      continue;
    }
    if (!name.endsWith(".json") || name.includes("/") || name.includes("..")) {
      continue;
    }
    let raw;
    try {
      raw = await cached(name);
      JSON.parse(raw.toString("utf8"));
    } catch {
      failed += 1;
      console.log(`⚠️  ${name} 恢复失败，本次重新统计该仓库`);
      continue;
    }
    fs.writeFileSync(path.join(CACHE_DIR, name), raw);
    restored += 1;
  }

  // 同时取回上次运行的最终汇总，摘要直接对比两个数字对象
  try {
    const raw = await cached(LATEST);
    JSON.parse(raw.toString("utf8"));
    fs.writeFileSync(PREVIOUS_SUMMARY, raw);
  } catch {
    console.log("ℹ️  站点尚无上次汇总数据，本次摘要不做数据对比");
  }

  console.log(`✅ 从 Pages 恢复 ${restored} 份统计缓存（失败 ${failed}）`);
  emit({ restored, failed });
  return 0;
}

// ---------------------------------------------------------------------------
// site：打包 _site/ 产物
// ---------------------------------------------------------------------------

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderIndex(names) {
  const items = names
    .map(
      (name) =>
        `  <li><a href="data/${escapeHtml(name)}">${escapeHtml(name)}</a></li>`,
    )
    .join("\n");
  return INDEX_TEMPLATE.replace("__ITEMS__", items);
}

function cmdSite() {
  const dataDir = path.join(SITE_DIR, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  if (!fs.existsSync(CARD) || fs.statSync(CARD).size === 0) {
    console.error("❌ 卡片文件为空或不存在");
    return 1;
  }
  fs.copyFileSync(CARD, path.join(SITE_DIR, path.basename(CARD)));

  const names = [];
  const sources = fs.existsSync(CACHE_DIR)
    ? fs
        .readdirSync(CACHE_DIR)
        .filter((name) => name.endsWith(".json"))
        .sort()
    : [];
  for (const name of sources) {
    fs.copyFileSync(path.join(CACHE_DIR, name), path.join(dataDir, name));
    names.push(name);
  }
  if (!names.length) {
    console.error("❌ 没有生成任何统计缓存，终止部署");
    return 1;
  }

  fs.writeFileSync(path.join(dataDir, MANIFEST), jsonPrettyArray(names), {
    encoding: "utf8",
  });
  // 最终汇总随产物一起发布，下次运行直接拉回对比
  const summary = buildSummary(CACHE_DIR);
  fs.writeFileSync(path.join(dataDir, LATEST), `${JSON.stringify(summary, null, 2)}\n`, {
    encoding: "utf8",
  });
  fs.writeFileSync(path.join(SITE_DIR, "index.html"), renderIndex(names), {
    encoding: "utf8",
  });

  console.log(
    `📦 托管 ${names.length} 份统计缓存 + 1 张卡片 + 1 个索引页 + 1 份汇总`,
  );
  emit({ repo_count: names.length });
  return 0;
}

// ---------------------------------------------------------------------------
// purge：清除卡片在 camo 的缓存
// ---------------------------------------------------------------------------

async function cmdPurge() {
  const done = (result, detail) => {
    console.log(`camo: ${result} - ${detail}`);
    emit({ result, detail });
    return 0;
  };

  const pageUrl = (process.env.PAGE_URL ?? "").replace(/\/+$/, "");
  if (!pageUrl) {
    return done("skipped", "未取得页面地址");
  }
  if (!fs.existsSync(CARD)) {
    return done("skipped", "本地卡片不存在");
  }

  const cardUrl = `${pageUrl}/contributions.svg`;
  const expected = fs.readFileSync(CARD);

  // 先确认站点已是本次产物，否则回源会抓到旧卡片，再缓存十分钟
  const deadline = Date.now() + SYNC_TIMEOUT * 1000;
  for (;;) {
    let current;
    try {
      current = await fetchBytes(cardUrl, {
        headers: { "Cache-Control": "no-cache" },
        timeout: 10_000,
      });
    } catch {
      current = Buffer.alloc(0);
    }
    if (current.equals(expected)) {
      break;
    }
    if (Date.now() >= deadline) {
      return done("skipped", "站点尚未同步");
    }
    await sleep(SYNC_INTERVAL * 1000);
  }

  // 借助官方 markdown 端点换出该 URL 对应的 camo 地址
  let htmlText;
  try {
    htmlText = await renderMarkdown(`![](${cardUrl})`);
  } catch (exc) {
    return done("failed", `camo 地址解析失败（${exc.name}）`);
  }

  const match = CAMO_PATTERN.exec(htmlText);
  if (!match) {
    return done("failed", "未解析到 camo 地址");
  }

  try {
    await requestOnce(match[0], { method: "PURGE" });
  } catch (exc) {
    return done("failed", `PURGE 未成功（${exc.name}）`);
  }
  return done("ok", "已清除，访客下次请求回源");
}

// ---------------------------------------------------------------------------
// summary：写入 Actions 运行摘要
// ---------------------------------------------------------------------------

/** 从缓存明细算出本次最终汇总；结果随产物发布，下次直接对比，不再读明细。 */
function buildSummary(dir) {
  const files = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .sort()
    : [];
  const summary = {
    repo_count: files.length,
    total_commits: 0,
    total_additions: 0,
    total_deletions: 0,
    total_images: 0,
    latest_commit_timestamp: "",
    repos: {},
  };
  for (const name of files) {
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      continue;
    }
    const info = meta?._metadata ?? {};
    const item = {
      commits: intOf(info.total_commits),
      additions: intOf(info.total_additions),
      deletions: intOf(info.total_deletions),
      images: intOf(info.total_images),
      latest: info.latest_commit_timestamp ?? "",
    };
    summary.total_commits += item.commits;
    summary.total_additions += item.additions;
    summary.total_deletions += item.deletions;
    summary.total_images += item.images;
    if (item.latest > summary.latest_commit_timestamp) {
      summary.latest_commit_timestamp = item.latest;
    }
    summary.repos[name] = item;
  }
  return summary;
}

/** 读一份已算好的汇总；不存在或损坏时返回 null。 */
function readSummary(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data.repos === "object" ? data : null;
  } catch {
    return null;
  }
}

function formatDelta(value) {
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatNumber(Math.abs(value))}`;
}

/** 对比两次运行的最终汇总，只读数字对象，不碰明细。 */
function describeChanges(previous, current, failedRestore = 0) {
  if (!previous || !Object.keys(previous.repos).length) {
    return "首次运行或上次汇总不可用，暂无对比数据";
  }

  const commits = current.total_commits - previous.total_commits;
  const additions = current.total_additions - previous.total_additions;
  const deletions = current.total_deletions - previous.total_deletions;
  const images = current.total_images - previous.total_images;
  const added = Object.keys(current.repos).filter((name) => !previous.repos[name]);
  const removed = Object.keys(previous.repos).filter((name) => !current.repos[name]);

  const repoChanges = [];
  for (const name of Object.keys(current.repos)) {
    const before = previous.repos[name];
    const after = current.repos[name];
    if (!before) {
      continue;
    }
    const parts = [];
    if (after.commits !== before.commits) {
      parts.push(`提交 ${formatDelta(after.commits - before.commits)}`);
    }
    if (
      after.additions !== before.additions ||
      after.deletions !== before.deletions
    ) {
      parts.push(
        `增删行 ${formatDelta(after.additions - before.additions)} / ${formatDelta(after.deletions - before.deletions)}`,
      );
    }
    if (after.images !== before.images) {
      parts.push(`图片 ${formatDelta(after.images - before.images)}`);
    }
    if (after.latest !== before.latest) {
      parts.push("最新提交时间更新");
    }
    if (parts.length) {
      repoChanges.push(`${name.replace(/\.json$/, "")}（${parts.join("，")}）`);
    }
  }

  const latestChanged =
    previous.latest_commit_timestamp !== current.latest_commit_timestamp;
  const changed =
    commits !== 0 ||
    additions !== 0 ||
    deletions !== 0 ||
    images !== 0 ||
    latestChanged ||
    added.length ||
    removed.length ||
    repoChanges.length;

  const caveat =
    failedRestore > 0 ? `（${failedRestore} 份缓存恢复失败，对比可能不完整）` : "";
  if (!changed) {
    return `较上一次运行，各项数据均无变化${caveat}`;
  }

  const parts = [];
  if (commits !== 0) {
    parts.push(`提交 ${formatDelta(commits)}`);
  }
  if (additions !== 0 || deletions !== 0) {
    parts.push(`增删行 ${formatDelta(additions)} / ${formatDelta(deletions)}`);
  }
  if (images !== 0) {
    parts.push(`图片 ${formatDelta(images)}`);
  }
  if (latestChanged) {
    parts.push(`最新提交更新至 ${current.latest_commit_timestamp || "—"}`);
  }
  const lines = [`较上一次运行：${parts.join("，")}${caveat}`];

  const repoParts = [
    ...added.map((name) => `新增 ${name.replace(/\.json$/, "")}`),
    ...removed.map((name) => `移除 ${name.replace(/\.json$/, "")}`),
    ...repoChanges,
  ];
  if (repoParts.length) {
    lines.push(`仓库变化：${repoParts.join("，")}`);
  }
  return lines.join("\n");
}

function cmdSummary() {
  // 两次运行的最终汇总都是算好的数字，直接对比；本地缺产物时兜底现算本次
  const current =
    readSummary(path.join(SITE_DIR, "data", LATEST)) ?? buildSummary(CACHE_DIR);
  const previous = readSummary(PREVIOUS_SUMMARY);
  const {
    repo_count,
    total_commits: commits,
    total_additions: additions,
    total_deletions: deletions,
    total_images: images,
    latest_commit_timestamp: latest,
  } = current;

  const env = (name, fallback = "—") => {
    const value = (process.env[name] ?? "").trim();
    return value || fallback;
  };

  const deployed = env("DEPLOY", "") === "success";
  const result = env("PURGE_RESULT", "");
  const detail = env("PURGE_DETAIL", "");
  let purge;
  if (!deployed) {
    purge = "未执行（本次未部署）";
  } else {
    purge =
      {
        ok: "已清除",
        skipped: `未清除（${detail || "站点尚未同步"}）`,
        failed: `清除失败（${detail || "未知原因"}）`,
      }[result] ?? "未执行";
  }

  const trigger =
    { schedule: "定时任务", workflow_dispatch: "手动触发" }[env("EVENT_NAME", "")] ??
    env("EVENT_NAME");

  const net = additions - deletions;
  const page = env("PAGE_URL", "").replace(/\/+$/, "");
  const lines = [
    deployed ? "## 贡献卡片已更新" : "## 贡献统计未发布",
    "",
    "| 项目 | 值 |",
    "| --- | --- |",
    `| 触发方式 | ${trigger} |`,
    `| 统计账号 | ${env("ORIGIN")} |`,
    `| 上游账号 | ${env("UPSTREAM")} |`,
    `| 缓存仓库数 | ${repo_count} |`,
    `| 提交数 | ${formatNumber(commits)} |`,
    `| 新增 / 删除 | +${formatNumber(additions)} / -${formatNumber(deletions)}（净 ${net >= 0 ? "+" : ""}${formatNumber(net)}） |`,
    `| 图片 | ${formatNumber(images)} |`,
    `| 最新提交 | ${latest || "—"} |`,
    `| 缓存恢复 | ${env("RESTORED", "0")} 份（失败 ${env("RESTORE_FAILED", "0")}） |`,
    `| camo 缓存 | ${purge} |`,
    "",
  ];
  lines.push(
    "## 数据变化",
    "",
    describeChanges(previous, current, intOf(env("RESTORE_FAILED", "0"))),
    "",
  );
  if (page && deployed) {
    lines.push(
      `- 卡片：${page}/contributions.svg`,
      `- 明细清单：${page}/data/manifest.json`,
      "",
    );
  } else if (!deployed) {
    lines.push("- 本次未部署，站点内容保持上次发布的版本。", "");
  }

  const rows = TIMING_PHASES.map(([name, label]) => [label, parseSeconds(name)])
    .filter(([, seconds]) => seconds !== null)
    .map(([label, seconds]) => `| ${label} | ${formatDuration(seconds)} |`);
  const total = parseSeconds("SEC_TOTAL");
  if (rows.length || total !== null) {
    lines.push("## 耗时", "", "| 阶段 | 耗时 |", "| --- | --- |", ...rows);
    if (total !== null) {
      lines.push(`| **总计** | ${formatDuration(total)}（自确定目标用户起） |`);
    }
    lines.push("");
  }

  const text = lines.join("\n");
  console.log(text);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    fs.appendFileSync(summaryPath, `${text}\n`, { encoding: "utf8" });
  }
  return 0;
}

function intOf(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

function formatNumber(num) {
  return Number(num).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

const COMMANDS = {
  restore: cmdRestore,
  site: cmdSite,
  purge: cmdPurge,
  summary: cmdSummary,
};

async function main() {
  const command = process.argv[2];
  const handler = COMMANDS[command];
  if (!handler) {
    console.error("用法: node scripts/pipeline.js <restore|site|purge|summary>");
    return 2;
  }
  return await handler();
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exitCode = await main();
}

export {
  buildSummary,
  cmdSummary,
  describeChanges,
  formatDelta,
  formatDuration,
  jsonPrettyArray,
  readSummary,
  renderIndex,
};

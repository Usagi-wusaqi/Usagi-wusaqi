#!/usr/bin/env node
/**
 * GitHub 贡献统计脚本（零依赖，仅用 Node 内置模块）。
 *
 * 直接运行，无需编译：
 *     node scripts/generate_stats.js
 *
 * 环境变量：
 *     GH_TOKEN            GitHub 令牌（必需）
 *     EMAILS_TOKEN        账号本人令牌（必需，权限 user:email；自动发现仓库也用它，
 *                         因为 GraphQL 查的是「令牌持有者的贡献」，换成 Actions 内置
 *                         令牌就变成查 bot 自己了）
 *     ORIGIN_USERNAME     统计目标用户名（缺省时从 README.md 读取）
 *
 * 实现要点：
 *     1. 每个仓库只用 2 次 git 进程（1 次取 commit 元数据、1 次批量取 diff 统计），
 *        冷启动时进程数保持在个位数。
 *     2. HTTP 走内置 fetch，直接发请求，不起 curl 子进程。
 *     3. 仓库级并发；上游解析与克隆同时并发，API 并发度单独限制。
 *     4. 作者邮箱通过 GitHub API 读取，仅保存在内存中，不写入配置。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ============================================================================
// 常量与终端输出
// ============================================================================

const RED = "\u001b[0;31m";
const GREEN = "\u001b[0;32m";
const YELLOW = "\u001b[1;33m";
const NC = "\u001b[0m";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(SCRIPT_DIR);

// 记录分隔符：\x01 分隔字段，\x1f 分隔多个 trailer（均不会出现在正常文本中）
const FS = "\x01";
const TS = "\x1f";

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_SEPARATOR_LENGTH = 60;
const GIT_TIMEOUT_MS = 900_000;

function printColor(message, color = NC) {
  process.stdout.write(`${color}${message}${NC}\n`);
}

function printSeparator(
  title = null,
  color = GREEN,
  length = DEFAULT_SEPARATOR_LENGTH,
) {
  const sep = "=".repeat(length);
  printColor(sep, color);
  if (title) {
    printColor(title, color);
    printColor(sep, color);
  }
}

/** 仓库级日志缓冲：先在内存累积，完成后整块输出，避免并发交错。 */
class Log {
  constructor() {
    this.lines = [];
  }

  color(message, color = NC) {
    this.lines.push(`${color}${message}${NC}`);
  }

  separator(title, color = GREEN, length = DEFAULT_SEPARATOR_LENGTH) {
    const sep = "=".repeat(length);
    this.color(sep, color);
    this.color(title, color);
    this.color(sep, color);
  }

  flush() {
    if (!this.lines.length) {
      return;
    }
    process.stdout.write(`${this.lines.join("\n")}\n`);
    this.lines = [];
  }
}

/** 千分位格式化。 */
function formatNumber(num) {
  return Number(num).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function intOf(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

/** 日志里显示相对仓库根目录的路径，避免 CI 上出现超长的绝对路径。 */
function shortPath(target) {
  const rel = path.relative(PROJECT_ROOT, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return path.basename(target);
  }
  return rel.split(path.sep).join("/");
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// ============================================================================
// 时间戳
// ============================================================================

/** 解析 ISO 8601 为 Unix 秒；失败返回 -Infinity（排序时等价于最小值）。 */
function parseIsoTimestamp(text) {
  if (!text) {
    return -Infinity;
  }
  const value = String(text).trim();
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) {
    return parsed / 1000;
  }
  // 退化为只解析前 19 位（YYYY-MM-DDTHH:MM:SS），按 UTC 处理
  const trimmed = Date.parse(`${value.slice(0, 19)}Z`);
  return Number.isNaN(trimmed) ? -Infinity : trimmed / 1000;
}

function nowIsoUtc() {
  const iso = new Date().toISOString();
  const [head, tail] = iso.split(".");
  const micros = tail.replace("Z", "").padEnd(6, "0");
  return `${head}.${micros}+00:00`;
}

// ============================================================================
// 配置
// ============================================================================

const SVG_DEFAULTS = {
  custom_title: null,
  title_color: "#2f80ed",
  text_color: "#434d58",
  bg_color: "#fffefe",
  border_color: "#ffffff00",
  add_color: "#28a745",
  del_color: "#d73a49",
  img_color: "#6f42c1",
  width: 1200,
  height: 200,
};

const SVG_LAYOUT_DEFAULTS = {
  padding: 67,
  title_y: 70,
  stats_y: 120,
  value_gap: 36,
  border_radius: 4.5,
};

const SVG_FONT_DEFAULTS = {
  family: "'Segoe UI', Ubuntu, Sans-Serif",
  family_extended: "'Segoe UI', Ubuntu, 'Helvetica Neue', Sans-Serif",
  header_size: "600 48px",
  header_size_firefox: "41px",
  stat_size: "600 20px",
  bold_size: "700 36px",
};

const SVG_LABEL_DEFAULTS = {
  additions: "Additions",
  deletions: "Deletions",
  net: "Net",
  images: "Images",
};

const API_DEFAULTS = {
  github_api_base: "https://api.github.com",
  max_api_pages: 10,
  per_page: 100,
  rate_limit_warn_threshold: 50,
};

const REPOS_DEFAULTS = {
  discover: true,
  include: [],
  exclude: [],
};

const BEHAVIOR_DEFAULTS = {
  separator_length: DEFAULT_SEPARATOR_LENGTH,
  image_extensions: [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".svg",
    ".webp",
    ".ico",
  ],
  progress_interval: 10,
  concurrency: DEFAULT_CONCURRENCY,
};

function merged(section, defaults) {
  const out = { ...defaults };
  for (const [key, value] of Object.entries(section ?? {})) {
    if (value !== null && value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 解析配置文件用到的 TOML 子集：表头、键值对、带引号的字符串、
 * 数字、布尔与数组。遇到不认识的行直接报错，由调用方回退到默认配置。
 */
function parseToml(text) {
  const root = {};
  let table = root;

  const stripComment = (line) => {
    let quote = null;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quote) {
        if (ch === "\\" && quote === '"') {
          i += 1;
        } else if (ch === quote) {
          quote = null;
        }
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "#") {
        return line.slice(0, i);
      }
    }
    return line;
  };

  const parseString = (raw, lineNo) => {
    const quote = raw[0];
    let out = "";
    for (let i = 1; i < raw.length; i += 1) {
      const ch = raw[i];
      if (quote === '"' && ch === "\\") {
        const next = raw[i + 1];
        i += 1;
        const escapes = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };
        if (next in escapes) {
          out += escapes[next];
        } else if (next === "u") {
          const hex = raw.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new Error(`第 ${lineNo} 行：无效的 \\u 转义`);
          }
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 4;
        } else {
          throw new Error(`第 ${lineNo} 行：无法识别的转义 \\${next}`);
        }
        continue;
      }
      if (ch === quote) {
        if (raw.slice(i + 1).trim()) {
          throw new Error(`第 ${lineNo} 行：字符串后有多余内容`);
        }
        return out;
      }
      out += ch;
    }
    throw new Error(`第 ${lineNo} 行：字符串未闭合`);
  };

  const splitTopLevel = (raw) => {
    const parts = [];
    let depth = 0;
    let quote = null;
    let current = "";
    for (const ch of raw) {
      if (quote) {
        current += ch;
        if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
      } else if (ch === "[") {
        depth += 1;
        current += ch;
      } else if (ch === "]") {
        depth -= 1;
        current += ch;
      } else if (ch === "," && depth === 0) {
        parts.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    if (current.trim()) {
      parts.push(current.trim());
    }
    return parts;
  };

  const parseValue = (raw, lineNo) => {
    const value = raw.trim();
    if (!value) {
      throw new Error(`第 ${lineNo} 行：缺少取值`);
    }
    if (value.startsWith('"') || value.startsWith("'")) {
      return parseString(value, lineNo);
    }
    if (value.startsWith("[")) {
      if (!value.endsWith("]")) {
        throw new Error(`第 ${lineNo} 行：数组未闭合`);
      }
      return splitTopLevel(value.slice(1, -1)).map((item) =>
        parseValue(item, lineNo),
      );
    }
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
    const numeric = value.replaceAll("_", "");
    if (/^[+-]?\d+$/.test(numeric)) {
      return Number.parseInt(numeric, 10);
    }
    if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(numeric)) {
      return Number.parseFloat(numeric);
    }
    throw new Error(`第 ${lineNo} 行：无法解析的取值 ${value}`);
  };

  const descend = (name, lineNo) => {
    const keys = name.split(".").map((key) => key.trim());
    let node = root;
    for (const key of keys) {
      if (!key) {
        throw new Error(`第 ${lineNo} 行：表名为空`);
      }
      if (!(key in node)) {
        node[key] = {};
      }
      const next = node[key];
      if (typeof next !== "object" || Array.isArray(next)) {
        throw new Error(`第 ${lineNo} 行：${key} 已是取值，不能作为表名`);
      }
      node = next;
    }
    return node;
  };

  /** 括号是否已经配平到数组结尾，用于判断跨行数组何时结束。 */
  const arrayClosed = (raw) => {
    let depth = 0;
    let quote = null;
    for (let i = 0; i < raw.length; i += 1) {
      const ch = raw[i];
      if (quote) {
        if (ch === "\\" && quote === '"') {
          i += 1;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "[") {
        depth += 1;
      } else if (ch === "]") {
        depth -= 1;
        if (depth === 0) {
          return true;
        }
      }
    }
    return false;
  };

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const line = stripComment(lines[index]).trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("[")) {
      if (!line.endsWith("]")) {
        throw new Error(`第 ${lineNo} 行：表头未闭合`);
      }
      table = descend(line.slice(1, -1), lineNo);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      throw new Error(`第 ${lineNo} 行：缺少 =`);
    }
    const key = line.slice(0, eq).trim();
    if (!key) {
      throw new Error(`第 ${lineNo} 行：键名为空`);
    }
    let valueText = line.slice(eq + 1);
    // 数组允许换行书写，逐行拼接直到括号配平；行内注释照常剥离
    if (valueText.trim().startsWith("[") && !arrayClosed(valueText)) {
      let closed = false;
      while (index + 1 < lines.length) {
        index += 1;
        valueText += ` ${stripComment(lines[index]).trim()}`;
        if (arrayClosed(valueText)) {
          closed = true;
          break;
        }
      }
      if (!closed) {
        throw new Error(`第 ${lineNo} 行：数组未闭合`);
      }
    }
    table[key] = parseValue(valueText, lineNo);
  }

  return root;
}

class App {
  constructor(originUsername, token) {
    this.originUsername = originUsername;
    this.token = token;
    setGitAuth(token);

    this.configPath = path.join(PROJECT_ROOT, "config.toml");
    this.svgPath = path.join(PROJECT_ROOT, "contributions.svg");
    this.cacheDir = path.join(SCRIPT_DIR, "stats_cache");

    const raw = this.loadRawConfig();
    this.api = merged(raw.api, API_DEFAULTS);
    this.behavior = merged(raw.behavior, BEHAVIOR_DEFAULTS);

    // 统计范围：要不要自动查询「有自己提交的仓库」；关掉后只剩 include 清单
    this.repos = merged(raw.repos, REPOS_DEFAULTS);
    this.repos.discover = Boolean(this.repos.discover);
    const asRepoList = (value) =>
      Array.isArray(value) ? value.map((item) => String(item)) : [];
    this.repos.include = asRepoList(this.repos.include);
    this.repos.exclude = asRepoList(this.repos.exclude);

    const svgRaw = { ...(raw.svg ?? {}) };
    this.svg = merged(svgRaw, SVG_DEFAULTS);
    this.svg.layout = merged(svgRaw.layout, SVG_LAYOUT_DEFAULTS);
    this.svg.font = merged(svgRaw.font, SVG_FONT_DEFAULTS);
    this.svg.labels = merged(svgRaw.labels, SVG_LABEL_DEFAULTS);

    this.imageExtensions = (this.behavior.image_extensions ?? []).map((ext) =>
      String(ext).toLowerCase(),
    );

    // 运行时获取的邮箱，仅保存在内存中，不回写配置
    this.emails = new Set();
    // 账号邮箱令牌（user:email 权限），用于读取账号下的全部邮箱
    this.emailsToken = process.env.EMAILS_TOKEN ?? "";
    this.rateLimit = null;
  }

  loadRawConfig() {
    if (!fs.existsSync(this.configPath)) {
      return {};
    }
    try {
      return parseToml(fs.readFileSync(this.configPath, "utf8"));
    } catch (exc) {
      printColor(
        `⚠️  config.toml 解析失败，使用默认配置: ${exc.message}`,
        YELLOW,
      );
      return {};
    }
  }

  /** 并入新发现的邮箱，返回真正新增的数量。 */
  addEmails(found) {
    if (!found || !found.size) {
      return 0;
    }
    const before = this.emails.size;
    for (const email of found) {
      this.emails.add(email);
    }
    return this.emails.size - before;
  }

  snapshotEmails() {
    return [...this.emails].sort();
  }

  setRateLimit(message) {
    if (this.rateLimit === null) {
      this.rateLimit = message;
    }
  }

  cacheFile(repoName) {
    return path.join(this.cacheDir, `${repoName}.json`);
  }
}

/** 从 README.md 读取 `VAR = 值` 形式的默认值。 */
function getDefaultFromReadme(readmePath, varName) {
  if (!fs.existsSync(readmePath)) {
    return null;
  }
  const marker = `${varName} = `;
  const text = fs.readFileSync(readmePath, "utf8");
  for (const line of text.split("\n")) {
    const pos = line.indexOf(marker);
    if (pos >= 0) {
      const value = line.slice(pos + marker.length).trim();
      if (value) {
        return value;
      }
    }
  }
  return null;
}

// ============================================================================
// HTTP（内置 fetch，替代 curl 子进程）
// ============================================================================

class ApiError extends Error {
  constructor(kind, message = "") {
    super(message);
    this.name = "ApiError";
    this.kind = kind; // "rate_limit" | "failure"
    this.message = message;
  }
}

async function githubApiRequest(app, url, token = null) {
  const headers = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "generate-stats",
  };
  const auth = token === null ? app.token : token;
  if (auth) {
    headers.Authorization = `token ${auth}`;
  }

  let status;
  let remaining;
  let body;
  try {
    const response = await fetch(url, {
      headers,
      method: "GET",
      signal: AbortSignal.timeout(60_000),
    });
    status = response.status;
    remaining = response.headers.get("x-ratelimit-remaining");
    body = await response.text();
  } catch {
    printColor("❌ 网络请求失败", RED);
    throw new ApiError("failure");
  }

  if (status >= 200 && status < 400) {
    if (remaining !== null && remaining !== undefined) {
      const left = Number.parseInt(remaining, 10);
      if (
        Number.isFinite(left) &&
        left < intOf(app.api.rate_limit_warn_threshold, 50)
      ) {
        printColor(`⚠️  API 配额剩余: ${remaining}`, YELLOW);
      }
    }
    return body;
  }

  if (status === 403 || status === 429) {
    const left = remaining === null ? -1 : Number.parseInt(remaining, 10);
    if (left === 0 || Number.isNaN(left) || status === 429) {
      let message = `HTTP ${status}`;
      try {
        message = JSON.parse(body).message || message;
      } catch {
        // 保持 HTTP 状态码作为提示
      }
      throw new ApiError("rate_limit", `GitHub API 配额耗尽: ${message}`);
    }
  }

  let detail = "";
  try {
    detail = JSON.parse(body).message ?? "";
  } catch {
    detail = "";
  }
  throw new ApiError(
    "failure",
    `HTTP ${status}` + (detail ? `: ${detail}` : ""),
  );
}

/** 请求并解析 JSON；HTTP 失败抛 ApiError，响应不是 JSON 时返回 null。 */
async function apiJson(app, url, token = null) {
  const body = await githubApiRequest(app, url, token);
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * 发一条 GraphQL 查询，返回响应里的 `data`。
 *
 * GraphQL 出错也回 200，错误藏在 `body.errors` 里，只看状态码会把失败当成功；
 * 配额耗尽则沿用 REST 那套判断（403/429 且剩余额度为 0）。
 */
async function graphqlJson(app, query, variables = {}, token = null) {
  const auth = token === null ? app.token : token;
  if (!auth) {
    throw new ApiError("failure", "缺少令牌，无法查询 GraphQL");
  }

  let response;
  let raw;
  try {
    response = await fetch(`${app.api.github_api_base}/graphql`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "generate-stats",
        Authorization: `bearer ${auth}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(60_000),
    });
    raw = await response.text();
  } catch {
    printColor("❌ 网络请求失败", RED);
    throw new ApiError("failure");
  }

  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }

  if (response.status === 403 || response.status === 429) {
    const left = Number.parseInt(
      response.headers.get("x-ratelimit-remaining") ?? "",
      10,
    );
    if (!Number.isFinite(left) || left === 0 || response.status === 429) {
      throw new ApiError("rate_limit", "GitHub GraphQL 配额耗尽");
    }
  }
  if (!response.ok) {
    const detail = body?.message ? `: ${body.message}` : "";
    throw new ApiError("failure", `HTTP ${response.status}${detail}`);
  }
  if (Array.isArray(body?.errors) && body.errors.length) {
    throw new ApiError(
      "failure",
      String(body.errors[0]?.message || "GraphQL 查询失败"),
    );
  }
  return body?.data ?? null;
}

// ============================================================================
// GitHub 上游 / 邮箱收集
// ============================================================================

function repoOwnerFromUrl(repoUrl) {
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+\/([^/]+)\//.exec(repoUrl);
  if (scheme) {
    return scheme[1];
  }
  const bare = /^([^/:]+)\//.exec(repoUrl);
  return bare ? bare[1] : null;
}

/**
 * 接口每页最多回 100 条，配置写大也只回 100。逐个钳制，否则拿配置值判断
 * 「这一页排满没」会把「还有下一页」误判成「到底了」，列表悄悄少一截。
 */
function apiPerPage(app) {
  return Math.min(Math.max(intOf(app.api.per_page, 100), 1), 100);
}

function upstreamOf(repo) {
  for (const key of ["source", "parent"]) {
    const value = repo?.[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
  }
  return null;
}

/**
 * 解析 fork 的上游，返回 `[owner, name, unknown]`。
 *
 * `unknown` 为真表示没能确认 fork 关系（配额耗尽、网络失败、详情读不到）。
 * 这时不能把它当独立仓库克隆，否则可能和上游重复计数，由调用方本轮跳过。
 */
async function getUpstreamRepo(app, repo, request = apiJson) {
  // fork 字段明确为 false 才跳过；未知时（清单里的仓库）仍要查一次详情，
  // 否则 fork 会被当成独立仓库、与上游重复统计
  if (repo?.fork === false) {
    return [null, null, false];
  }

  let upstream = upstreamOf(repo);
  if (upstream === null) {
    const name = repo.name;
    if (!name) {
      return [null, null, false];
    }
    // 按仓库自己的归属去查，贡献清单里的仓库未必属于本账号
    const path = repo.full_name || `${app.originUsername}/${name}`;
    const url = `${app.api.github_api_base}/repos/${path}`;
    let detail;
    try {
      detail = await request(app, url);
    } catch {
      return [null, null, true];
    }
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
      return [null, null, true];
    }
    upstream = upstreamOf(detail);
  }

  if (upstream && typeof upstream === "object") {
    const owner = (upstream.owner ?? {}).login;
    const name = upstream.name;
    if (owner && name) {
      return [owner, name, false];
    }
  }
  return [null, null, false];
}

/**
 * 把 `owner/name`、完整地址或带 .git 的地址统一成 `owner/name`；不合法返回空串。
 */
function normalizeFullName(value) {
  const text = String(value ?? "")
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  const match = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(text);
  return match ? `${match[1]}/${match[2]}` : "";
}

/** 仓库在整轮统计里的唯一标识，用于去重与排除；大小写不敏感。 */
function repoKeyOf(repo) {
  const full = normalizeFullName(repo?.full_name);
  if (full) {
    return full.toLowerCase();
  }
  const owner = repoOwnerFromUrl(String(repo?.html_url ?? ""));
  const name = String(repo?.name ?? "").trim();
  return owner && name ? `${owner}/${name}`.toLowerCase() : "";
}

/**
 * 由 `owner/name` 造一份最小仓库记录；fork 关系未知，留待解析上游时查详情。
 */
function repoFromFullName(full, id = undefined) {
  const normalized = normalizeFullName(full);
  if (!normalized) {
    return null;
  }
  const [owner, name] = normalized.split("/");
  const repo = {
    name,
    full_name: `${owner}/${name}`,
    html_url: `https://github.com/${owner}/${name}`,
  };
  if (id !== undefined && id !== null) {
    repo.id = id;
  }
  return repo;
}

/**
 * 把 GraphQL 返回的仓库节点变成仓库记录。
 *
 * `fork` 与 `parent` 直接照 REST 详情的形状填上，后面解析克隆目标时
 * `upstreamOf()` 能直接命中，省掉每个仓库一次详情请求。`fullDatabaseId` 与 REST
 * 的 `id` 是同一个值（`databaseId` 是 32 位整型，ID 超出范围时会返回 null），
 * 仓库改名后缓存靠它接续，不会被当成新仓库重算。
 */
function repoFromGraphqlNode(node) {
  const full = normalizeFullName(node?.nameWithOwner);
  if (!full) {
    return null;
  }
  const [owner, name] = full.split("/");
  const repo = {
    name,
    full_name: full,
    html_url: `https://github.com/${full}`,
    private: node?.isPrivate === true,
    fork: node?.isFork === true,
  };
  if (node?.fullDatabaseId !== null && node?.fullDatabaseId !== undefined) {
    repo.id = node.fullDatabaseId;
  }
  const parentFull = normalizeFullName(node?.parent?.nameWithOwner);
  if (repo.fork && parentFull) {
    const [parentOwner, parentName] = parentFull.split("/");
    repo.parent = { name: parentName, owner: { login: parentOwner } };
    // GraphQL 没有 REST 的 `source`（fork 网络的根）。父仓库本身还是 fork 时，
    // 往上再取一层当根：只克隆直接父仓库会与根仓库的历史重叠，同一批提交算两遍
    const rootFull = normalizeFullName(node?.parent?.parent?.nameWithOwner);
    if (rootFull) {
      const [rootOwner, rootName] = rootFull.split("/");
      repo.source = { name: rootName, owner: { login: rootOwner } };
    }
  }
  return repo;
}

/** 贡献清单用的查询：按仓库分组，一页 100 个，游标翻页。 */
const CONTRIBUTED_REPOS_QUERY = `
query ($cursor: String) {
  viewer {
    login
    repositoriesContributedTo(
      first: 100
      after: $cursor
      includeUserRepositories: true
      contributionTypes: [COMMIT]
      orderBy: { field: NAME, direction: ASC }
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        nameWithOwner
        isPrivate
        isFork
        fullDatabaseId
        parent {
          nameWithOwner
          parent { nameWithOwner }
        }
      }
    }
  }
}`;

/**
 * 用 GraphQL 的 `repositoriesContributedTo` 列出「有自己提交的仓库」。
 *
 * 主页贡献图的口径就是它：按账号归属统计默认分支（含 gh-pages）上的提交，
 * 直接给出仓库清单，不用先搜提交再反查仓库。名单覆盖全部历史，没有时间窗，
 * 单页 100 个、游标翻页即可拿全，返回的每个仓库还带着 fork 与上游关系。
 *
 * 令牌必须是账号本人的：Actions 内置令牌的身份是 bot，查到的 viewer 是它自己。
 * 因此拿到的登录名与统计目标不符时整轮放弃，免得把空名单当成「没有贡献的仓库」
 * 去覆盖缓存。
 */
async function discoverRepos(app, request = null) {
  // 默认走账号邮箱令牌（本人的 PAT）；测试可以注入一个假实现
  const ask =
    request ??
    ((instance, query, variables) =>
      graphqlJson(
        instance,
        query,
        variables,
        instance.emailsToken || instance.token,
      ));
  const maxPages = Math.max(intOf(app.api.max_api_pages, 10), 1);
  const found = new Map();
  // 私有仓库不进统计（卡片只算公开仓库），记下来只为日志和清缓存
  const privateRepos = new Map();
  let complete = true;
  let cursor = null;

  for (let page = 0; page < maxPages; page += 1) {
    let data;
    try {
      data = await ask(app, CONTRIBUTED_REPOS_QUERY, { cursor });
    } catch (exc) {
      // 配额用完或接口出错：已找到的照常并进名单，本轮标记为不完整，
      // 调用方据此保留旧缓存，不会把历史名单清掉
      const limited = exc instanceof ApiError && exc.kind === "rate_limit";
      printColor(
        limited
          ? "⚠️  GraphQL 配额用完，本轮只覆盖到已找到的仓库"
          : `⚠️  贡献仓库查询中断，仅统计已找到的仓库: ${exc?.message || "请求失败"}`,
        YELLOW,
      );
      complete = false;
      break;
    }

    const viewer = data?.viewer;
    if (!viewer) {
      printColor("⚠️  贡献仓库查询没有返回 viewer，本轮跳过自动发现", YELLOW);
      complete = false;
      break;
    }
    if (
      page === 0 &&
      String(viewer.login ?? "").toLowerCase() !==
        String(app.originUsername ?? "").toLowerCase()
    ) {
      printColor(
        `⚠️  查询所用令牌属于 ${viewer.login || "未知账号"}，与统计目标 ` +
          `${app.originUsername} 不一致，本轮跳过自动发现`,
        YELLOW,
      );
      return { repos: [], privateRepos: [], complete: false };
    }

    const collection = viewer.repositoriesContributedTo;
    const nodes = Array.isArray(collection?.nodes) ? collection.nodes : [];
    for (const node of nodes) {
      const repo = repoFromGraphqlNode(node);
      if (!repo) {
        continue;
      }
      const key = repoKeyOf(repo);
      if (repo.private) {
        if (!privateRepos.has(key)) {
          privateRepos.set(key, repo.full_name);
        }
      } else if (!found.has(key)) {
        found.set(key, repo);
      }
    }

    if (!collection?.pageInfo?.hasNextPage) {
      break;
    }
    cursor = collection.pageInfo.endCursor ?? null;
    if (!cursor) {
      complete = false;
      break;
    }
    if (page === maxPages - 1) {
      // 翻到配置的页数上限还没到底：名单只并已找到的部分
      complete = false;
      printColor(
        `⚠️  贡献仓库超过 ${maxPages} 页（${maxPages * 100} 个），只覆盖到前面部分`,
        YELLOW,
      );
    }
  }

  return {
    repos: [...found.values()],
    privateRepos: [...privateRepos.values()],
    complete,
  };
}

/** 发现结果的落盘位置：放缓存目录的子目录，不会被按仓库名清理的 .json 扫到。 */
function scopeCacheFile(app) {
  return path.join(app.cacheDir, "scope", "index.json");
}

/** 读回上次的发现结果；文件缺失或损坏时返回 null，视为还没有名单。 */
function loadScopeCache(app) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(scopeCacheFile(app), "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const repos = [];
  for (const item of Array.isArray(raw.repos) ? raw.repos : []) {
    const repo = repoFromFullName(item?.full_name, item?.id);
    if (repo) {
      repos.push(repo);
    }
  }
  return { repos };
}

function saveScopeCache(app, payload) {
  const file = scopeCacheFile(app);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch (exc) {
    printColor(`⚠️  统计范围缓存写入失败: ${exc.message}`, YELLOW);
  }
}

/** 合并两份仓库清单，按全名去重，先出现的优先。 */
function mergeRepoLists(first, second) {
  const seen = new Set();
  const out = [];
  for (const repo of [...first, ...second]) {
    const key = repoKeyOf(repo);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(repo);
  }
  return out;
}

/**
 * 落盘本轮统计范围：查询完整时以本轮为准，仓库删除、转私有、失去访问权都会
 * 自然退出名单；查询不完整（配额用完、翻页中断）时与上一轮合并，只增不减，
 * 已知仓库不会因为一次失败就掉队。
 *
 * 名单本身仍是缓存的意义所在：查询彻底失败时下一轮还能拿它兜底，站点上的
 * scope.json 也从这里来。私有仓库不进统计，两种情况都从名单里摘掉。
 */
async function discoverScopeRepos(app, request = null) {
  const cached = loadScopeCache(app);
  const found = await discoverRepos(app, request);

  const privateKeys = new Set(
    found.privateRepos.map((full) => full.toLowerCase()),
  );
  const repos = (
    found.complete
      ? found.repos
      : mergeRepoLists(cached?.repos ?? [], found.repos)
  ).filter((repo) => !privateKeys.has(repoKeyOf(repo)));

  saveScopeCache(app, {
    version: 2,
    updated_at: nowIsoUtc(),
    repos: repos.map((repo) => ({
      full_name: repo.full_name,
      ...(repo.id !== undefined ? { id: repo.id } : {}),
    })),
  });

  return {
    repos,
    privateRepos: found.privateRepos,
    complete: found.complete,
    fresh: found.repos.length,
  };
}

/**
 * 确认显式清单里的仓库是否可用：私有、不存在或无权访问的剔除，其余读取失败时
 * 按原样保留。
 *
 * 清单是用户手写的补漏手段，网络抖动或配额不足不该让它凭空消失，因此只有
 * 明确失败的才剔除——私有用详情里的标记判断，删除或无权访问则只回 404。
 * 返回仓库记录列表：读到详情的直接带上 `fork` 与上游关系，后面解析克隆目标时
 * 不必再查一次；读不到详情的退回只有名字的最小记录。
 */
async function confirmIncludedRepos(app, include, request = apiJson) {
  const list = [];
  for (const item of Array.isArray(include) ? include : []) {
    const repo = repoFromFullName(item);
    if (repo) {
      list.push(repo);
    } else {
      // 写成 owner/name 以外的形式（比如带 /tree/main 的页面地址）会被静默丢掉，
      // 这里明确提示一句，免得清单看起来配了却没生效
      printColor(`  ⚠️  清单项无法识别，已忽略: ${item}`, YELLOW);
    }
  }
  if (!list.length) {
    return [];
  }

  const base = app.api.github_api_base;
  const limit = Math.max(
    Math.min(intOf(app.behavior.concurrency, DEFAULT_CONCURRENCY), 4),
    1,
  );
  let rateLimited = false;
  const results = await mapPool(list, limit, async (repo) => {
    const full = repo.full_name;
    const fallback = { status: "kept", full, repo };
    if (rateLimited) {
      return fallback;
    }
    try {
      const detail = await request(app, `${base}/repos/${full}`);
      if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
        return fallback;
      }
      if (detail.private) {
        return { status: "private", full };
      }
      // 详情里带着 fork 与上游关系，传下去就能省掉解析克隆目标时的一次请求
      return { status: "ok", full, repo: detail };
    } catch (exc) {
      if (exc instanceof ApiError && exc.kind === "rate_limit") {
        rateLimited = true;
        return fallback;
      }
      // 404 是删除或无权访问，与自动发现同口径剔除；5xx、超时等保留
      if (exc instanceof ApiError && /^HTTP 404\b/.test(exc.message)) {
        return { status: "missing", full };
      }
      return fallback;
    }
  });

  const kept = [];
  for (const item of results) {
    if (item.status === "private") {
      printColor(`  ⊘ 跳过 ${item.full}（清单中的私有仓库）`, YELLOW);
      continue;
    }
    if (item.status === "missing") {
      printColor(`  ⊘ 移除 ${item.full}（清单中的仓库不存在或无权访问）`, YELLOW);
      continue;
    }
    kept.push(item.repo);
  }
  if (rateLimited) {
    printColor("  ⚠️  配额不足，清单中的仓库按原样纳入", YELLOW);
  }
  return kept;
}

/**
 * 合并统计范围：额外的 `include` 清单在前，自动发现的仓库在后。
 *
 * 名字相同的仓库只保留最先出现的那条，排除名单按 `owner/name` 精确匹配。
 */
function mergeRepos(discovered = [], include = [], exclude = []) {
  const skip = new Set(
    exclude.map((item) => normalizeFullName(item).toLowerCase()).filter(Boolean),
  );
  const seen = new Set();
  const repos = [];
  const added = { included: 0, discovered: 0 };
  let excluded = 0;

  const take = (repo, bucket) => {
    // 只统计公开仓库：贡献清单已按可见性剔除，这里统一再挡一次
    if (repo?.private) {
      return;
    }
    const key = repoKeyOf(repo);
    if (!key) {
      return;
    }
    if (skip.has(key)) {
      excluded += 1;
      return;
    }
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    repos.push(repo);
    added[bucket] += 1;
  };

  for (const item of include) {
    // 清单项通常是 confirmIncludedRepos 带回来的仓库详情（已含 fork 与上游关系），
    // 也允许直接传 owner/name 字符串
    const repo =
      item && typeof item === "object"
        ? normalizeFullName(item.full_name)
          ? item
          : null
        : repoFromFullName(item);
    if (repo) {
      take(repo, "included");
    }
  }
  for (const repo of discovered) {
    take(repo, "discovered");
  }
  return { repos, added, excluded };
}

/**
 * 读取账号下的全部邮箱，需要带 user:email 权限的令牌。
 *
 * 返回值即统计口径的全部依据；为空表示无法确定归属，调用方应中止运行。
 */
async function fetchAccountEmails(app) {
  if (!app.emailsToken) {
    return new Set();
  }

  const base = app.api.github_api_base;
  const token = app.emailsToken;

  let me;
  try {
    me = await apiJson(app, `${base}/user`, token);
  } catch (exc) {
    if (exc instanceof ApiError) {
      throw new ApiError(
        exc.kind,
        `邮箱令牌校验失败: ${exc.message || "请求失败"}`,
      );
    }
    throw exc;
  }
  const login = String(me?.login ?? "").trim();
  if (login.toLowerCase() !== app.originUsername.toLowerCase()) {
    throw new ApiError(
      "failure",
      `邮箱令牌属于 ${login || "未知账号"}，与 ${app.originUsername} 不一致`,
    );
  }

  const perPage = apiPerPage(app);
  const limit = intOf(app.api.max_api_pages, 10);
  const emails = new Set();
  for (let page = 1; page <= limit; page += 1) {
    const url = `${base}/user/emails?per_page=${perPage}&page=${page}`;
    let data;
    try {
      data = await apiJson(app, url, token);
    } catch (exc) {
      if (exc instanceof ApiError) {
        throw new ApiError(
          exc.kind,
          `读取邮箱列表失败: ${exc.message || "请求失败"}`,
        );
      }
      throw exc;
    }
    if (!Array.isArray(data) || !data.length) {
      break;
    }
    for (const item of data) {
      // 账号下的邮箱都参与匹配，不区分是否已验证
      const email = String(item?.email ?? "").trim().toLowerCase();
      if (email) {
        emails.add(email);
      }
    }
    if (data.length < perPage) {
      break;
    }
  }
  return emails;
}

// ============================================================================
// git 操作
// ============================================================================

let gitAuthArgs = [];

/**
 * 把令牌放进请求头而非仓库地址，避免写进 .git/config。
 *
 * 通过 `-c` 传入，取值为环境变量形式，子进程（含懒拉取 blob 的 fetch）
 * 同样生效，仓库地址保持干净。
 */
function setGitAuth(token) {
  if (!token) {
    gitAuthArgs = [];
    return;
  }
  const pair = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  gitAuthArgs = [
    "-c",
    `http.https://github.com/.extraheader=AUTHORIZATION: basic ${pair}`,
  ];
}

/** 返回 { stdout, stderr, code }，失败原因交给调用方决定是否展示。 */
function runGitRaw(args, { cwd = null, stdinData = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn("git", [...gitAuthArgs, ...args], {
      cwd: cwd ?? undefined,
      // 令牌无效时直接失败，不等待交互式输入
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const out = [];
    const err = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
    }, GIT_TIMEOUT_MS);

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (exc) => {
      finish({ stdout: "", stderr: String(exc), code: 1 });
    });
    child.on("close", (code) => {
      finish({
        stdout: Buffer.concat(out).toString("utf8").trim(),
        stderr: Buffer.concat(err).toString("utf8").trim(),
        code: code ?? 1,
      });
    });

    child.stdin.on("error", () => {
      // 子进程提前退出时忽略 EPIPE
    });
    child.stdin.end(stdinData === null ? "" : stdinData);
  });
}

async function runGit(args, options = {}) {
  const { stdout, code } = await runGitRaw(args, options);
  return { stdout, code };
}

class CloneError extends Error {
  /** 仓库无法就绪，该仓库的统计结果不可信。 */
  constructor(message) {
    super(message);
    this.name = "CloneError";
  }
}

/** 取分支的 commit SHA，可指定取本地记录还是远端当前值。 */
async function branchSha(repoPath, remote, branch, { atRemote }) {
  if (!atRemote) {
    const { stdout, code } = await runGit(
      ["rev-parse", `refs/remotes/${remote}/${branch}`],
      { cwd: repoPath },
    );
    return code === 0 ? stdout.trim() : "";
  }

  const { stdout, code } = await runGit(["ls-remote", "--heads", remote, branch], {
    cwd: repoPath,
  });
  if (code !== 0) {
    return "";
  }
  const expected = `refs/heads/${branch}`;
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) {
      continue;
    }
    if (line.slice(tab + 1).trim() === expected) {
      return line.slice(0, tab).trim();
    }
  }
  return "";
}

async function remoteNameOf(repoPath) {
  const { stdout } = await runGit(["remote"], { cwd: repoPath });
  const names = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return names.length ? names[0] : "origin";
}

/** 返回 [远程名, 默认分支]。本地记录缺失时向远端查询一次。 */
async function defaultBranchOf(repoPath, remote = null) {
  const name = remote ?? (await remoteNameOf(repoPath));
  const prefix = `refs/remotes/${name}/`;
  const symbolic = await runGit(["symbolic-ref", `refs/remotes/${name}/HEAD`], {
    cwd: repoPath,
  });
  if (symbolic.code === 0 && symbolic.stdout.startsWith(prefix)) {
    return [name, symbolic.stdout.slice(prefix.length)];
  }

  // 本地没有记录符号引用时问远端，避免把 master 默认分支错猜成 main
  const listed = await runGit(["ls-remote", "--symref", name, "HEAD"], {
    cwd: repoPath,
  });
  if (listed.code === 0) {
    for (const line of listed.stdout.split("\n")) {
      // 形如 `ref: refs/heads/main\tHEAD`
      if (line.startsWith("ref:")) {
        const ref = line.slice(4).trim().split(/\s+/)[0];
        if (ref.startsWith("refs/heads/")) {
          return [name, ref.slice("refs/heads/".length)];
        }
      }
    }
  }
  return [name, "main"];
}

async function cloneOrUpdate(repoPath, cloneUrl, log) {
  if (fs.existsSync(repoPath)) {
    const remote = await remoteNameOf(repoPath);
    // 上游可能改名或转让，让远端地址始终跟随当前仓库
    await runGit(["remote", "set-url", remote, cloneUrl], { cwd: repoPath });
    const [, branch] = await defaultBranchOf(repoPath, remote);
    const localSha = await branchSha(repoPath, remote, branch, {
      atRemote: false,
    });
    // 只比对远端分支的 SHA，没有新提交时一次网络往返即可，不触发对象协商
    if (
      localSha &&
      localSha ===
        (await branchSha(repoPath, remote, branch, { atRemote: true }))
    ) {
      log.color("  ✅ 已是最新", GREEN);
      return;
    }
    log.color("  🔄 拉取新增提交...", YELLOW);
    // 显式 refspec：单分支克隆的默认 refspec 不会跟踪新分支，
    // 上游改默认分支名后仍能把新分支拉到本地
    const fetched = await runGit(
      [
        "fetch",
        remote,
        `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
        "--prune",
        "--no-tags",
      ],
      { cwd: repoPath },
    );
    if (fetched.code === 0) {
      return;
    }
    // 本地克隆损坏、远端地址变更或网络中断：清掉重新克隆，避免沿用旧历史
    log.color("  ⚠️  更新失败，重新克隆", YELLOW);
    fs.rmSync(repoPath, { recursive: true, force: true });
  }

  log.color("  📥 克隆仓库...", YELLOW);
  // 只取默认分支：gh-pages 上是构建出来的页面而不是代码，不计行数，不值得多拉一份
  // 历史。统计只需要 commit 与 tree 对象；文件内容（blob）只在缓存未命中的少数 commit
  // 计算增删行数时才用到，git 会按需补拉。这类仓库的对象里有 96% 以上是 blob，
  // 因此用 blobless 部分克隆压掉下载量，比全量拉取省一个数量级。
  let code = 1;
  let detail = "";
  for (const filterArgs of [["--filter=blob:none"], []]) {
    const result = await runGitRaw(
      [
        "clone",
        ...filterArgs,
        "--no-checkout",
        "--single-branch",
        "--no-tags",
        cloneUrl,
        path.basename(repoPath),
      ],
      { cwd: path.dirname(repoPath) },
    );
    detail = result.stderr;
    code = result.code;
    if (code === 0 && fs.existsSync(repoPath)) {
      break;
    }
    // 失败（如 git 版本不支持 filter）会留下半成品目录，清掉再退回全量克隆
    if (fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
  }
  if (code !== 0 || !fs.existsSync(repoPath)) {
    // 只取末行，git 的致命错误信息通常就在这一行
    const lines = detail.split("\n").filter(Boolean);
    const tail = lines.length ? lines[lines.length - 1].slice(0, 200) : "";
    throw new CloneError(
      `克隆 ${path.basename(repoPath)} 失败` + (tail ? `: ${tail}` : ""),
    );
  }
}

function commitMetaFormat() {
  return `${FS}%H${FS}%aI${FS}%an${FS}%ae${FS}%(trailers:key=Co-authored-by,valueonly=true,separator=${TS})`;
}

/**
 * 一次 git log 拿到全部 commit 元数据，在本地按邮箱过滤。
 *
 * 全历史只扫描一次，过滤在内存中完成。
 * 匹配只比较邮箱，名字不参与；GitHub 判定归属也是同样的口径。
 * 返回 null 表示历史读取失败，与「确实没有提交」区分开。
 */
async function collectUserCommits(repoPath, remote, branch, emails) {
  const { stdout, code } = await runGit(
    ["log", `${remote}/${branch}`, `--format=${commitMetaFormat()}`],
    { cwd: repoPath },
  );
  if (code !== 0) {
    // 分支引用不存在（空仓库或默认分支判断错误）按 0 提交处理，
    // 引用存在却读不出来才是真的失败，需要让调用方报错而不是记成 0
    const { code: refCode } = await runGit(
      ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`],
      { cwd: repoPath },
    );
    return refCode === 0 ? null : [];
  }

  const wanted = new Set(
    emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
  );
  if (!wanted.size) {
    return [];
  }

  const result = [];
  const seen = new Set();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(FS)) {
      continue;
    }
    const parts = line.slice(1).split(FS);
    if (parts.length < 5) {
      continue;
    }
    const [sha, date, , email, trailers] = parts;
    if (seen.has(sha)) {
      continue;
    }

    const emailKey = email.trim().toLowerCase();
    let matched = Boolean(emailKey) && wanted.has(emailKey);
    if (!matched && trailers) {
      for (const item of trailers.split(TS)) {
        // trailer 形如 `Name <email>`，只取尖括号中的地址参与比较
        const pos = item.lastIndexOf("<");
        if (pos < 0) {
          continue;
        }
        const candidate = item
          .slice(pos + 1)
          .replace(/[> ]+$/, "")
          .trim()
          .toLowerCase();
        if (candidate && wanted.has(candidate)) {
          matched = true;
          break;
        }
      }
    }
    if (matched) {
      seen.add(sha);
      result.push([sha, date]);
    }
  }
  return result;
}

/**
 * 一次 git log 批量取所有目标 commit 的增删行数与文件状态。
 *
 * 一批提交共用一个 git 进程。
 */
async function collectCommitDetails(repoPath, shas) {
  if (!shas.length) {
    return new Map();
  }

  const fmt = `${FS}%H${FS}%aI`;
  const { stdout, code } = await runGit(
    ["log", "--raw", "--numstat", "--no-walk", "--stdin", `--format=${fmt}`],
    { cwd: repoPath, stdinData: `${shas.join("\n")}\n` },
  );
  if (code !== 0) {
    return new Map();
  }

  const details = new Map();
  let current = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith(FS)) {
      current = line.slice(1).split(FS)[0];
      details.set(current, { additions: 0, deletions: 0, files: [] });
      continue;
    }
    if (current === null || !line) {
      continue;
    }
    const entry = details.get(current);
    if (line.startsWith(":")) {
      // :<srcmode> <dstmode> <srcsha> <dstsha> <status>\t<path>[\t<oldpath>]
      const fields = line.slice(1).split("\t");
      const meta = fields[0].split(/\s+/);
      const status = meta.length ? meta[meta.length - 1].replace(/\d+$/, "") : "";
      const filePath =
        fields.length >= 3 ? fields[2] : fields.length >= 2 ? fields[1] : "";
      if (filePath) {
        const kind = status === "A" || status === "C" ? "added" : "modified";
        entry.files.push({ filename: filePath, status: kind });
      }
    } else if (line.includes("\t")) {
      const [additions, deletions] = line.split("\t");
      if (additions !== "-") {
        const value = Number.parseInt(additions, 10);
        if (Number.isFinite(value)) {
          entry.additions += value;
        }
      }
      if (deletions !== "-") {
        const value = Number.parseInt(deletions, 10);
        if (Number.isFinite(value)) {
          entry.deletions += value;
        }
      }
    }
  }
  return details;
}

function countImages(app, files) {
  let total = 0;
  for (const item of files ?? []) {
    if (item?.status !== "added") {
      continue;
    }
    const lower = String(item.filename ?? "").toLowerCase();
    if (app.imageExtensions.some((ext) => lower.endsWith(ext))) {
      total += 1;
    }
  }
  return total;
}

// ============================================================================
// API 兜底
// ============================================================================

async function getCommitsFromApi(app, owner, repoName, branch, log) {
  const base = app.api.github_api_base;
  const perPage = apiPerPage(app);
  const maxPages = intOf(app.api.max_api_pages, 10);
  const commits = [];

  let page = 1;
  for (; page <= maxPages; page += 1) {
    const url =
      `${base}/repos/${owner}/${repoName}/commits` +
      `?author=${app.originUsername}&sha=${branch}&per_page=${perPage}&page=${page}`;
    log.color(`    🔍 API 获取commits (第${page}页)...`, NC);
    let data;
    try {
      data = await apiJson(app, url);
    } catch (exc) {
      if (exc instanceof ApiError && exc.kind === "rate_limit") {
        app.setRateLimit(exc.message);
      } else {
        log.color("    ❌ API调用失败", RED);
      }
      return commits;
    }
    if (!Array.isArray(data) || !data.length) {
      break;
    }
    for (const item of data) {
      const sha = item?.sha ?? "";
      const date = item?.commit?.author?.date ?? nowIsoUtc();
      if (sha) {
        commits.push([sha, date]);
      }
    }
    log.color(`    📊 已获取 ${commits.length} 个提交`, NC);
    if (data.length < perPage) {
      break;
    }
  }

  if (page > maxPages) {
    log.color(
      `    ℹ️  已达到最大页数限制 (${maxPages} 页)，共 ${commits.length} 个提交`,
      NC,
    );
  }
  return commits;
}

async function getDetailsFromApi(app, owner, repoName, sha) {
  const url = `${app.api.github_api_base}/repos/${owner}/${repoName}/commits/${sha}`;
  let data;
  try {
    data = await apiJson(app, url);
  } catch (exc) {
    if (exc instanceof ApiError && exc.kind === "rate_limit") {
      app.setRateLimit(exc.message);
    }
    return { additions: 0, deletions: 0, files: [] };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { additions: 0, deletions: 0, files: [] };
  }
  const stats = data.stats ?? {};
  const files = (data.files ?? []).map((file) => ({
    filename: file?.filename ?? "",
    status: file?.status ?? "",
  }));
  return {
    additions: intOf(stats.additions, 0),
    deletions: intOf(stats.deletions, 0),
    files,
  };
}

// ============================================================================
// 缓存
// ============================================================================

function cacheMetaOf(cacheFile) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile, "utf8"))._metadata ?? {};
  } catch {
    return {};
  }
}

function sortedCacheFiles(cacheDir) {
  if (!fs.existsSync(cacheDir)) {
    return [];
  }
  return fs
    .readdirSync(cacheDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(cacheDir, name))
    .filter((file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    });
}

/** 按仓库数字 ID 找缓存文件。仓库改名后 ID 不变，可据此接续历史。 */
function cacheFileByRepoId(app, repoId) {
  if (!repoId || !fs.existsSync(app.cacheDir)) {
    return null;
  }
  for (const file of sortedCacheFiles(app.cacheDir)) {
    if (String(cacheMetaOf(file).repo_id ?? "") === repoId) {
      return file;
    }
  }
  return null;
}

function loadCache(app, repoName, log, repoId = "") {
  let cacheFile = app.cacheFile(repoName);
  if (!fs.existsSync(cacheFile) && repoId) {
    const previous = cacheFileByRepoId(app, repoId);
    if (previous !== null) {
      log.color(`    🔀 沿用改名前的缓存 ${path.basename(previous)}`, YELLOW);
      try {
        fs.renameSync(previous, cacheFile);
      } catch {
        cacheFile = previous;
      }
    }
  }
  if (!fs.existsSync(cacheFile)) {
    log.color("    ℹ️  无缓存，首次统计", NC);
    return new Map();
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  } catch (exc) {
    log.color(`    ⚠️  缓存解析失败: ${exc.message}`, YELLOW);
    return new Map();
  }

  const meta = data._metadata ?? {};
  log.color(
    `    💾 已加载缓存: ${shortPath(cacheFile)}` +
      `（${meta.total_commits ?? 0} 个提交）`,
    GREEN,
  );

  const rawData = data.data ?? {};
  const cache = new Map();
  for (const [repo, items] of Object.entries(rawData)) {
    const entries = [];
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          entries.push({
            timestamp: item.timestamp ?? "",
            index: intOf(item.index, 0),
            additions: intOf(item.additions, 0),
            deletions: intOf(item.deletions, 0),
            images: intOf(item.images, 0),
            url: item.url ?? "",
          });
        }
      }
    }
    cache.set(repo, entries);
  }

  // 缓存文件是一个仓库一份，键名却可能是改名前的旧名（按 ID 接续来的），也可能
  // 因为此前的改名逻辑同时留下新旧两个键。统一并到当前名下：旧键留着既读不到
  // （按新名查缓存会当成空），又会在保存时和新算的一份并列写回，同一批提交算两遍
  const foreign = [...cache.keys()].filter((key) => key !== repoName);
  if (foreign.length) {
    const merged = [...cache.values()].flat();
    cache.clear();
    if (merged.length) {
      cache.set(repoName, merged);
    }
  }
  return normalizeCacheData(cache, log);
}

/**
 * 缓存条目的稳定标识：提交 sha。
 *
 * 仓库改名或转让后，commit 地址里的 owner/name 会变，按地址比对会把整份缓存
 * 判成失效、重取一遍详情；sha 不变，改名后仍能原地复用。
 */
function commitKeyOf(item) {
  const url = String(item?.url ?? "");
  const at = url.lastIndexOf("/commit/");
  return at < 0 ? url : url.slice(at + 8);
}
function normalizeCacheData(cache, log) {
  const normalized = new Map();
  for (const [repo, items] of cache) {
    const seen = new Set();
    const kept = [];
    let duplicates = 0;
    for (const item of items) {
      // 按 sha 去重：改名前后同一提交会带着两个不同地址，按地址去重会留下两份
      const key = commitKeyOf(item);
      if (key) {
        if (seen.has(key)) {
          duplicates += 1;
          continue;
        }
        seen.add(key);
      }
      kept.push(item);
    }
    if (duplicates) {
      log.color(`    🧹 已按 commit 去重缓存: 删除 ${duplicates} 条重复数据`, YELLOW);
    }
    normalized.set(repo, kept);
  }
  return normalized;
}
function sortAndReindex(cache) {
  const out = new Map();
  for (const [repo, items] of cache) {
    // Array.prototype.sort 是稳定排序，同一时间戳的提交保持原有次序
    const sorted = [...items].sort(
      (a, b) =>
        parseIsoTimestamp(a.timestamp ?? "") -
        parseIsoTimestamp(b.timestamp ?? ""),
    );
    sorted.forEach((entry, idx) => {
      entry.index = idx + 1;
    });
    out.set(repo, sorted);
  }
  return out;
}

/** 序列化缓存：`_metadata` 在前，`data` 按仓库名分组。 */
function serializeCache(metadata, data) {
  const tree = { _metadata: metadata, data: Object.fromEntries(data) };
  return `${JSON.stringify(tree, null, 2)}\n`;
}

function saveCache(app, repoName, cache, log, repoId = "", fullName = "") {
  fs.mkdirSync(app.cacheDir, { recursive: true });
  const cacheFile = app.cacheFile(repoName);

  const sortedCache = sortAndReindex(cache);
  let totalCommits = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;
  let totalImages = 0;
  let latestKey = -Infinity;
  let latestTimestamp = "";

  for (const commits of sortedCache.values()) {
    for (const commit of commits) {
      totalCommits += 1;
      totalAdditions += commit.additions;
      totalDeletions += commit.deletions;
      totalImages += commit.images;
      const key = parseIsoTimestamp(commit.timestamp ?? "");
      if (key > latestKey) {
        latestKey = key;
        latestTimestamp = commit.timestamp ?? "";
      }
    }
  }

  const metadata = {
    total_commits: totalCommits,
    total_additions: totalAdditions,
    total_deletions: totalDeletions,
    total_images: totalImages,
    latest_commit_timestamp: latestTimestamp,
  };
  // 仓库改名或转让后 ID 不变，用它接续缓存
  if (repoId) {
    metadata.repo_id = repoId;
  }
  if (fullName) {
    metadata.full_name = fullName;
  }

  const serialized = serializeCache(metadata, sortedCache);
  let old = "";
  try {
    old = fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile, "utf8") : "";
  } catch {
    old = "";
  }

  if (old === serialized) {
    log.color("    ✅ 缓存无变化", GREEN);
    return false;
  }

  try {
    fs.writeFileSync(cacheFile, serialized, { encoding: "utf8" });
  } catch (exc) {
    printColor(`❌ 保存缓存失败: ${exc.message}`, RED);
    return false;
  }

  cache.clear();
  for (const [key, value] of sortedCache) {
    cache.set(key, value);
  }

  log.color(`    ✅ 缓存已保存: ${shortPath(cacheFile)}`, GREEN);
  return true;
}

function cleanStaleCache(cache, currentCommits, repoName, isApiFallback, log) {
  if (!cache.has(repoName)) {
    return;
  }

  // 按 sha 比对：仓库改名后地址会变，地址不变才是真的失效提交
  const currentKeys = new Set(currentCommits.map(([sha]) => sha));
  const stamps = currentCommits.map(([, date]) => date).filter(Boolean);
  const minTs = stamps.length ? stamps.reduce((a, b) => (a < b ? a : b)) : "";
  const maxTs = stamps.length ? stamps.reduce((a, b) => (a > b ? a : b)) : "";

  const inRange = [];
  const outOfRange = [];
  for (const item of cache.get(repoName) ?? []) {
    const out =
      isApiFallback &&
      minTs &&
      maxTs &&
      ((item.timestamp ?? "") < minTs || (item.timestamp ?? "") > maxTs);
    (out ? outOfRange : inRange).push(item);
  }

  const stale = new Set(
    inRange
      .map((item) => commitKeyOf(item))
      .filter((key) => key && !currentKeys.has(key)),
  );

  if (isApiFallback) {
    const lo = minTs ? minTs.slice(0, 10) : "?";
    const hi = maxTs ? maxTs.slice(0, 10) : "?";
    if (outOfRange.length) {
      log.color(
        `    ℹ️  数据范围 ${lo} ~ ${hi}（API），` +
          `保留 ${outOfRange.length} 个范围外提交`,
        NC,
      );
    }
  }

  if (!stale.size) {
    log.color("    ✅ 缓存完整", GREEN);
    return;
  }

  log.color(`    🧹 清理 ${stale.size} 个已消失的提交（变基/压缩/重写）`, YELLOW);

  const newList = [
    ...outOfRange,
    ...inRange.filter((item) => !stale.has(commitKeyOf(item))),
  ];
  if (newList.length) {
    cache.set(repoName, newList);
  } else {
    cache.delete(repoName);
    log.color("    ℹ️  仓库缓存已清空", NC);
    return;
  }
  log.color(`    ✅ 已清除 ${stale.size} 个过期提交`, GREEN);
}
/** 删除已不在统计范围内的缓存；改名/转让由 ID 识别，不会误删。 */
function cleanupStaleCacheFiles(app, activeRepoNames, activeRepoIds) {
  if (!fs.existsSync(app.cacheDir) || !activeRepoNames.size) {
    return false;
  }
  let changed = false;
  for (const cacheFile of sortedCacheFiles(app.cacheDir)) {
    const meta = cacheMetaOf(cacheFile);
    const repoId = String(meta.repo_id ?? "");
    // 任一条件命中即视为仍在统计范围内：多个 fork 指向同一上游时，
    // 缓存里只记了其中一个 fork 的 ID，但文件名仍是活跃的上游名
    if (repoId && activeRepoIds.has(repoId)) {
      continue;
    }
    if (activeRepoNames.has(path.basename(cacheFile, ".json"))) {
      continue;
    }
    try {
      fs.unlinkSync(cacheFile);
      changed = true;
      printColor(`🧹 已删除不存在仓库的缓存: ${cacheFile}`, YELLOW);
    } catch (exc) {
      printColor(`⚠️  删除陈旧缓存失败: ${exc.message}`, YELLOW);
    }
  }
  return changed;
}

function aggregateStatsFromCache(app) {
  const stats = {
    total_commits: 0,
    total_additions: 0,
    total_deletions: 0,
    total_images: 0,
    latest_commit_timestamp: "",
  };
  if (!fs.existsSync(app.cacheDir)) {
    return stats;
  }

  let latestKey = -Infinity;
  for (const cacheFile of sortedCacheFiles(app.cacheDir)) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    } catch {
      continue;
    }
    const dataObj = data.data ?? {};
    const stem = path.basename(cacheFile, ".json");
    if (!(stem in dataObj)) {
      continue;
    }
    const meta = data._metadata ?? {};
    for (const key of [
      "total_commits",
      "total_additions",
      "total_deletions",
      "total_images",
    ]) {
      stats[key] += intOf(meta[key], 0);
    }
    const stamp = meta.latest_commit_timestamp ?? "";
    const key = parseIsoTimestamp(stamp);
    if (key > latestKey) {
      latestKey = key;
      stats.latest_commit_timestamp = stamp;
    }
  }
  return stats;
}

// ============================================================================
// 单个仓库分析
// ============================================================================

async function analyzeRepo(
  app,
  repoPath,
  owner,
  repoName,
  log,
  repoId = "",
  fullName = "",
) {
  log.color("    📊 开始分析...", YELLOW);

  const cache = loadCache(app, repoName, log, repoId);

  const [remote, branch] = repoPath
    ? await defaultBranchOf(repoPath)
    : ["origin", "main"];
  if (repoPath) {
    log.color(`    ℹ️  默认分支: ${branch}`, NC);
  }

  const emails = app.snapshotEmails();
  let commits = [];
  if (!emails.length) {
    log.color("    ⚠️  尚未收集到作者邮箱，无法过滤提交", YELLOW);
  } else if (repoPath) {
    const found = await collectUserCommits(repoPath, remote, branch, emails);
    if (found === null) {
      // 读不出历史时不静默记 0，交由调用方计入失败清单
      log.color(`    ❌ 无法读取 ${remote}/${branch} 的历史`, RED);
      throw new Error(`无法读取 ${remote}/${branch} 的历史`);
    }
    commits = found;
  }

  let isApiFallback = false;
  if (!commits.length) {
    if (repoPath) {
      log.color("    ⚠️  git log 无数据，改用 API...", YELLOW);
    }
    commits = await getCommitsFromApi(app, owner, repoName, branch, log);
    isApiFallback = commits.length > 0;
    if (commits.length) {
      log.color(
        `    ✅ ${commits.length} 个提交（API，分页上限外的旧数据保留缓存）`,
        GREEN,
      );
    } else {
      log.color("    ⊘ 未找到提交", NC);
      return false;
    }
  } else {
    log.color(
      `    ✅ ${commits.length} 个提交（git log，${emails.length} 个邮箱）`,
      GREEN,
    );
  }

  const totalCommits = commits.length;

  const oldCount = (cache.get(repoName) ?? []).length;
  cleanStaleCache(cache, commits, repoName, isApiFallback, log);
  const staleCleaned = (cache.get(repoName) ?? []).length !== oldCount;

  const cacheIndex = new Map(
    (cache.get(repoName) ?? [])
      .map((item) => [commitKeyOf(item), item])
      .filter(([key]) => key),
  );

  // 缓存未命中的 sha 一次性批量取详情
  const missing = [];
  for (const [sha] of commits) {
    if (!cacheIndex.has(sha)) {
      missing.push(sha);
    }
  }

  let details = new Map();
  if (missing.length && repoPath) {
    details = await collectCommitDetails(repoPath, missing);
  }

  let totalAdditions = 0;
  let totalDeletions = 0;
  let totalImages = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  const progressInterval = Math.max(intOf(app.behavior.progress_interval, 10), 1);

  if (!cache.has(repoName)) {
    cache.set(repoName, []);
  }
  const entries = cache.get(repoName);

  for (let i = 0; i < commits.length; i += 1) {
    const processed = i + 1;
    const [sha, date] = commits[i];
    if (processed % progressInterval === 0) {
      const pct = Math.floor((processed * 100) / totalCommits);
      log.color(`    ⏳ 处理中 ${processed}/${totalCommits}（${pct}%）`, NC);
    }

    const url = `https://github.com/${owner}/${repoName}/commit/${sha}`;
    const hit = cacheIndex.get(sha);
    if (hit !== undefined) {
      // 仓库改名后缓存里还是旧地址，顺手换成当前的，避免下次又被当成另一条
      hit.url = url;
      totalAdditions += hit.additions;
      totalDeletions += hit.deletions;
      totalImages += hit.images;
      cacheHits += 1;
      continue;
    }

    cacheMisses += 1;
    const detail =
      details.get(sha) ?? (await getDetailsFromApi(app, owner, repoName, sha));
    const additions = detail.additions;
    const deletions = detail.deletions;
    const images = countImages(app, detail.files);

    totalAdditions += additions;
    totalDeletions += deletions;
    totalImages += images;
    entries.push({
      timestamp: date,
      index: processed,
      additions,
      deletions,
      images,
      url,
    });
  }

  if (repoPath && missing.length && !details.size) {
    log.color("    ⚠️  git 详情获取失败，统计数据可能不完整", YELLOW);
  }

  log.color("    💾 缓存:", YELLOW);
  log.color(`      - 命中 ${cacheHits} 个提交`, NC);
  log.color(`      - 未命中 ${cacheMisses} 个提交`, NC);
  if (totalCommits) {
    log.color(
      `      - 命中率 ${((cacheHits / totalCommits) * 100).toFixed(1)}%`,
      NC,
    );
  }

  const net = totalAdditions - totalDeletions;
  const netSign = net >= 0 ? "+" : "";
  log.color(
    `    ✅ +${formatNumber(totalAdditions)} / -${formatNumber(totalDeletions)}` +
      `（净 ${netSign}${formatNumber(net)}）`,
    GREEN,
  );
  log.color(`      🖼️ 图片 ${totalImages} 张`, GREEN);

  const savedChanged = saveCache(app, repoName, cache, log, repoId, fullName);
  return cacheMisses > 0 || staleCleaned || savedChanged;
}
// ============================================================================
// SVG 卡片
// ============================================================================

function generateContributionsSvg(app, stats, displayName) {
  const svg = app.svg;
  const layout = svg.layout;
  const font = svg.font;
  const labels = svg.labels;

  const additions = stats.total_additions;
  const deletions = stats.total_deletions;
  const images = stats.total_images;
  const net = additions - deletions;
  const netSign = net >= 0 ? "+" : "";
  const netColor = net >= 0 ? svg.add_color : svg.del_color;

  const customTitle = svg.custom_title;
  let titleText;
  if (customTitle !== null && customTitle !== undefined) {
    titleText = escapeHtml(customTitle);
  } else {
    const escaped = escapeHtml(displayName);
    const suffix = escaped.trimEnd().endsWith("s") ? "" : "s";
    titleText = `${escaped}&apos;${suffix} Code Contributions`;
  }

  const width = intOf(svg.width, 1200);
  const height = intOf(svg.height, 200);
  const rectWidth = width - 1;
  const rectHeight = height - 1;
  const padding = layout.padding;
  const titleY = layout.title_y;
  const statsY = layout.stats_y;
  const valueGap = layout.value_gap;
  const borderRadius = layout.border_radius;
  const colWidth = Math.floor((width - padding) / 4);
  const col1 = padding + colWidth;
  const col2 = padding + colWidth * 2;
  const col3 = padding + colWidth * 3;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" fill="none" role="img">\n` +
    "  <style>\n" +
    `    .header { font: ${font.header_size} ${font.family}; fill: ${svg.title_color}; }\n` +
    "    @supports(-moz-appearance: auto) { " +
    `.header { font-size: ${font.header_size_firefox}; } }\n` +
    `    .stat { font: ${font.stat_size} ${font.family_extended}; fill: ${svg.text_color}; }\n` +
    `    .bold { font: ${font.bold_size} ${font.family_extended}; }\n` +
    "  </style>\n" +
    `  <rect x="0.5" y="0.5" width="${rectWidth}" height="${rectHeight}" rx="${borderRadius}" ` +
    `fill="${svg.bg_color}" stroke="${svg.border_color}" stroke-width="1"/>\n` +
    `  <text x="${padding}" y="${titleY}" class="header">${titleText}</text>\n` +
    `  <g transform="translate(${padding}, ${statsY})">\n` +
    `    <text x="0" y="0" class="stat">${labels.additions}</text>\n` +
    `    <text x="0" y="${valueGap}" class="stat bold" style="fill:${svg.add_color}">` +
    `+${formatNumber(additions)}</text>\n` +
    "  </g>\n" +
    `  <g transform="translate(${col1}, ${statsY})">\n` +
    `    <text x="0" y="0" class="stat">${labels.deletions}</text>\n` +
    `    <text x="0" y="${valueGap}" class="stat bold" style="fill:${svg.del_color}">` +
    `-${formatNumber(deletions)}</text>\n` +
    "  </g>\n" +
    `  <g transform="translate(${col2}, ${statsY})">\n` +
    `    <text x="0" y="0" class="stat">${labels.net}</text>\n` +
    `    <text x="0" y="${valueGap}" class="stat bold" style="fill:${netColor}">` +
    `${netSign}${formatNumber(net)}</text>\n` +
    "  </g>\n" +
    `  <g transform="translate(${col3}, ${statsY})">\n` +
    `    <text x="0" y="0" class="stat">${labels.images}</text>\n` +
    `    <text x="0" y="${valueGap}" class="stat bold" style="fill:${svg.img_color}">` +
    `${formatNumber(images)}</text>\n` +
    "  </g>\n" +
    "</svg>"
  );
}

function saveContributionsSvg(app, content) {
  try {
    fs.writeFileSync(app.svgPath, `${content}\n`, { encoding: "utf8" });
  } catch (exc) {
    printColor(`❌ 保存 SVG 失败: ${exc.message}`, RED);
    return false;
  }
  printColor(`✅ SVG 卡片已生成: ${shortPath(app.svgPath)}`, GREEN);
  return true;
}

// ============================================================================
// 仓库并发处理
// ============================================================================

/** 并发执行，结果按原顺序返回。 */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const size = Math.max(Math.min(limit, items.length), 1);
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 并发执行，谁先完成谁先处理收尾动作。 */
async function eachPool(items, limit, fn) {
  let next = 0;
  const size = Math.max(Math.min(limit, items.length), 1);
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      await fn(items[index], index);
    }
  });
  await Promise.all(runners);
}

/**
 * 克隆并分析单个仓库。日志留在 job.log 里，由调用方按配置顺序输出。
 *
 * 仓库无法就绪时抛 CloneError，由调用方计入失败清单。
 */
async function processJob(app, job) {
  await cloneOrUpdate(job.repoPath, job.cloneUrl, job.log);
  return analyzeRepo(
    app,
    job.repoPath,
    job.owner,
    job.repoName,
    job.log,
    job.repoId,
    job.fullName,
  );
}

/** 返回 [是否有变更, 未能完成的仓库名]。 */
async function processRepos(app, repos) {
  const separatorLength = intOf(
    app.behavior.separator_length,
    DEFAULT_SEPARATOR_LENGTH,
  );
  printSeparator(`🔍 解析仓库与上游（共 ${repos.length} 个）`, GREEN, separatorLength);

  const tempDir = path.join(PROJECT_ROOT, "temp_repos");
  fs.mkdirSync(tempDir, { recursive: true });

  const concurrency = Math.max(intOf(app.behavior.concurrency, DEFAULT_CONCURRENCY), 1);
  // 上游解析是一串 API 请求，并发度压在 4 以内，避免触发 GitHub 二级限流
  const workers = Math.max(Math.min(concurrency, repos.length, 4), 1);
  printColor("  ⏳ 并发解析上游仓库...", NC);

  // ---- Phase A1（并发）：只解析上游，不打印，避免日志落到别的仓库块里 ----
  const upstreams = await mapPool(repos, workers, (repo) =>
    getUpstreamRepo(app, repo),
  );

  // ---- Phase A2（串行）：按配置顺序确定克隆目标并去重 ----
  const activeRepoNames = new Set();
  const activeRepoIds = new Set();
  const firstSeen = new Map();
  // 缓存文件以仓库名为准，不同归属的同名仓库会写到同一个文件，
  // 后写入的会把前一个覆盖掉，因此第二个直接跳过并说明原因
  const cacheOwnerByName = new Map();
  const entries = [];
  // 没能确认 fork 关系的仓库：本轮跳过，且不清理旧缓存
  let upstreamUnknown = 0;

  repos.forEach((repo, index) => {
    const [upOwner, upName, upUnknown] = upstreams[index];
    const repoName = repo?.name;
    const repoUrl = repo?.html_url;
    if (!repoName || !repoUrl) {
      return;
    }

    if (upUnknown) {
      upstreamUnknown += 1;
      const log = new Log();
      log.separator(`📦 仓库: ${repoName}`, YELLOW, separatorLength);
      log.color(`  URL: ${repoUrl}`, NC);
      log.color("  ⏭ 无法确认 fork 关系，本轮跳过", YELLOW);
      entries.push({
        repoName,
        target: "（未确认）",
        log,
        status: "skipped",
        note: "无法确认 fork 关系，本轮跳过",
        meta: null,
      });
      return;
    }

    let cloneOwner;
    let targetName;
    let cloneUrl;
    if (upOwner && upName) {
      cloneOwner = upOwner;
      targetName = upName;
      cloneUrl = `https://github.com/${upOwner}/${upName}.git`;
    } else {
      cloneOwner = repoOwnerFromUrl(repoUrl) ?? app.originUsername;
      targetName = repoName;
      cloneUrl = repoUrl;
    }

    activeRepoNames.add(targetName);
    const repoId = String(repo.id ?? "");
    const fullName = String(repo.full_name ?? `${cloneOwner}/${targetName}`);
    if (repoId) {
      activeRepoIds.add(repoId);
    }

    const log = new Log();
    log.separator(`📦 仓库: ${repoName}`, YELLOW, separatorLength);
    log.color(`  URL: ${repoUrl}`, NC);
    log.color(`  克隆: ${cloneOwner}/${targetName}`, NC);
    log.color("", NC);

    const entry = {
      repoName,
      target: `${cloneOwner}/${targetName}`,
      log,
      status: "ok",
      note: "",
      meta: {
        owner: cloneOwner,
        name: targetName,
        cloneUrl,
        // 目录名带上归属者，避免自己的同名仓库与某个上游重名时互相覆盖
        repoPath: path.join(tempDir, `${cloneOwner}__${targetName}`),
        repoId,
        fullName,
      },
    };

    const targetKey = `${cloneOwner}/${targetName}`.toLowerCase();
    if (firstSeen.has(targetKey)) {
      entry.status = "duplicate";
      entry.note = `与 ${firstSeen.get(targetKey)} 同源，跳过`;
    } else {
      firstSeen.set(targetKey, repoName);
      const cacheOwner = cacheOwnerByName.get(targetName);
      if (
        cacheOwner !== undefined &&
        cacheOwner.toLowerCase() !== cloneOwner.toLowerCase()
      ) {
        entry.status = "duplicate";
        entry.note = `与 ${cacheOwner} 的同名仓库共用缓存 ${targetName}.json，跳过`;
      } else {
        cacheOwnerByName.set(targetName, cloneOwner);
      }
    }
    entries.push(entry);
  });

  // ---- 归属汇总：按配置顺序输出，一行一个仓库，箭头指向实际克隆的仓库 ----
  const width = entries.reduce(
    (max, entry) => Math.max(max, entry.repoName.length),
    0,
  );
  for (const entry of entries) {
    const name = entry.repoName.padEnd(width);
    if (entry.status !== "ok") {
      printColor(
        `  ⏭ ${name}  →  ${entry.target}（${entry.note}）`,
        YELLOW,
      );
    } else {
      printColor(`  ✓ ${name}  →  ${entry.target}`, NC);
    }
  }
  if (upstreamUnknown) {
    printColor(
      `  ⚠️  ${upstreamUnknown} 个仓库无法确认 fork 关系，本轮跳过（沿用旧缓存）`,
      YELLOW,
    );
  }
  printColor("", NC);

  // ---- Phase B（并发）：克隆 + 分析 ----
  const jobs = entries
    .filter((entry) => entry.status === "ok")
    .map((entry) => ({
      log: entry.log,
      repoPath: entry.meta.repoPath,
      owner: entry.meta.owner,
      repoName: entry.meta.name,
      cloneUrl: entry.meta.cloneUrl,
      repoId: entry.meta.repoId,
      fullName: entry.meta.fullName,
    }));

  let anyChanged = false;
  const failed = [];
  if (jobs.length) {
    const poolSize = Math.max(Math.min(concurrency, jobs.length), 1);
    // 并发跑，谁先完成谁先输出：不阻塞、不交织，每块自带仓库名与上游
    await eachPool(jobs, poolSize, async (job) => {
      try {
        const changed = await processJob(app, job);
        anyChanged = anyChanged || Boolean(changed);
      } catch (exc) {
        if (exc instanceof CloneError) {
          job.log.color(`    ❌ ${exc.message}`, RED);
        } else {
          job.log.color(`    ❌ 处理失败: ${exc.message}`, RED);
        }
        failed.push(job.repoName);
      } finally {
        job.log.flush();
        printColor("", NC);
      }
    });
  }

  // 本地克隆保留给下次运行复用，只清掉本轮不再出现的仓库
  const kept = new Set(jobs.map((job) => path.basename(job.repoPath)));
  if (fs.existsSync(tempDir)) {
    for (const dirent of fs.readdirSync(tempDir, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const full = path.join(tempDir, dirent.name);
      if (dirent.isDirectory()) {
        if (kept.has(dirent.name)) {
          continue;
        }
        fs.rmSync(full, { recursive: true, force: true });
      } else {
        try {
          fs.unlinkSync(full);
        } catch {
          // 忽略删除失败
        }
      }
    }
  }

  if (failed.length) {
    printColor(`  ❌ ${failed.length} 个仓库未能完成，统计可能不完整`, RED);
  }

  if (upstreamUnknown) {
    // 这些仓库本轮没参与统计，但缓存还在用，清理会把它们的数据一起删掉
    printColor("ℹ️  有仓库未确认 fork 关系，本次保留旧缓存不做清理", NC);
  } else if (
    activeRepoNames.size &&
    cleanupStaleCacheFiles(app, activeRepoNames, activeRepoIds)
  ) {
    anyChanged = true;
  }

  return [anyChanged, failed];
}

// ============================================================================
// 入口
// ============================================================================

function printHelp() {
  console.log("用法: generate_stats.js [选项]");
  console.log();
  console.log("选项:");
  console.log("  --clear-cache         清除缓存文件");
  console.log("  -h, --help            显示此帮助信息");
}

async function run() {
  const args = process.argv.slice(2);
  let clearCache = false;
  for (const arg of args) {
    if (arg === "--clear-cache") {
      clearCache = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      return 0;
    } else {
      printColor(`❌ 未知参数: ${arg}`, RED);
      printHelp();
      return 2;
    }
  }

  let originUsername = process.env.ORIGIN_USERNAME ?? "";
  const token = process.env.GH_TOKEN ?? "";

  const readmePath = path.join(PROJECT_ROOT, "README.md");
  if (!originUsername) {
    originUsername =
      getDefaultFromReadme(readmePath, "ORIGIN_USERNAME") ?? "";
  }

  const app = new App(originUsername, token);
  const separatorLength = intOf(
    app.behavior.separator_length,
    DEFAULT_SEPARATOR_LENGTH,
  );

  printSeparator("🚀 开始生成 GitHub 统计", GREEN, separatorLength);
  printColor("📊 统计配置", YELLOW);
  printColor(`  - 远端用户 ${app.originUsername}`, NC);
  printColor(`  - 缓存目录 ${shortPath(app.cacheDir)}`, NC);
  printColor(
    `  - 并发度 ${app.behavior.concurrency ?? DEFAULT_CONCURRENCY}`,
    NC,
  );
  printSeparator(null, GREEN, separatorLength);

  if (clearCache) {
    if (fs.existsSync(app.cacheDir)) {
      printColor(`🗑️  清除缓存目录 ${shortPath(app.cacheDir)}`, YELLOW);
      try {
        fs.rmSync(app.cacheDir, { recursive: true, force: true });
        printColor("✅ 缓存已清除", GREEN);
      } catch (exc) {
        printColor(`❌ 清除缓存失败: ${exc.message}`, RED);
        return 1;
      }
    } else {
      printColor(`ℹ️  缓存目录不存在 ${shortPath(app.cacheDir)}`, NC);
    }
    const reposDir = path.join(PROJECT_ROOT, "temp_repos");
    if (fs.existsSync(reposDir)) {
      printColor(`🗑️  清除本地克隆 ${shortPath(reposDir)}`, YELLOW);
      try {
        fs.rmSync(reposDir, { recursive: true, force: true });
        printColor("✅ 本地克隆已清除", GREEN);
      } catch (exc) {
        printColor(`❌ 清除本地克隆失败: ${exc.message}`, RED);
        return 1;
      }
    }
    return 0;
  }

  if (!token) {
    printColor("❌ 错误: GH_TOKEN 环境变量未设置", RED);
    return 1;
  }

  if (!app.emailsToken) {
    printColor("❌ 未设置 EMAILS_TOKEN，无法确定提交归属", RED);
    printColor(
      "   请在 Settings → Secrets and variables → Actions 中添加名为 " +
        "EMAILS_TOKEN 的密钥，权限只需 user:email",
      NC,
    );
    return 1;
  }

  let accountEmails;
  try {
    accountEmails = await fetchAccountEmails(app);
  } catch (exc) {
    if (exc instanceof ApiError) {
      printColor(`❌ ${exc.message}`, RED);
      return 1;
    }
    throw exc;
  }
  if (!accountEmails.size) {
    printColor("❌ 账号下没有可用邮箱，无法确定提交归属", RED);
    return 1;
  }
  app.addEmails(accountEmails);
  printColor(`📧 已读取账号下的 ${accountEmails.size} 个邮箱`, GREEN);

  // 统计范围的唯一来源是贡献清单：查询里 includeUserRepositories: true，
  // 名下有自己提交的仓库本来就包含在内；再查一份名下列表只会多出
  // 「我拥有但零提交」的仓库，克隆下来对卡片没有任何贡献
  let scopeRepos = [];
  if (app.repos.discover) {
    printColor("🔎 查询有自己提交的仓库...", YELLOW);
    const found = await discoverScopeRepos(app);
    scopeRepos = found.repos;
    const privateNote = found.privateRepos.length
      ? `，私有跳过 ${found.privateRepos.length}`
      : "";
    printColor(
      `    本轮命中 ${found.fresh} 个${privateNote}，名单累计 ${found.repos.length} 个`,
      NC,
    );
    if (!found.complete) {
      printColor(
        "⚠️  贡献清单查询不完整（配额或翻页中断），本轮与上轮名单合并",
        YELLOW,
      );
    }
  }

  const included = await confirmIncludedRepos(app, app.repos.include);
  const { repos, added, excluded } = mergeRepos(
    scopeRepos,
    included,
    app.repos.exclude,
  );
  printColor(
    `📦 统计范围: ${repos.length} 个仓库（清单 ${added.included}，` +
      `发现 ${added.discovered}${excluded ? `，排除 ${excluded}` : ""}）`,
    GREEN,
  );
  if (!repos.length) {
    printColor("⚠️  没有找到仓库", YELLOW);
    return 1;
  }

  const [anyChanged, failed] = await processRepos(app, repos);

  if (app.rateLimit) {
    printColor(`❌ ${app.rateLimit}`, RED);
    return 1;
  }

  // 失败的仓库沿用上次缓存，汇总仍自洽，因此不阻断发布；
  // 只是这些仓库的新提交本轮没有计入
  if (failed.length) {
    printColor(
      `⚠️  ${failed.length} 个仓库未能完成，沿用上次缓存: ${failed.join(", ")}`,
      YELLOW,
    );
  }

  // 产物只发布到 Pages，不再写回仓库；即使数据没变也要重新生成卡片
  if (!anyChanged) {
    printColor("ℹ️  数据无变化，仍重新生成卡片供 Pages 发布", NC);
  }

  const stats = aggregateStatsFromCache(app);
  const net = stats.total_additions - stats.total_deletions;
  const netSign = net >= 0 ? "+" : "";
  printSeparator("📈 汇总统计", GREEN, separatorLength);
  printColor(
    `  ✍️  +${formatNumber(stats.total_additions)} / ` +
      `-${formatNumber(stats.total_deletions)}` +
      `（净 ${netSign}${formatNumber(net)}）`,
    GREEN,
  );
  printColor(`  🖼️  图片 ${formatNumber(stats.total_images)} 张`, GREEN);
  printSeparator(null, GREEN, separatorLength);

  const svgContent = generateContributionsSvg(app, stats, app.originUsername);
  if (!saveContributionsSvg(app, svgContent)) {
    return 1;
  }

  printSeparator("✅ 完成", GREEN, separatorLength);
  return 0;
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.exitCode = await run();
}

export {
  ApiError,
  App,
  cleanStaleCache,
  confirmIncludedRepos,
  discoverRepos,
  discoverScopeRepos,
  formatNumber,
  generateContributionsSvg,
  getUpstreamRepo,
  loadCache,
  mergeRepos,
  normalizeFullName,
  parseIsoTimestamp,
  parseToml,
  serializeCache,
};

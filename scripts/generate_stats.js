#!/usr/bin/env node
/**
 * GitHub 贡献统计脚本（零依赖，仅用 Node 内置模块）。
 *
 * 直接运行，无需编译：
 *     node scripts/generate_stats.js
 *
 * 环境变量：
 *     GH_TOKEN            GitHub 令牌（必需）
 *     EMAILS_TOKEN        账号邮箱令牌（必需，权限 user:email）
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

  text.split(/\r?\n/).forEach((raw, index) => {
    const lineNo = index + 1;
    const line = stripComment(raw).trim();
    if (!line) {
      return;
    }
    if (line.startsWith("[")) {
      if (!line.endsWith("]")) {
        throw new Error(`第 ${lineNo} 行：表头未闭合`);
      }
      table = descend(line.slice(1, -1), lineNo);
      return;
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      throw new Error(`第 ${lineNo} 行：缺少 =`);
    }
    const key = line.slice(0, eq).trim();
    if (!key) {
      throw new Error(`第 ${lineNo} 行：键名为空`);
    }
    table[key] = parseValue(line.slice(eq + 1), lineNo);
  });

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

// ============================================================================
// GitHub 仓库列表 / 上游 / 邮箱收集
// ============================================================================

function repoOwnerFromUrl(repoUrl) {
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+\/([^/]+)\//.exec(repoUrl);
  if (scheme) {
    return scheme[1];
  }
  const bare = /^([^/:]+)\//.exec(repoUrl);
  return bare ? bare[1] : null;
}

async function getRepos(app) {
  printColor("📡 获取仓库列表...", YELLOW);
  const repos = [];
  const base = app.api.github_api_base;
  const perPage = intOf(app.api.per_page, 100);
  const maxPages = intOf(app.api.max_api_pages, 10);

  for (let page = 1; page <= maxPages; page += 1) {
    const url = `${base}/users/${app.originUsername}/repos?per_page=${perPage}&type=all&page=${page}`;
    let data;
    try {
      data = await apiJson(app, url);
    } catch (exc) {
      if (exc instanceof ApiError && exc.kind === "rate_limit") {
        throw exc;
      }
      printColor("❌ 获取仓库列表失败", RED);
      return repos;
    }
    if (!Array.isArray(data) || !data.length) {
      break;
    }
    repos.push(...data);
    printColor(`    第 ${page} 页：${data.length} 个`, NC);
    if (data.length < perPage) {
      break;
    }
  }

  printColor(`✅ 共 ${repos.length} 个仓库`, GREEN);
  return repos;
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

async function getUpstreamRepo(app, repo) {
  if (!repo?.fork) {
    return [null, null];
  }

  let upstream = upstreamOf(repo);
  if (upstream === null) {
    const name = repo.name;
    if (!name) {
      return [null, null];
    }
    const url = `${app.api.github_api_base}/repos/${app.originUsername}/${name}`;
    let detail;
    try {
      detail = await apiJson(app, url);
    } catch (exc) {
      if (exc instanceof ApiError && exc.kind === "rate_limit") {
        app.setRateLimit(exc.message);
      }
      return [null, null];
    }
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      upstream = upstreamOf(detail);
    }
  }

  if (upstream && typeof upstream === "object") {
    const owner = (upstream.owner ?? {}).login;
    const name = upstream.name;
    if (owner && name) {
      return [owner, name];
    }
  }
  return [null, null];
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

  const perPage = intOf(app.api.per_page, 100);
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
  // 统计只需要 commit 与 tree 对象；文件内容（blob）只在缓存未命中的少数 commit
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
  const perPage = intOf(app.api.per_page, 100);
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
  return normalizeCacheData(cache, log);
}

function normalizeCacheData(cache, log) {
  const normalized = new Map();
  for (const [repo, items] of cache) {
    const seen = new Set();
    const kept = [];
    let duplicates = 0;
    for (const item of items) {
      const url = item.url ?? "";
      if (url) {
        if (seen.has(url)) {
          duplicates += 1;
          continue;
        }
        seen.add(url);
      }
      kept.push(item);
    }
    if (duplicates) {
      log.color(
        `    🧹 已按 commit URL 去重缓存: 删除 ${duplicates} 条重复数据`,
        YELLOW,
      );
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

function cleanStaleCache(
  cache,
  currentCommits,
  repoName,
  owner,
  isApiFallback,
  log,
) {
  if (!cache.has(repoName)) {
    return;
  }

  const currentUrls = new Set(
    currentCommits.map(
      ([sha]) => `https://github.com/${owner}/${repoName}/commit/${sha}`,
    ),
  );
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

  const cachedInRange = new Set(
    inRange.filter((item) => item.url).map((item) => item.url),
  );
  const stale = new Set(
    [...cachedInRange].filter((url) => !currentUrls.has(url)),
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
    ...inRange.filter((item) => !stale.has(item.url)),
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

/** 删除已不在仓库列表中的缓存；改名/转让由 ID 识别，不会误删。 */
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
  cleanStaleCache(cache, commits, repoName, owner, isApiFallback, log);
  const staleCleaned = (cache.get(repoName) ?? []).length !== oldCount;

  const cacheIndex = new Map(
    (cache.get(repoName) ?? [])
      .filter((item) => item.url)
      .map((item) => [item.url, item]),
  );

  // 缓存未命中的 sha 一次性批量取详情
  const missing = [];
  for (const [sha] of commits) {
    const url = `https://github.com/${owner}/${repoName}/commit/${sha}`;
    if (!cacheIndex.has(url)) {
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
    const hit = cacheIndex.get(url);
    if (hit !== undefined) {
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
  const entries = [];

  repos.forEach((repo, index) => {
    const [upOwner, upName] = upstreams[index];
    const repoName = repo?.name;
    const repoUrl = repo?.html_url;
    if (!repoName || !repoUrl) {
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
    if (entry.status === "duplicate") {
      printColor(
        `  ⏭ ${name}  →  ${entry.target}（${entry.note}）`,
        YELLOW,
      );
    } else {
      printColor(`  ✓ ${name}  →  ${entry.target}`, NC);
    }
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

  if (
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

  let repos;
  try {
    repos = await getRepos(app);
  } catch (exc) {
    if (exc instanceof ApiError) {
      printColor(`❌ ${exc.message}`, RED);
      return 1;
    }
    throw exc;
  }
  if (!repos.length) {
    printColor("⚠️  没有找到仓库", YELLOW);
    return 1;
  }

  const [anyChanged, failed] = await processRepos(app, repos);

  if (app.rateLimit) {
    printColor(`❌ ${app.rateLimit}`, RED);
    return 1;
  }

  // 失败的仓库沿用上次缓存，汇总仍自洽
  if (failed.length) {
    printColor(
      `❌ ${failed.length} 个仓库未能完成，结果可能不完整: ${failed.join(", ")}`,
      RED,
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

  // 有仓库未完成时结果不完整，不发布，由工作流保持站点的上一版
  if (failed.length) {
    printColor("❌ 结果不完整，本次不发布", RED);
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
  App,
  collectCommitDetails,
  collectUserCommits,
  formatNumber,
  generateContributionsSvg,
  parseIsoTimestamp,
  parseToml,
  serializeCache,
};

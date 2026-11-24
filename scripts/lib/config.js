/**
 * TOML 解析与运行配置（App）。
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { DEFAULT_CONCURRENCY, DEFAULT_SEPARATOR_LENGTH, PROJECT_ROOT, SCRIPT_DIR, YELLOW, printColor } from "./format.js";
import { setGitAuth } from "./git.js";

export const SVG_DEFAULTS = {
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

export const SVG_LAYOUT_DEFAULTS = {
  padding: 67,
  title_y: 70,
  stats_y: 120,
  value_gap: 36,
  border_radius: 4.5,
};

export const SVG_FONT_DEFAULTS = {
  family: "'Segoe UI', Ubuntu, Sans-Serif",
  family_extended: "'Segoe UI', Ubuntu, 'Helvetica Neue', Sans-Serif",
  header_size: "600 48px",
  header_size_firefox: "41px",
  stat_size: "600 20px",
  bold_size: "700 36px",
};

export const SVG_LABEL_DEFAULTS = {
  additions: "Additions",
  deletions: "Deletions",
  net: "Net",
  images: "Images",
};

export const API_DEFAULTS = {
  github_api_base: "https://api.github.com",
  max_api_pages: 10,
  per_page: 100,
  rate_limit_warn_threshold: 50,
};

export const REPOS_DEFAULTS = {
  discover: true,
  include: [],
  exclude: [],
};

export const BEHAVIOR_DEFAULTS = {
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

export function merged(section, defaults) {
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
export function parseToml(text) {
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

export class App {
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
export function getDefaultFromReadme(readmePath, varName) {
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

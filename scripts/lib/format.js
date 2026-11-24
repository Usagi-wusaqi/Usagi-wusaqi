/**
 * 终端输出、日志缓冲、数字与时间格式。所有模块的最底层依赖。
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const RED = "\u001b[0;31m";
export const GREEN = "\u001b[0;32m";
export const YELLOW = "\u001b[1;33m";
export const NC = "\u001b[0m";

// 本文件在 scripts/lib/ 下，脚本目录是它的上一级
const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPT_DIR = path.dirname(LIB_DIR);
export const PROJECT_ROOT = path.dirname(SCRIPT_DIR);

// 记录分隔符：\x01 分隔字段，\x1f 分隔多个 trailer（均不会出现在正常文本中）
export const FS = "\x01";
export const TS = "\x1f";
export const DEFAULT_CONCURRENCY = 6;
export const DEFAULT_SEPARATOR_LENGTH = 60;
export const GIT_TIMEOUT_MS = 900_000;

export function printColor(message, color = NC) {
  process.stdout.write(`${color}${message}${NC}\n`);
}

export function printSeparator(
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
export class Log {
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
export function formatNumber(num) {
  return Number(num).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function intOf(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

/** 日志里显示相对仓库根目录的路径，避免 CI 上出现超长的绝对路径。 */
export function shortPath(target) {
  const rel = path.relative(PROJECT_ROOT, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return path.basename(target);
  }
  return rel.split(path.sep).join("/");
}

export function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** 解析 ISO 8601 为 Unix 秒；失败返回 -Infinity（排序时等价于最小值）。 */
export function parseIsoTimestamp(text) {
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

export function nowIsoUtc() {
  const iso = new Date().toISOString();
  const [head, tail] = iso.split(".");
  const micros = tail.replace("Z", "").padEnd(6, "0");
  return `${head}.${micros}+00:00`;
}

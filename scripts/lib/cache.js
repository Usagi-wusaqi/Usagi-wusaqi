/**
 * 按仓库的提交明细缓存：读取、去重、失效清理、汇总。
 */

import fs from "node:fs";
import path from "node:path";

import { merged } from "./config.js";
import { GREEN, NC, RED, YELLOW, intOf, parseIsoTimestamp, printColor, shortPath } from "./format.js";

export function cacheMetaOf(cacheFile) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile, "utf8"))._metadata ?? {};
  } catch {
    return {};
  }
}

export function sortedCacheFiles(cacheDir) {
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
export function cacheFileByRepoId(app, repoId) {
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

export function loadCache(app, repoName, log, repoId = "") {
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

  // 缓存文件一个仓库一份，键名可能是改名前的旧名（按 ID 接续来的），也可能同一
  // 仓库存在多个键。统一并到当前名下：旧键留着既读不到（按新名查缓存会当成空），
  // 又会在保存时和新算的一份并列写回，同一批提交算两遍
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
export function commitKeyOf(item) {
  const url = String(item?.url ?? "");
  const at = url.lastIndexOf("/commit/");
  return at < 0 ? url : url.slice(at + 8);
}

export function normalizeCacheData(cache, log) {
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

export function sortAndReindex(cache) {
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
export function serializeCache(metadata, data) {
  const tree = { _metadata: metadata, data: Object.fromEntries(data) };
  return `${JSON.stringify(tree, null, 2)}\n`;
}

export function saveCache(app, repoName, cache, log, repoId = "", fullName = "") {
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

export function cleanStaleCache(cache, currentCommits, repoName, isApiFallback, log) {
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
export function cleanupStaleCacheFiles(app, activeRepoNames, activeRepoIds) {
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

export function aggregateStatsFromCache(app) {
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

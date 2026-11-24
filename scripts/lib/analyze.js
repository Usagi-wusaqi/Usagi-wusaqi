/**
 * 单个仓库的分析流程：克隆、取提交、算增删行与图片。
 */

import { getCommitsFromApi, getDetailsFromApi } from "./api.js";
import { cleanStaleCache, commitKeyOf, loadCache, saveCache } from "./cache.js";
import { GREEN, NC, RED, YELLOW, formatNumber, intOf } from "./format.js";
import { collectCommitDetails, collectUserCommits, countImages, defaultBranchOf } from "./git.js";

export async function analyzeRepo(
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
      log.color("    ⚠️  git log 无数据，转由 API 读取...", YELLOW);
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

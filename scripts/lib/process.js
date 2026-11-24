/**
 * 多个仓库的并发调度与去重。
 */

import fs from "node:fs";
import path from "node:path";

import { analyzeRepo } from "./analyze.js";
import { cleanupStaleCacheFiles } from "./cache.js";
import { DEFAULT_CONCURRENCY, DEFAULT_SEPARATOR_LENGTH, GREEN, Log, NC, PROJECT_ROOT, RED, YELLOW, intOf, printColor, printSeparator } from "./format.js";
import { CloneError, cloneOrUpdate } from "./git.js";
import { getUpstreamRepo } from "./github.js";
import { eachPool, mapPool } from "./pool.js";
import { repoOwnerFromUrl } from "./repo.js";

/**
 * 克隆并分析单个仓库。日志留在 job.log 里，由调用方按配置顺序输出。
 *
 * 仓库无法就绪时抛 CloneError，由调用方计入失败清单。
 */
export async function processJob(app, job) {
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
export async function processRepos(app, repos, scopeComplete = true) {
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

  if (!scopeComplete || upstreamUnknown) {
    // 范围判断本身不完整时不动旧缓存：否则一次查询失败就会把已统计的仓库连数据一起清掉
    printColor("ℹ️  统计范围可能不完整，本次保留旧缓存不做清理", NC);
  } else if (
    activeRepoNames.size &&
    cleanupStaleCacheFiles(app, activeRepoNames, activeRepoIds)
  ) {
    anyChanged = true;
  }

  return [anyChanged, failed];
}

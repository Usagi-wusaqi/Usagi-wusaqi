#!/usr/bin/env node

/**
 * 入口：读配置、发起统计、写卡片。
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { aggregateStatsFromCache, cleanStaleCache, loadCache, serializeCache } from "./lib/cache.js";
import { App, getDefaultFromReadme, parseToml } from "./lib/config.js";
import { DEFAULT_CONCURRENCY, DEFAULT_SEPARATOR_LENGTH, GREEN, NC, PROJECT_ROOT, RED, YELLOW, formatNumber, intOf, parseIsoTimestamp, printColor, printSeparator, shortPath } from "./lib/format.js";
import { confirmIncludedRepos, discoverRepos, discoverScopeRepos, fetchAccountEmails, getUpstreamRepo, mergeRepos } from "./lib/github.js";
import { ApiError } from "./lib/http.js";
import { processRepos } from "./lib/process.js";
import { normalizeFullName } from "./lib/repo.js";
import { generateContributionsSvg, saveContributionsSvg } from "./lib/svg.js";

export function printHelp() {
  console.log("用法: generate_stats.js [选项]");
  console.log();
  console.log("选项:");
  console.log("  --clear-cache         清除缓存文件");
  console.log("  -h, --help            显示此帮助信息");
}

export async function run() {
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
  // 只统计 include 清单时范围并不完整，不能拿它去清理旧缓存
  let scopeComplete = false;
  if (app.repos.discover) {
    printColor("🔎 查询有自己提交的仓库...", YELLOW);
    const found = await discoverScopeRepos(app);
    scopeRepos = found.repos;
    // 查询不完整时只是「本轮已确认的部分」，范围判断不完整就不能清缓存
    scopeComplete = found.complete;
    const privateNote = found.privateRepos.length
      ? `，私有跳过 ${found.privateRepos.length}`
      : "";
    printColor(
      `    本轮命中 ${found.fresh} 个${privateNote}，名单累计 ${found.repos.length} 个`,
      NC,
    );
    if (!found.complete) {
      // 一条都没查到通常是令牌或权限出了问题。此时若只告警并沿用旧名单，卡片会
      // 长期停在旧数据上而 CI 始终是绿的，问题可以挂几周没人发现，所以直接失败
      if (!found.fresh) {
        printColor(
          "❌ 贡献清单查询没有任何结果，统计范围无法确认，本次终止",
          RED,
        );
        printColor(
          "   请检查 EMAILS_TOKEN 是否为本人令牌、是否具备 GraphQL 与读取邮箱的权限",
          NC,
        );
        return 1;
      }
      printColor(
        "⚠️  贡献清单查询不完整（配额或某一年的查询中断），本轮与上轮名单合并",
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

  const [anyChanged, failed] = await processRepos(app, repos, scopeComplete);

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

export const invokedDirectly =
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

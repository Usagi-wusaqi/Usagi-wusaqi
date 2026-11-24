/**
 * GitHub 数据获取：贡献清单、上游关系、账号邮箱，以及统计范围名单。
 */

import fs from "node:fs";
import path from "node:path";

import { DEFAULT_CONCURRENCY, YELLOW, intOf, nowIsoUtc, printColor } from "./format.js";
import { ApiError, apiJson, graphqlJson } from "./http.js";
import { mapPool } from "./pool.js";
import { normalizeFullName, repoFromFullName, repoKeyOf, upstreamOf } from "./repo.js";

/**
 * 接口每页最多回 100 条，配置写大也只回 100。逐个钳制，否则拿配置值判断
 * 「这一页排满没」会把「还有下一页」误判成「到底了」，列表悄悄少一截。
 */
export function apiPerPage(app) {
  return Math.min(Math.max(intOf(app.api.per_page, 100), 1), 100);
}

/**
 * 解析 fork 的上游，返回 `[owner, name, unknown]`。
 *
 * `unknown` 为真表示没能确认 fork 关系（配额耗尽、网络失败、详情读不到）。
 * 这时不能把它当独立仓库克隆，否则可能和上游重复计数，由调用方本轮跳过。
 */
export async function getUpstreamRepo(app, repo, request = apiJson) {
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
 * 把 GraphQL 返回的仓库节点变成仓库记录。
 *
 * `fork` 与 `parent` 直接照 REST 详情的形状填上，后面解析克隆目标时
 * `upstreamOf()` 能直接命中，省掉每个仓库一次详情请求。`fullDatabaseId` 与 REST
 * 的 `id` 是同一个值（`databaseId` 是 32 位整型，ID 超出范围时会返回 null），
 * 仓库改名后缓存靠它接续，不会被当成新仓库重算。
 */
export function repoFromGraphqlNode(node) {
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

/**
 * 先问有哪些年份有贡献，再按年份逐段取仓库。
 *
 * `repositoriesContributedTo` 只列最近一年（字段说明里的 "recently"），一年前动过、
 * 此后没再碰的仓库会整份掉队。`contributionsCollection` 可以传 from/to 指定时间段，
 * 逐年查一遍就能拿回全部历史。
 */
export const CONTRIBUTION_YEARS_QUERY = `
query {
  viewer {
    login
    contributionsCollection { contributionYears }
  }
}`;

/** 单年单段的查询：贡献按仓库分组，一段最多 100 个仓库。 */
export const CONTRIBUTIONS_WINDOW_QUERY = `
query ($from: DateTime!, $to: DateTime!) {
  viewer {
    contributionsCollection(from: $from, to: $to) {
      commitContributionsByRepository(maxRepositories: 100) {
        repository {
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
  }
}`;

// 最多查这么多年份，防账号历史异常长时把配额和运行时间耗光
const MAX_CONTRIBUTION_YEARS = 10;

/**
 * 一个自然年切成上下两段。
 *
 * `contributionsCollection` 的 from/to 跨度不能超过一年，闰年按 366 天算就可能被
 * 判超限；上下半年各 100 个仓库的量级也更稳，不会撞上单次查询的资源上限。
 */
export function yearWindows(year) {
  return [
    [`${year}-01-01T00:00:00Z`, `${year}-07-01T00:00:00Z`],
    [`${year}-07-01T00:00:00Z`, `${year}-12-31T23:59:59Z`],
  ];
}

/**
 * 用 GraphQL 的 `contributionsCollection` 按年份列出「有自己提交的仓库」。
 *
 * 口径与主页贡献图一致：按账号归属统计默认分支上的提交，直接给出仓库清单，
 * 不用先搜提交再反查仓库。逐年查完取并集，覆盖全部历史；返回的每个仓库还带着
 * fork 与上游关系。
 *
 * 令牌必须是账号本人的：Actions 内置令牌的身份是 bot，查到的 viewer 是它自己。
 * 因此拿到的登录名与统计目标不符时整轮放弃，免得把空名单当成「没有贡献的仓库」
 * 去覆盖缓存。
 */
export async function discoverRepos(app, request = null) {
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
  const found = new Map();
  // 私有仓库不进统计（卡片只算公开仓库），记下来只为日志和清缓存
  const privateRepos = new Map();
  let complete = true;

  const collect = (nodes) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      const repo = repoFromGraphqlNode(node?.repository ?? node);
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
  };

  // 第一步：拿到有贡献的年份，以及令牌对应的账号
  let head;
  try {
    head = await ask(app, CONTRIBUTION_YEARS_QUERY, {});
  } catch (exc) {
    // 配额用完或接口出错：本轮标记为不完整，调用方据此保留旧缓存
    const limited = exc instanceof ApiError && exc.kind === "rate_limit";
    printColor(
      limited
        ? "⚠️  GraphQL 配额用完，本轮查不到贡献仓库"
        : `⚠️  贡献仓库查询中断: ${exc?.message || "请求失败"}`,
      YELLOW,
    );
    return { repos: [], privateRepos: [], complete: false };
  }

  const viewer = head?.viewer;
  if (!viewer) {
    printColor("⚠️  贡献仓库查询没有返回 viewer，本轮跳过自动发现", YELLOW);
    return { repos: [], privateRepos: [], complete: false };
  }
  if (
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

  const years = (
    Array.isArray(viewer.contributionsCollection?.contributionYears)
      ? viewer.contributionsCollection.contributionYears
      : []
  )
    .map((year) => intOf(year, 0))
    .filter(Boolean)
    .sort((a, b) => b - a);
  if (years.length > MAX_CONTRIBUTION_YEARS) {
    // 名单只覆盖最近这些年，范围不完整：调用方会与上轮名单合并，不动旧缓存
    complete = false;
    printColor(
      `⚠️  贡献年份超过 ${MAX_CONTRIBUTION_YEARS} 个，只覆盖最近的部分`,
      YELLOW,
    );
  }

  // 第二步：逐年逐段取仓库。查询出错才停，年份数量截断不影响其余年份继续查
  let aborted = false;
  for (const year of years.slice(0, MAX_CONTRIBUTION_YEARS)) {
    for (const [from, to] of yearWindows(year)) {
      let data;
      try {
        data = await ask(app, CONTRIBUTIONS_WINDOW_QUERY, { from, to });
      } catch (exc) {
        const limited = exc instanceof ApiError && exc.kind === "rate_limit";
        printColor(
          limited
            ? `⚠️  GraphQL 配额用完，${year} 年只覆盖到已查到的仓库`
            : `⚠️  ${year} 年贡献查询中断，仅统计已查到的仓库: ${exc?.message || "请求失败"}`,
          YELLOW,
        );
        complete = false;
        aborted = true;
        break;
      }
      collect(data?.viewer?.contributionsCollection?.commitContributionsByRepository);
    }
    if (aborted) {
      break;
    }
  }

  return {
    repos: [...found.values()],
    privateRepos: [...privateRepos.values()],
    complete,
  };
}

/** 发现结果的落盘位置：放缓存目录的子目录，不会被按仓库名清理的 .json 扫到。 */
export function scopeCacheFile(app) {
  return path.join(app.cacheDir, "scope", "index.json");
}

/** 读回上次的发现结果；文件缺失或损坏时返回 null，视为还没有名单。 */
export function loadScopeCache(app) {
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

export function saveScopeCache(app, payload) {
  const file = scopeCacheFile(app);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch (exc) {
    printColor(`⚠️  统计范围缓存写入失败: ${exc.message}`, YELLOW);
  }
}

/** 合并两份仓库清单，按全名去重，先出现的优先。 */
export function mergeRepoLists(first, second) {
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
 * 自然退出名单；查询不完整（配额用完、某一年没查全）时与上一轮合并，只增不减，
 * 已知仓库不会因为一次失败就掉队。
 *
 * 名单本身仍是缓存的意义所在：查询彻底失败时下一轮还能拿它兜底，站点上的
 * scope.json 也从这里来。私有仓库不进统计，两种情况都从名单里摘掉。
 */
export async function discoverScopeRepos(app, request = null) {
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
export async function confirmIncludedRepos(app, include, request = apiJson) {
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
export function mergeRepos(discovered = [], include = [], exclude = []) {
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
export async function fetchAccountEmails(app) {
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

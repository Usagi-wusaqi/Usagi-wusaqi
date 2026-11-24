import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ApiError,
  App,
  cleanStaleCache,
  confirmIncludedRepos,
  discoverRepos,
  discoverScopeRepos,
  generateContributionsSvg,
  getUpstreamRepo,
  loadCache,
  mergeRepos,
  normalizeFullName,
  parseIsoTimestamp,
  parseToml,
  serializeCache,
} from "./generate_stats.js";
import {
  buildSummary,
  describeChanges,
  formatDelta,
  formatDuration,
  jsonPrettyArray,
  readSummary,
  renderIndex,
  scopeSignature,
  summariesEqual,
} from "./pipeline.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG = fs.readFileSync(path.join(ROOT, "config.toml"), "utf8");

test("TOML 子集解析覆盖实际用到的写法", () => {
  const config = parseToml(CONFIG);
  assert.equal(config.api.github_api_base, "https://api.github.com");
  assert.equal(config.api.per_page, 100);
  assert.equal(config.svg.custom_title, "Code Contributions");
  assert.equal(config.svg.layout.padding, 67);
  assert.equal(config.svg.layout.border_radius, 4.5);
  assert.equal(config.svg.font.family, "'Segoe UI', Ubuntu, Sans-Serif");
  assert.equal(config.behavior.concurrency, 6);
  assert.equal(config.repos.discover, true);
  assert.deepEqual(config.repos.include, []);
  assert.deepEqual(config.repos.exclude, []);
  assert.deepEqual(config.behavior.image_extensions, [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".svg",
    ".webp",
    ".ico",
  ]);
});

test("TOML 解析忽略注释、支持引号内的 # 与转义", () => {
  const parsed = parseToml(
    [
      "# 注释",
      "[section]",
      'inline = "a # b"  # 行尾注释',
      'escaped = "x\\"y"',
      "arr = [1, 2]",
      "flag = true",
    ].join("\n"),
  );
  assert.equal(parsed.section.inline, "a # b");
  assert.equal(parsed.section.escaped, 'x"y');
  assert.deepEqual(parsed.section.arr, [1, 2]);
  assert.equal(parsed.section.flag, true);
});

test("TOML 数组可跨行书写，行尾注释与末尾逗号不影响解析", () => {
  const parsed = parseToml(
    [
      "[repos]",
      "include = [",
      '  "o/a", # 甲',
      "  'https://github.com/o/b.git',",
      "]",
      "exclude = []",
      "",
      "[svg]",
      'custom_title = "t"',
    ].join("\n"),
  );
  assert.deepEqual(parsed.repos.include, ["o/a", "https://github.com/o/b.git"]);
  assert.deepEqual(parsed.repos.exclude, []);
  assert.equal(parsed.svg.custom_title, "t");
});

test("TOML 非法内容会抛错，由调用方回退默认配置", () => {
  assert.throws(() => parseToml("[api\nbase = 1"));
  assert.throws(() => parseToml("base"));
  assert.throws(() => parseToml('base = "unclosed'));
  assert.throws(() => parseToml('arr = [\n  "a",\n'));
});

test("卡片 SVG 的列位置与指标格式", () => {
  const app = new App("Usagi-wusaqi", "token");
  const svg = generateContributionsSvg(
    app,
    {
      total_commits: 12,
      total_additions: 123456,
      total_deletions: 7890,
      total_images: 42,
      latest_commit_timestamp: "2026-11-16T08:00:00+08:00",
    },
    "Usagi-wusaqi",
  );

  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="200"'));
  assert.ok(svg.includes('<text x="67" y="70" class="header">Code Contributions</text>'));
  assert.ok(svg.includes('translate(350, 120)'));
  assert.ok(svg.includes('translate(633, 120)'));
  assert.ok(svg.includes('translate(916, 120)'));
  assert.ok(svg.includes("+123,456"));
  assert.ok(svg.includes("-7,890"));
  assert.ok(svg.includes("+115,566"));
  assert.ok(svg.includes(">42<"));
  assert.ok(svg.endsWith("</svg>"));
});

test("没有自定义标题时按账号生成标题", () => {
  const app = new App("Usagi-wusaqi", "token");
  // 走 custom_title 为空的回退分支
  app.svg.custom_title = null;
  const stats = {
    total_commits: 0,
    total_additions: 0,
    total_deletions: 0,
    total_images: 0,
    latest_commit_timestamp: "",
  };
  const svg = generateContributionsSvg(app, stats, "usagi");
  assert.ok(svg.includes("usagi&apos;s Code Contributions"));

  const plural = generateContributionsSvg(app, stats, "usagis");
  assert.ok(plural.includes("usagis&apos; Code Contributions"));
});

test("缓存序列化可往返，metadata 与仓库分组原样读回", () => {
  const metadata = {
    total_commits: 2,
    total_additions: 100,
    total_deletions: 20,
    total_images: 1,
    latest_commit_timestamp: "2026-11-16T10:00:00+08:00",
    repo_id: "123",
    full_name: "Usagi-wusaqi/API-Detector",
  };
  const data = new Map([
    [
      "API-Detector",
      [
        {
          timestamp: "2026-11-15T10:00:00+08:00",
          index: 1,
          additions: 10,
          deletions: 2,
          images: 0,
          url: "https://github.com/Usagi-wusaqi/API-Detector/commit/aaa",
        },
        {
          timestamp: "2026-11-16T10:00:00+08:00",
          index: 2,
          additions: 90,
          deletions: 18,
          images: 1,
          url: "https://github.com/Usagi-wusaqi/API-Detector/commit/bbb",
        },
      ],
    ],
  ]);

  const text = serializeCache(metadata, data);
  assert.ok(text.endsWith("}\n"));
  assert.deepEqual(JSON.parse(text), {
    _metadata: metadata,
    data: Object.fromEntries(data),
  });
  // 提交保持序号顺序，读回来不能被打乱
  assert.deepEqual(
    JSON.parse(text).data["API-Detector"].map((commit) => commit.index),
    [1, 2],
  );
  assert.deepEqual(JSON.parse(serializeCache({}, new Map())), {
    _metadata: {},
    data: {},
  });
});

test("时间戳解析对齐 ISO 8601 与时区", () => {
  assert.equal(
    parseIsoTimestamp("2026-11-16T08:00:00+08:00"),
    parseIsoTimestamp("2026-11-16T00:00:00Z"),
  );
  assert.equal(parseIsoTimestamp(""), -Infinity);
  assert.equal(parseIsoTimestamp("not a date"), -Infinity);
});

test("站点索引页列出明细链接", () => {
  const html = renderIndex(["API-Detector.json", "Zenith.json"]);
  assert.ok(html.includes('<li><a href="data/API-Detector.json">API-Detector.json</a></li>'));
  assert.ok(html.includes('<li><a href="data/Zenith.json">Zenith.json</a></li>'));
  assert.ok(html.includes('<img src="contributions.svg"'));
});

test("manifest 与耗时格式", () => {
  assert.equal(jsonPrettyArray(["a.json"]), '[\n  "a.json"\n]\n');
  assert.equal(jsonPrettyArray([]), "[]\n");
  assert.equal(formatDuration(59), "59 秒");
  assert.equal(formatDuration(671), "11 分 11 秒");
  assert.equal(formatDuration(0), "0 秒");
  assert.equal(formatDelta(3), "+3");
  assert.equal(formatDelta(-3), "-3");
  assert.equal(formatDelta(0), "0");
  assert.equal(formatDelta(1234), "+1,234");
});

test("发现缓存的签名忽略更新时间与名单顺序，只看仓库", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usagi-signature-"));
  try {
    const write = (name, payload) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, JSON.stringify(payload));
      return file;
    };
    const base = {
      version: 2,
      updated_at: "2026-05-01T00:00:00.000000+00:00",
      repos: [{ full_name: "Org/A" }, { full_name: "org/b" }],
    };
    const first = write("first.json", base);
    // 只有写入时间和名单顺序变了，内容等价，不该触发重新部署
    const same = write("same.json", {
      ...base,
      updated_at: "2026-05-02T00:00:00.000000+00:00",
      repos: [{ full_name: "org/b" }, { full_name: "org/a" }],
    });
    assert.equal(scopeSignature(first), scopeSignature(same));

    // 名单变化要算作有更新
    assert.notEqual(
      scopeSignature(first),
      scopeSignature(write("repos.json", { ...base, repos: [{ full_name: "org/a" }] })),
    );
    // 读不到文件时给空串：调用方按有变化处理，最多多部署一次
    assert.equal(scopeSignature(path.join(dir, "missing.json")), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function snapshot() {
  return {
    repo_count: 2,
    total_commits: 2,
    total_additions: 100,
    total_deletions: 20,
    total_images: 1,
    latest_commit_timestamp: "2026-11-16T10:00:00+08:00",
    repos: {
      "API-Detector.json": {
        commits: 1,
        additions: 50,
        deletions: 10,
        images: 0,
        latest: "2026-11-15T10:00:00+08:00",
      },
      "Other.json": {
        commits: 1,
        additions: 50,
        deletions: 10,
        images: 1,
        latest: "2026-11-16T10:00:00+08:00",
      },
    },
  };
}

test("摘要对比：无上次数据时说明暂无对比", () => {
  assert.equal(
    describeChanges(null, snapshot()),
    "- 首次运行或上次汇总不可用，暂无对比数据",
  );
});

test("摘要对比：数据不变时明确说明", () => {
  assert.equal(describeChanges(snapshot(), snapshot()), "- 各项数据均无变化");
  assert.equal(
    describeChanges(snapshot(), snapshot(), 2),
    "- 各项数据均无变化\n- 注意：2 份缓存恢复失败，对比可能不完整",
  );
});

test("摘要对比：列出总量与仓库级变化", () => {
  const before = snapshot();
  const after = snapshot();
  after.total_commits = 4;
  after.total_additions = 145;
  after.total_deletions = 24;
  after.total_images = 2;
  after.latest_commit_timestamp = "2026-11-17T09:00:00+08:00";
  after.repos["API-Detector.json"].commits = 3;
  after.repos["API-Detector.json"].additions = 95;
  after.repos["API-Detector.json"].deletions = 14;
  after.repos["API-Detector.json"].latest = after.latest_commit_timestamp;

  // 一行一个维度：删除行与卡片、git diff 一样记负，不会两边都是加号
  assert.equal(
    describeChanges(before, after),
    [
      "- 提交 +2，新增 +45 行 / 删除 -4 行，图片 +1",
      "- 最新提交：更新至 2026-11-17T09:00:00+08:00",
      "- 仓库明细：",
      "  - API-Detector：提交 +2，新增 +45 行 / 删除 -4 行，最新提交时间更新",
    ].join("\n"),
  );
});

test("摘要对比：新增与移除的仓库分别说明", () => {
  const before = snapshot();
  const after = snapshot();
  after.repos = {
    "API-Detector.json": after.repos["API-Detector.json"],
    "New.json": {
      commits: 1,
      additions: 7,
      deletions: 0,
      images: 0,
      latest: "2026-11-17T09:00:00+08:00",
    },
  };

  assert.equal(
    describeChanges(before, after),
    ["- 新增仓库：New", "- 移除仓库：Other"].join("\n"),
  );
});

test("buildSummary 汇总目录并跳过损坏的缓存", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usagi-stats-"));
  try {
    fs.writeFileSync(
      path.join(dir, "A.json"),
      JSON.stringify({
        _metadata: {
          total_commits: 3,
          total_additions: 40,
          total_deletions: 5,
          total_images: 1,
          latest_commit_timestamp: "2026-11-16T10:00:00+08:00",
        },
      }),
    );
    fs.writeFileSync(path.join(dir, "B.json"), "{ broken");
    fs.writeFileSync(path.join(dir, "notes.txt"), "skip me");

    const summary = buildSummary(dir);
    assert.equal(summary.repo_count, 2);
    assert.equal(summary.total_commits, 3);
    assert.equal(summary.total_additions, 40);
    assert.equal(summary.total_deletions, 5);
    assert.equal(summary.total_images, 1);
    assert.equal(summary.latest_commit_timestamp, "2026-11-16T10:00:00+08:00");
    assert.deepEqual(Object.keys(summary.repos), ["A.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readSummary 读回发布用的汇总 JSON，损坏时返回 null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usagi-summary-"));
  try {
    const file = path.join(dir, "latest.json");
    const value = buildSummary(dir);
    fs.writeFileSync(file, JSON.stringify(value), "utf8");
    assert.deepEqual(readSummary(file), value);
    fs.writeFileSync(file, "{ broken", "utf8");
    assert.equal(readSummary(file), null);
    assert.equal(readSummary(path.join(dir, "missing.json")), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function summaryFixture() {
  return {
    repo_count: 2,
    total_commits: 3,
    total_additions: 40,
    total_deletions: 5,
    total_images: 1,
    latest_commit_timestamp: "2026-11-16T10:00:00+08:00",
    repos: {
      "A.json": {
        commits: 2,
        additions: 30,
        deletions: 4,
        images: 1,
        latest: "2026-11-16T10:00:00+08:00",
      },
      "B.json": {
        commits: 1,
        additions: 10,
        deletions: 1,
        images: 0,
        latest: "2026-11-15T10:00:00+08:00",
      },
    },
  };
}

/** 造一条只含统计所需字段的仓库记录。 */
function repoOf(full, extra = {}) {
  const [owner, name] = full.split("/");
  const repo = { name, full_name: full, html_url: `https://github.com/${full}`, fork: false };
  return { ...repo, ...extra };
}

test("仓库名归一化：接受 owner/name、完整地址与 .git 后缀", () => {
  assert.equal(normalizeFullName("o/r"), "o/r");
  assert.equal(normalizeFullName("https://github.com/o/r.git"), "o/r");
  assert.equal(normalizeFullName("  github.com/o/r/  "), "o/r");
  assert.equal(normalizeFullName("r"), "");
  assert.equal(normalizeFullName(""), "");
  assert.equal(normalizeFullName(undefined), "");
});

test("统计范围只留公开仓库：私有仓库即使出现在发现结果里也剔除", () => {
  const { repos } = mergeRepos(
    [repoOf("me/public"), repoOf("me/secret", { private: true })],
    ["me/other"],
  );
  assert.deepEqual(repos.map((repo) => repo.full_name), ["me/other", "me/public"]);
});

test("统计范围合并：清单在前、按名去重、排除名单生效", () => {
  const { repos, added, excluded } = mergeRepos(
    [
      repoOf("me/mine", { fork: true }),
      repoOf("org/kept"),
      repoOf("org/dropped"),
      repoOf("ORG/KEPT"),
    ],
    ["https://github.com/org/extra.git", "缺归属"],
    ["org/dropped"],
  );

  assert.deepEqual(
    repos.map((repo) => repo.full_name),
    ["org/extra", "me/mine", "org/kept"],
  );
  assert.deepEqual(added, { included: 1, discovered: 2 });
  assert.equal(excluded, 1);
  // 清单里只有名字，fork 关系未知，交由上游解析查详情
  assert.equal("fork" in repos[0], false);
  assert.equal(repos[0].html_url, "https://github.com/org/extra");
});

/** 造「有哪些年份有贡献」的响应。 */
const yearsPage = (years, login = "me") => ({
  viewer: { login, contributionsCollection: { contributionYears: years } },
});

/** 造某一年某一个时间段的响应；仓库按接口的 commitContributionsByRepository 形状包一层。 */
const windowPage = (nodes) => ({
  viewer: {
    contributionsCollection: {
      commitContributionsByRepository: nodes.map((node) => ({ repository: node })),
    },
  },
});

/**
 * 一轮贡献清单的假查询：先回年份，之后每段都回这一批仓库。
 * 直接当作 discoverRepos / discoverScopeRepos 的 request 参数用。
 */
const contributedPage = (nodes) => async (instance, query) =>
  query.includes("contributionYears") ? yearsPage([2026]) : windowPage(nodes);

const contributionNode = (full, extra = {}) => {
  const [owner, name] = full.split("/");
  return {
    nameWithOwner: `${owner}/${name}`,
    isPrivate: false,
    isFork: false,
    parent: null,
    ...extra,
  };
};

test("按年份逐段收集仓库，跨年去重", async () => {
  const app = new App("me", "token");

  const queries = [];
  const found = await discoverRepos(app, async (instance, query, variables) => {
    queries.push({ query, variables });
    if (query.includes("contributionYears")) {
      return yearsPage([2025, 2024]);
    }
    assert.match(query, /commitContributionsByRepository/);
    assert.match(query, /fullDatabaseId/);
    if (variables.from.startsWith("2025-01")) {
      return windowPage([
        contributionNode("org/one", { fullDatabaseId: "1001" }),
        contributionNode("me/fork", {
          isFork: true,
          parent: { nameWithOwner: "up/real" },
        }),
      ]);
    }
    if (variables.from.startsWith("2025-07")) {
      // 同一个仓库在上下半年都出现过，只算一次
      return windowPage([contributionNode("me/fork", { isFork: true })]);
    }
    if (variables.from.startsWith("2024-01")) {
      return windowPage([contributionNode("org/old", { fullDatabaseId: "1002" })]);
    }
    return windowPage([]);
  });

  // 先问年份，再按年份从新到旧、一年两段
  assert.equal(queries.length, 1 + 2 * 2);
  assert.ok(queries[0].query.includes("contributionYears"));
  assert.deepEqual(queries[1].variables, {
    from: "2025-01-01T00:00:00Z",
    to: "2025-07-01T00:00:00Z",
  });
  assert.deepEqual(
    found.repos.map((repo) => repo.full_name),
    ["org/one", "me/fork", "org/old"],
  );
  assert.equal(found.complete, true);
  assert.equal(found.repos[0].id, "1001");

  // fork 与上游直接由查询带回来，解析克隆目标时不必再查一次详情
  const fork = found.repos.find((repo) => repo.full_name === "me/fork");
  assert.equal(fork.fork, true);
  const [owner, name, unknown] = await getUpstreamRepo(app, fork, async () => {
    throw new Error("不该再请求详情");
  });
  assert.deepEqual([owner, name], ["up", "real"]);
  assert.equal(unknown, false);
});

test("问年份的查询失败时返回空名单并标记结果不完整", async () => {
  const app = new App("me", "token");
  const found = await discoverRepos(app, async () => {
    throw new ApiError("rate_limit", "GitHub GraphQL 配额耗尽");
  });
  assert.deepEqual(found.repos, []);
  assert.equal(found.complete, false);
});

test("某一段查询中断时标记结果不完整，已查到的照常返回", async () => {
  const app = new App("me", "token");

  const found = await discoverRepos(app, async (instance, query, variables) => {
    if (query.includes("contributionYears")) {
      return yearsPage([2026, 2025]);
    }
    if (variables.from.startsWith("2026-01")) {
      return windowPage([contributionNode("org/recent")]);
    }
    throw new ApiError("failure", "HTTP 502: Bad Gateway");
  });

  assert.equal(found.complete, false);
  assert.deepEqual(
    found.repos.map((repo) => repo.full_name),
    ["org/recent"],
  );
});

test("年份超过上限时只查最近的部分，并标记范围不完整", async () => {
  const app = new App("me", "token");
  const years = Array.from({ length: 11 }, (_, i) => 2026 - i);
  const asked = [];

  const found = await discoverRepos(app, async (instance, query, variables) => {
    if (query.includes("contributionYears")) {
      return yearsPage(years);
    }
    asked.push(variables.from.slice(0, 4));
    return windowPage([contributionNode(`org/y${variables.from.slice(0, 4)}`)]);
  });

  // 名单只覆盖最近 10 年：范围不完整，调用方据此保留旧名单与旧缓存
  assert.equal(found.complete, false);
  // 截断只影响年份数量，其余年份的两段都要查完，不能提前收工
  assert.deepEqual(
    asked,
    years.slice(0, 10).flatMap((year) => [String(year), String(year)]),
  );
  assert.equal(found.repos.length, 10);
});

test("令牌不是本人时整轮放弃，不拿 bot 的空名单覆盖缓存", async () => {
  const app = new App("me", "token");

  let calls = 0;
  const found = await discoverRepos(app, async () => {
    calls += 1;
    return yearsPage([], "github-actions[bot]");
  });

  // 登录名不符就不该继续查年份下的仓库
  assert.equal(calls, 1);
  assert.deepEqual(found.repos, []);
  assert.equal(found.complete, false);
});

test("贡献清单里的私有仓库直接跳过", async () => {
  const app = new App("me", "token");

  const found = await discoverRepos(app, async (instance, query) => {
    if (query.includes("contributionYears")) {
      return yearsPage([2026]);
    }
    return windowPage([
      contributionNode("org/pub"),
      contributionNode("org/priv", { isPrivate: true }),
    ]);
  });

  assert.deepEqual(
    found.repos.map((repo) => repo.full_name),
    ["org/pub"],
  );
  assert.deepEqual(found.privateRepos, ["org/priv"]);
  assert.equal(found.complete, true);
});

test("查询完整时名单以本轮为准，不完整时与上轮合并只增不减", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usagi-scope-"));
  try {
    const app = new App("me", "token");
    app.cacheDir = dir;
    const file = path.join(dir, "scope", "index.json");

    const first = await discoverScopeRepos(
      app,
      contributedPage([
        contributionNode("org/keep", { fullDatabaseId: "1001" }),
        contributionNode("org/gone"),
      ]),
    );
    assert.deepEqual(
      first.repos.map((repo) => repo.full_name),
      ["org/keep", "org/gone"],
    );

    // 第二轮完整：org/gone 已被删除或失去访问权，它自然退出名单
    const second = await discoverScopeRepos(
      app,
      contributedPage([contributionNode("org/keep", { fullDatabaseId: "1001" })]),
    );
    assert.equal(second.complete, true);
    assert.deepEqual(
      second.repos.map((repo) => repo.full_name),
      ["org/keep"],
    );

    // 第三轮查询失败：名单退回缓存，已统计的仓库不会掉队
    const third = await discoverScopeRepos(app, async () => {
      throw new ApiError("failure", "HTTP 502: Bad Gateway");
    });
    assert.equal(third.complete, false);
    assert.deepEqual(
      third.repos.map((repo) => repo.full_name),
      ["org/keep"],
    );

    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    // 仓库 ID 一并落盘：改名后缓存靠它接续，不会被当成新仓库重算
    assert.deepEqual(saved.repos, [{ full_name: "org/keep", id: "1001" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("转私有的仓库从名单里立刻退出", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usagi-scope-"));
  try {
    const app = new App("me", "token");
    app.cacheDir = dir;

    await discoverScopeRepos(app, contributedPage([contributionNode("org/one")]));

    const second = await discoverScopeRepos(
      app,
      contributedPage([contributionNode("org/one", { isPrivate: true })]),
    );

    assert.deepEqual(second.repos, []);
    assert.deepEqual(second.privateRepos, ["org/one"]);
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, "scope", "index.json"), "utf8"),
    );
    assert.deepEqual(saved.repos, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("显式清单也校验：私有与 404 剔除，网络抖动时按原样保留", async () => {
  const app = new App("me", "token");
  const kept = await confirmIncludedRepos(
    app,
    [
      "org/pub",
      "org/priv",
      "https://github.com/org/missing.git",
      "org/flaky",
    ],
    async (instance, url) => {
      if (url.endsWith("/org/priv")) {
        return { full_name: "org/priv", private: true };
      }
      if (url.endsWith("/org/missing")) {
        throw new ApiError("failure", "HTTP 404: Not Found");
      }
      if (url.endsWith("/org/flaky")) {
        throw new ApiError("failure", "HTTP 502: Bad Gateway");
      }
      return { full_name: "org/pub", private: false };
    },
  );

  assert.deepEqual(
    kept.map((repo) => repo.full_name),
    ["org/pub", "org/flaky"],
  );
  // 读到详情的带上详情，读不到（502）的退回只有名字的最小记录
  assert.equal(kept[0].private, false);
  assert.equal(kept[1].fork, undefined);
});

test("清单里的仓库读到详情后，解析克隆目标时不重复查一次", async () => {
  const app = new App("me", "token");
  let calls = 0;
  const included = await confirmIncludedRepos(app, ["org/mirror"], async () => {
    calls += 1;
    return {
      id: 9,
      name: "mirror",
      full_name: "org/mirror",
      html_url: "https://github.com/org/mirror",
      fork: true,
      parent: { owner: { login: "up" }, name: "real" },
    };
  });
  assert.equal(calls, 1);

  const { repos } = mergeRepos([], included, []);
  assert.equal(repos[0].full_name, "org/mirror");

  let extra = 0;
  const [owner, name, unknown] = await getUpstreamRepo(app, repos[0], async () => {
    extra += 1;
    throw new Error("不该再请求详情");
  });
  assert.deepEqual([owner, name], ["up", "real"]);
  assert.equal(unknown, false);
  assert.equal(extra, 0);
});



test("上游详情读不到时不算作独立仓库，交由调用方跳过", async () => {
  const app = new App("me", "token");
  const [owner, name, unknown] = await getUpstreamRepo(
    app,
    { name: "r", full_name: "org/r", html_url: "https://github.com/org/r" },
    async () => {
      throw new ApiError("failure", "HTTP 500");
    },
  );
  assert.deepEqual([owner, name], [null, null]);
  assert.equal(unknown, true);
});


test("清单里未标 fork 的仓库会查详情换算上游，明确的非 fork 不查", async () => {
  const app = new App("me", "token");
  const includeRepo = {
    name: "r",
    full_name: "org/r",
    html_url: "https://github.com/org/r",
  };
  let called = 0;
  const [owner, name] = await getUpstreamRepo(app, includeRepo, async (instance, url) => {
    called += 1;
    assert.equal(url, "https://api.github.com/repos/org/r");
    return { fork: true, parent: { owner: { login: "up" }, name: "r" } };
  });
  assert.deepEqual([owner, name], ["up", "r"]);
  assert.equal(called, 1);

  // 发现结果里明确标了非 fork，不发详情请求
  const [o2, n2] = await getUpstreamRepo(
    app,
    { fork: false, name: "r", full_name: "org/r" },
    async () => {
      called += 1;
      return {};
    },
  );
  assert.deepEqual([o2, n2], [null, null]);
  assert.equal(called, 1);
});


test("仓库改名后按 ID 接续缓存，旧键的提交不会被算两遍", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usagi-rename-"));
  try {
    const app = new App("me", "token");
    app.cacheDir = dir;
    fs.writeFileSync(
      path.join(dir, "old.json"),
      JSON.stringify({
        _metadata: { repo_id: 73, total_commits: 1 },
        data: {
          old: [
            {
              timestamp: "2026-01-01T00:00:00Z",
              index: 1,
              additions: 5,
              deletions: 1,
              images: 0,
              url: "https://github.com/me/old/commit/abc",
            },
            // 同一提交改名前后各存过一份：地址不同、sha 相同，只该留一条
            {
              timestamp: "2026-01-01T00:00:00Z",
              index: 2,
              additions: 5,
              deletions: 1,
              images: 0,
              url: "https://github.com/me/new/commit/abc",
            },
          ],
        },
      }),
    );

    const cache = loadCache(app, "new", { color() {} }, "73");

    // 文件按新名接续，分组键也挪到新名下：两个键并存时，旧键既读不到又会被
    // 原样写回，汇总会把同一批提交算两遍；同一 sha 的旧、新地址也只留一条
    assert.deepEqual([...cache.keys()], ["new"]);
    assert.equal(cache.get("new").length, 1);
    assert.equal(fs.existsSync(path.join(dir, "new.json")), true);
    assert.equal(fs.existsSync(path.join(dir, "old.json")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("缓存里残留改名前的分组键时，读入即归并到当前仓库名下", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usagi-rekey-"));
  try {
    const app = new App("me", "token");
    app.cacheDir = dir;
    const entry = (url) => ({
      timestamp: "2026-01-01T00:00:00Z",
      index: 1,
      additions: 5,
      deletions: 1,
      images: 0,
      url,
    });
    fs.writeFileSync(
      path.join(dir, "new.json"),
      JSON.stringify({
        _metadata: {},
        data: {
          old: [entry("https://github.com/me/old/commit/abc")],
          new: [entry("https://github.com/me/new/commit/abc")],
        },
      }),
    );

    const cache = loadCache(app, "new", { color() {} });

    assert.deepEqual([...cache.keys()], ["new"]);
    assert.equal(cache.get("new").length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("清理失效提交按 sha 比对，仓库改名不会把整份缓存判成过期", () => {
  const log = { color() {} };
  const entry = (url) => ({
    timestamp: "2026-01-01T00:00:00Z",
    index: 1,
    additions: 5,
    deletions: 1,
    images: 0,
    url,
  });

  const renamed = new Map([["repo", [entry("https://github.com/me/old/commit/abc")]]]);
  cleanStaleCache(renamed, [["abc", "2026-01-01T00:00:00Z"]], "repo", false, log);
  assert.equal(renamed.get("repo").length, 1);

  const rewritten = new Map([["repo", [entry("https://github.com/me/repo/commit/abc")]]]);
  cleanStaleCache(rewritten, [["def", "2026-01-02T00:00:00Z"]], "repo", false, log);
  assert.equal(rewritten.has("repo"), false);
});

test("fork 套 fork 时按根仓库解析克隆目标，避免与根仓库重复统计", async () => {
  const app = new App("me", "token");
  const found = await discoverRepos(
    app,
    contributedPage([
      contributionNode("me/mid", {
        isFork: true,
        parent: { nameWithOwner: "x/mid", parent: { nameWithOwner: "up/root" } },
      }),
    ]),
  );

  const [owner, name] = await getUpstreamRepo(app, found.repos[0], async () => {
    throw new Error("不该再请求详情");
  });
  assert.deepEqual([owner, name], ["up", "root"]);
});

const clone = (value) => JSON.parse(JSON.stringify(value));

test("汇总比对：完全一致才判为无需部署", () => {
  const base = summaryFixture();
  assert.equal(summariesEqual(clone(base), base), true);
  assert.equal(summariesEqual(null, base), false);
  assert.equal(summariesEqual(base, null), false);

  // 提交数变化（卡片只画增删行，不改这些字段就会被漏掉）
  const moreCommits = clone(base);
  moreCommits.total_commits = 4;
  moreCommits.repos["A.json"].commits = 3;
  assert.equal(summariesEqual(moreCommits, base), false);

  // 仓库间增删行互换，总数不变
  const swapped = clone(base);
  swapped.repos["A.json"].additions = 25;
  swapped.repos["B.json"].additions = 15;
  assert.equal(summariesEqual(swapped, base), false);

  // 仓库增删，总数不变
  const replaced = clone(base);
  delete replaced.repos["B.json"];
  replaced.repos["C.json"] = clone(base.repos["B.json"]);
  assert.equal(summariesEqual(replaced, base), false);

  // 最新提交时间变化
  const newer = clone(base);
  newer.latest_commit_timestamp = "2026-11-17T10:00:00+08:00";
  assert.equal(summariesEqual(newer, base), false);

  // 仓库数量变化
  const fewer = clone(base);
  delete fewer.repos["B.json"];
  fewer.repo_count = 1;
  assert.equal(summariesEqual(fewer, base), false);
});

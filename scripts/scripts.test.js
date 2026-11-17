import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  App,
  generateContributionsSvg,
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

test("TOML 非法内容会抛错，由调用方回退默认配置", () => {
  assert.throws(() => parseToml("[api\nbase = 1"));
  assert.throws(() => parseToml("base"));
  assert.throws(() => parseToml('base = "unclosed'));
});

test("卡片 SVG 的列位置与指标格式", () => {
  const app = new App("Usagi-wusaqi", "Usagi-wusaqi", "token");
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
  const app = new App("Usagi-wusaqi", "Usagi-wusaqi", "token");
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

test("缓存序列化与已发布产物逐字节一致", () => {
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

  const expected = `{
  "_metadata": {"total_commits": 2, "total_additions": 100, "total_deletions": 20, "total_images": 1, "latest_commit_timestamp": "2026-11-16T10:00:00+08:00", "repo_id": "123", "full_name": "Usagi-wusaqi/API-Detector"},
  "data": {"API-Detector": [
      {"timestamp": "2026-11-15T10:00:00+08:00", "index": 1, "additions": 10, "deletions": 2, "images": 0, "url": "https://github.com/Usagi-wusaqi/API-Detector/commit/aaa"}
      ,{"timestamp": "2026-11-16T10:00:00+08:00", "index": 2, "additions": 90, "deletions": 18, "images": 1, "url": "https://github.com/Usagi-wusaqi/API-Detector/commit/bbb"}
    ]
  }
}
`;
  assert.equal(serializeCache(metadata, data), expected);
  assert.equal(
    serializeCache({}, new Map()),
    '{\n  "_metadata": {},\n  "data": {}\n}\n',
  );
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
    "首次运行或上次汇总不可用，暂无对比数据",
  );
});

test("摘要对比：数据不变时明确说明", () => {
  assert.equal(
    describeChanges(snapshot(), snapshot()),
    "较上一次运行，各项数据均无变化",
  );
  assert.equal(
    describeChanges(snapshot(), snapshot(), 2),
    "较上一次运行，各项数据均无变化（2 份缓存恢复失败，对比可能不完整）",
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

  const text = describeChanges(before, after);
  assert.ok(
    text.startsWith(
      "较上一次运行：提交 +2，增删行 +45 / +4，图片 +1，最新提交更新至 2026-11-17T09:00:00+08:00",
    ),
  );
  assert.ok(
    text.includes(
      "仓库变化：API-Detector（提交 +2，增删行 +45 / +4，最新提交时间更新）",
    ),
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

  const text = describeChanges(before, after);
  assert.ok(text.includes("新增 New"));
  assert.ok(text.includes("移除 Other"));
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

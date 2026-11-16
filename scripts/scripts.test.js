import assert from "node:assert/strict";
import fs from "node:fs";
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
import { formatDuration, jsonPrettyArray, renderIndex } from "./pipeline.js";

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
});

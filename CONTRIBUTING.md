# 主页与统计卡片

`README.md` 由 GitHub 渲染成个人主页，其余文件实现一套自建的贡献统计：按账号汇总各仓库的提交，算出增删行数与图片数，生成一张 SVG 卡片和逐仓库明细，由 GitHub Actions 定时发布到 GitHub Pages。主页只引用一条固定的卡片地址，统计产物不进仓库。

主页上的访问计数、装饰图等图片来自外部服务，与本统计无关。

## 目录

- [指标与口径](#指标与口径)
- [目录结构](#目录结构)
- [工作流程](#工作流程)
- [统计范围](#统计范围)
- [缓存与清理](#缓存与清理)
- [配置与运行](#配置与运行)
- [自动化与发布](#自动化与发布)

## 指标与口径

卡片展示四列指标：

| 列 | 含义 |
| --- | --- |
| `Additions` | 归属提交新增的行数合计 |
| `Deletions` | 归属提交删除的行数合计 |
| `Net` | 新增行数减删除行数 |
| `Images` | 新增文件里扩展名命中 `image_extensions` 的图片数 |

归属提交指作者邮箱命中账号邮箱集合的提交，提交者姓名不参与判断，`Co-authored-by` 邮箱同样计入。邮箱在运行时经 `/user/emails` 获取，只存在内存里。

提交与行数主要取自 `git log`，克隆缺失或无结果时由 REST API 补上。克隆用 blobless 部分克隆（`--filter=blob:none`），只取元数据，环境不支持时回退全量。仓库默认 6 个并发，见 `[behavior] concurrency`。

## 目录结构

```text
.
├── README.md                        # 个人主页，人工维护
├── config.toml                      # API、统计范围、SVG 样式与运行参数
├── package.json                     # ESM 声明与 npm 脚本，无第三方依赖
├── scripts/
│   ├── generate_stats.js            # 入口
│   ├── lib/                         # 按职责分层，只允许向下依赖
│   ├── pipeline.js                  # 站点读写与运行摘要
│   ├── lint.js                      # 对所有脚本做 node --check
│   └── scripts.test.js              # 单元测试
├── .github/workflows/
│   ├── update-stats.yml             # 每日统计与 Pages 部署
│   └── lint.yml                     # 语法检查与单元测试
├── .gitignore                       # 排除运行时产物与各类缓存
├── .gitattributes                   # 统一 LF 行尾，图片按二进制处理
└── CONTRIBUTING.md                  # 仓库说明
```

`pipeline.js` 提供 `restore`、`site`、`purge`、`summary` 四个子命令。

## 工作流程

```text
GraphQL 取仓库清单 → git log 取提交与行数
        ↓ scripts/stats_cache/<repo>.json + contributions.svg
scripts/pipeline.js site 打包 _site/
        ↓ 卡片 + index.html + data/*.json
上传 Pages 产物 → 部署 → 清除 camo 缓存
        ↓
GitHub Pages ← README 中的固定图片链接
```

卡片有变化时整张替换、主页链接固定；无变化时跳过部署。入口是 `generate_stats.js`，`lib/` 实现细节，`pipeline.js` 管站点交互；Actions 只按顺序调用，不参与计算。

## 统计范围

只统计公开仓库，且只统计「本人提交过的仓库」，不限于账号名下。

**清单从哪来。** 一次 GraphQL 查询先取得有贡献的年份（`contributionYears`），再逐年、按上下半年查询 `contributionsCollection`，把每段返回的 `commitContributionsByRepository` 并成仓库清单。半年一段，是因为 `from` 与 `to` 相差不能超过一年（闰年按 366 天算会校验失败），也不至于触及单次查询的资源上限。

`contributionsCollection` 不传时间参数只返回最近一年，久未变动的仓库会缺席，只能逐年显式查询。脚本最多回溯 10 年（`MAX_CONTRIBUTION_YEARS`）：每年两次查询，历史极长会耗掉配额与运行时间，上限由脚本设定，与 GitHub 的限制无关。年份超过 10 个时本轮只覆盖最近十年，标记为范围不完整。

只看默认分支，比主页贡献图窄：贡献图还数 `gh-pages` 的提交，那是页面不是代码。

**令牌。** 必须用账号本人的令牌（`EMAILS_TOKEN`）。Actions 内置令牌是 bot 身份，返回的 `viewer` 是它自己。脚本核对返回的登录名，不一致时整轮放弃，不用空名单覆盖缓存。

**名单稳定性。** 每轮完整查一次并存盘复用：

- 查询完整时以本轮结果为准，删除、转私有、失去访问权的仓库自然退出。
- 查询不完整时（配额用完、某年未查全、年份超上限）与上一轮合并，只增不减，本轮也不清理旧缓存。
- 一条都没查到（通常是令牌或权限问题）直接失败退出，不用旧名单顶替，否则卡片停在旧数据而 CI 仍显示成功。

按需调整范围：

| 配置项 | 作用 |
| --- | --- |
| `[repos] include` | 额外统计的仓库，填 `owner/name` 或仓库地址，一行一个；私有、不存在、无权访问的会被剔除 |
| `[repos] exclude` | 无论来自哪个来源都剔除，按 `owner/name` 精确匹配，适合内容重复的镜像仓 |
| `[repos] discover` | 设为 `false` 时跳过查询，只统计 `include` 清单 |

清单也会遗漏：仅以共同作者身份参与、后来被移出协作者的仓库查不到，可用 `include` 补。私有仓库无论来源都会被剔除，卡片只反映公开提交。

## 缓存与清理

缓存随时可以删除，下次运行会重新克隆统计，数字不变。脚本只在确认仓库已不在范围内时才删，可能看漏的一律跳过。

| 路径 | 内容 |
| --- | --- |
| `scripts/stats_cache/<repo>.json` | 逐仓库提交明细，含 `_metadata`（提交数、增删行数、图片数、最新提交时间、`repo_id`、`full_name`）与 `data`（每条提交的 `index`、`timestamp`、`additions`、`deletions`、`images`、`url`） |
| `scripts/stats_cache/scope/index.json` | 统计范围的发现结果，是唯一不按仓库命名的缓存，不列入明细清单，也不参与汇总与清理 |

两份都随产物发布（后者发布为 `data/scope.json`），下次运行先取回作基线。写入规则：

- 按 sha 去重，只追加新提交，写回前按时间排序并重建序号。
- 改名后地址改变而 sha 不变，旧缓存继续复用并更新地址；名单里的 `repo_id` 让改名、转让后的仓库接续，不被当成新仓库。
- 单仓库克隆或分析失败时沿用上次缓存照常发布，本轮新提交不计入。
- 缓存以仓库名为准，不同归属的同名仓库会争用同一文件，后一个跳过并记日志。

### 清理条件

| 范围 | 触发条件 |
| --- | --- |
| 单个提交 | `git log` 完整取到时按 sha 比对，变基、压缩、强推后已不在历史中的提交被移除，日志写明清掉几条；走 API 兜底时只清理落在接口返回时间范围内的提交，范围外一律保留 |
| 整份仓库缓存 | 该仓库的提交在历史中全部消失（缓存清空，下一轮按新提交重建）；或本轮查询完整，而该仓库既不在名单里、`repo_id` 也对不上（仓库被删除、转为私有、失去访问权、被 `exclude` 排除） |
| 整个缓存目录 | 仅手动执行 `node scripts/generate_stats.js --clear-cache`，`scripts/stats_cache/` 与 `temp_repos/` 一并删除 |

**十年以前活跃的仓库，缓存不会被删除。** 年份超过 10 个时本轮只查最近十年并标记不完整，整轮不清理：早年仓库虽查不到，缓存仍在磁盘上并计入汇总，卡片数字不会因超出十年而变少，只在手动清空时消失。以下情况同样不清理：

- 名单查询失败，或某年查询中断（配额、网络、权限）
- 年份被 10 年上限截断
- 读取 fork 关系失败，无法确认上游
- 单仓库克隆或分析失败
- `[repos] discover` 为 `false`，范围只有 `include`
- API 兜底时落在接口返回时间范围外的提交

这些情况只在日志里说明范围可能不完整，等下一轮查完整再判断。

站点 `data/manifest.json` 读不到时（首次部署、站点重置）从空缓存开始，全部重新克隆，数字不变。

## 配置与运行

`config.toml` 分七段：`[api]` 接口地址与分页；`[repos]` 自动发现与补充、排除名单；`[svg]` 及子段管标题、配色、宽高、内边距、坐标、圆角、字体字号与四列标题；`[behavior]` 图片扩展名、进度打印间隔、并发度、分隔线宽度。各段都有内置默认值，缺失或解析失败时自动回退。卡片默认标题 `Code Contributions`，尺寸 1200×200。

| 变量 | 用途 | 必需 |
| --- | --- | --- |
| `GH_TOKEN` | 调用 REST API 与克隆仓库 | 是 |
| `EMAILS_TOKEN` | 读取账号邮箱、查询贡献清单，需 `user:email` 权限 | 是 |
| `ORIGIN_USERNAME` | 统计目标账号 | 否，缺省时读 README 头部注释 |

需要 Node.js 20 及以上，无第三方依赖：

```bash
export GH_TOKEN=...
export EMAILS_TOKEN=...
node scripts/generate_stats.js                # 统计
node scripts/generate_stats.js --clear-cache  # 清空缓存
node scripts/generate_stats.js --help
```

**复用到自己的账号。**

1. Fork 本仓库，在 Settings → Pages 把发布来源设为 GitHub Actions。
2. 配置 `EMAILS_TOKEN`，`GH_TOKEN` 由 Actions 注入。
3. 把 README 的卡片链接换成自己的 Pages 地址。站点地址按仓库归属生成，无需改代码。

## 自动化与发布

`update-stats.yml` 每天 23:59（北京时间）触发，也可手动运行。权限 `contents: read`、`pages: write`、`id-token: write`、`actions: write`；并发组 `update-stats` 同时只跑一个实例，新的排队而不取消在跑的；`ubuntu-latest` + Node.js 22，整体超时 40 分钟。

执行顺序：

1. 取仓库所有者作为目标用户名。
2. 从 Actions 缓存恢复 `temp_repos/` 克隆，从 Pages 恢复统计缓存与上次汇总。
3. 运行统计脚本，自身限时 25 分钟。
4. 删除旧克隆缓存条目，保存本次克隆。
5. 打包 `_site/`，上传并部署 Pages。
6. 确认站点已是本次产物后，清掉卡片的 camo 缓存。
7. 写入运行摘要。

单仓库失败不阻断发布：沿用上次缓存并告警，卡片照常部署。只有配额耗尽、整轮跑不下去才非零退出，工作流据此不部署，摘要显示未发布。

打包后若汇总与站点已发布的完全一致，上传、部署、清缓存一并跳过；名单有变化则不跳过，否则新发现的仓库存不下来，摘掉的失效仓库也会回来。

**持久化。** `temp_repos/` 是本地 blobless 克隆，走 Actions 缓存的固定 key `stats-repos`，删了下次重克隆；固定 key 不能覆盖写，保存前先删旧条目。`stats_cache/*.json` 与 `scope/index.json` 发布到 Pages 的 `data/`，工作流从 `data/manifest.json` 逐份读回，失败重试三次。

每次打包把汇总写入 `data/latest.json`，下次直接读回对比，不必解析明细。摘要显示在运行页顶部，含汇总指标、缓存恢复、camo 状态与各阶段耗时。对比一行一个维度，删除记负，与卡片和 `git diff` 一致：

```text
- 提交 +69，新增 +9,077 行 / 删除 -6,259 行
- 最新提交：更新至 2026-11-24T18:24:35+08:00
- 新增仓库：plugin-data、plugin-market
- 移除仓库：pingpong
- 仓库明细：
  - Usagi-wusaqi：提交 +8，新增 +4,187 行 / 删除 -2,914 行，最新提交时间更新
```

`lint.yml` 在 push 到 `main` 与 PR 时跑 `node scripts/lint.js` 和 `node --test`。

### 站点产物

| 路径 | 内容 |
| --- | --- |
| `/` | 索引页，列出卡片与当次发布的所有明细 |
| `/contributions.svg` | 四列指标卡片 |
| `/data/manifest.json` | 当前明细文件清单，打包时生成 |
| `/data/latest.json` | 本次汇总，供下次运行对比 |
| `/data/scope.json` | 统计范围的发现名单，供下次运行兜底 |
| `/data/<repo>.json` | 逐仓库提交明细 |

Pages 固定返回 `Cache-Control: max-age=600`，camo 按该值缓存卡片，缓存地址由 GitHub 的 markdown 端点渲染换出。校验未通过或 `PURGE` 失败就等十分钟自然过期，这期间看过页面的浏览器可能仍是旧图；站点明细不经 camo，访问即最新。

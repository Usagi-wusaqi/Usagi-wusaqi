# 主页与统计卡片

`README.md` 由 GitHub 渲染为个人主页，仓库内其余文件实现一套自建的贡献统计系统：按账号汇总各仓库的提交，生成 SVG 卡片与逐仓库明细，每日经 GitHub Actions 发布到 GitHub Pages。主页只引用一条固定的卡片地址，仓库中不保存统计产物。

除自建卡片外，主页还通过外部服务引用访问计数徽章、装饰图像、随机名言、GitHub 统计卡、活动摘要卡、语言分布与连续提交天数。README 仅负责版式与链接，不保存图片，也不参与计算。

## 特性

- 支持定时与手动两种触发方式，每日更新一次。
- 增量统计：各仓库历史只扫描一次，后续运行仅处理新增提交。
- 采用 blobless 部分克隆（`--filter=blob:none`），避免下载文件内容对象。
- 统计产物与中间数据统一托管在 Pages，主页链接保持不变。
- 部署完成后清除图片代理的缓存，新访客即时取到最新卡片。
- 站点根路径提供索引页，可直接浏览卡片与各仓库明细。
- 提交归属按账号邮箱判定，含 `Co-authored-by` 共同作者。
- 统计范围覆盖有本人提交的公开仓库，不限于账号名下的仓库。
- 仅依赖 Node 内置模块，Fork 后自动适配仓库归属。

## 工作原理

```
GitHub REST API / git log
        ↓ 统计范围、提交元数据、增删行数
scripts/generate_stats.js
        ↓ scripts/stats_cache/<repo>.json + contributions.svg
scripts/pipeline.js site
        ↓ _site/（卡片 + index.html + data/*.json + data/manifest.json）
upload-pages-artifact → deploy-pages → pipeline.js purge
        ↓
GitHub Pages ← README.md 中的固定图片链接
```

流程分四层：API 与本地 git 克隆提供原始数据；`generate_stats.js` 完成提交过滤、指标聚合与 SVG 渲染；`pipeline.js` 负责与站点之间的读写，即读回缓存、打包产物、清除代理缓存与写运行摘要；Pages 对外提供静态访问。卡片内容每日替换，主页无需改动。

## 目录结构

```
.
├── README.md                        # 个人主页，静态文件，人工维护
├── config.toml                      # API、统计范围、SVG 样式与运行参数
├── package.json                     # ESM 声明与检查/测试命令，无第三方依赖
├── scripts/
│   ├── generate_stats.js            # 数据采集、缓存、聚合与 SVG 生成
│   ├── pipeline.js                  # 站点读写：读回缓存、打包产物、清缓存、写摘要
│   └── scripts.test.js              # 配置解析、统计范围合并、卡片与序列化的单元测试
├── .github/workflows/
│   ├── update-stats.yml             # 每日统计与 Pages 部署
│   └── lint.yml                     # 语法检查与单元测试
├── .gitignore                       # 排除运行时产物与各类缓存
├── .gitattributes                   # 统一 LF 行尾，图片按二进制处理
└── CONTRIBUTING.md                  # 仓库说明
```

`generate_stats.js` 按职责分为配置加载、API 客户端、统计范围合并、仓库枚举与 Fork 判定、克隆与提交采集、缓存读写、SVG 生成、并发调度及主流程等模块。`pipeline.js` 提供 `restore`、`site`、`purge`、`summary` 四个子命令，工作流只负责调用，两者都在语法检查与单元测试的覆盖范围内。

## 统计口径

统计范围只统计公开仓库，且只看「我提交过的仓库」，不局限于账号名下的。一次 GraphQL 的 `repositoriesContributedTo` 查询直接给出清单，一页 100 个、游标翻页拿全，返回的每个仓库还带着 fork 与上游关系。查询里带 `includeUserRepositories: true`，名下有自己提交的仓库本来就在其中；一次提交都没有的仓库不进统计，它们对卡片是零贡献。口径按账号归属、只看默认分支，比主页贡献图窄一点——贡献图还数 gh-pages 上的提交，那里放的是页面而不是代码，不计入行数。清单与 `[repos] include` 列出的仓库一起按全名去重后统计，`exclude` 里的仓库按 `owner/name` 精确匹配，无论来自哪个来源都会被剔除。这一步必须用账号本人的令牌（`EMAILS_TOKEN`）：Actions 内置令牌的身份是 bot，查到的 viewer 是它自己，脚本发现登录名与统计目标不一致时整轮放弃，不会拿空名单覆盖缓存。名单每轮都完整查一遍并落盘复用：查到的仓库与 `include` 清单同等待遇，一起克隆、按邮箱过滤、按仓库缓存。查询完整时名单以本轮为准，仓库删除、转私有、失去访问权都会自然退出；查询失败或翻页超过 `[api] max_api_pages` 仍没到底时与上一轮合并、只增不减，已知仓库不会掉队；一条都没查到时（多半是令牌或权限出了问题）直接失败，不拿旧名单静默顶替——否则卡片会长期停在旧数据上，而 CI 一直是绿的。贡献清单本身也会漏：只以共同作者身份参与、或后来被移出协作者的仓库查不到，用 `include` 补上即可。私有仓库无论来自哪个来源都会被剔除，其中的提交也不计入卡片，因此卡片数值只反映公开提交，低于 GitHub 个人主页显示的贡献数属正常。

| 卡片列 | 计算方式 |
| --- | --- |
| `Additions` | 归属提交的新增行数累计 |
| `Deletions` | 归属提交的删除行数累计 |
| `Net` | 前两项之差 |
| `Images` | 状态为 `added` 且扩展名命中 `image_extensions` 的文件数 |

提交归属以 GitHub 账号邮箱集合判定，只比较邮箱，提交者姓名不参与；commit trailer 中的共同作者邮箱同样计入。邮箱通过 `/user/emails` 在运行时获取，仅保存在内存中，不写入配置文件。提交列表与增删行数主要取自 `git log`，本地克隆缺失或 `git log` 无结果时改由 REST API 获取，提交详情亦可由 API 补齐。

缓存按仓库分文件保存，以提交 sha 去重后增量追加（仓库改名后地址会变、sha 不变，改名前的缓存仍能复用，旧地址顺手更新成新的），写入前按时间排序并重建序号。单仓库克隆或分析失败时沿用上次缓存，并照常发布，只是这些仓库的新提交本轮不计入；部分克隆不受支持时回退为全量克隆。统计范围判定不完整时（贡献清单翻页没到底、读不到 fork 关系、配额耗尽），本次不清理范围外的旧缓存，避免一次接口失败把已统计的仓库连数据一起删掉。缓存文件以仓库名为准，不同归属的同名仓库会争用同一个文件，因此后一个会跳过并在日志里注明，避免两者互相覆盖。统计范围的发现结果另存 `scripts/stats_cache/scope/index.json`，随明细一起发布到 `data/scope.json`，下次运行取回后作为兜底；名单里一并记下仓库 ID，仓库改名后缓存靠它接续，不会被当成新仓库重算。它是唯一不按仓库命名的缓存，因此不列入明细清单，也不参与汇总与清理。查询完整时名单以本轮结果为准，查询失败或翻页中断时只并入已找到的部分，已知仓库靠上一轮那份保住，下一轮重新完整查。

## 自动化工作流

`update-stats.yml` 在每日 23:59（北京时间，cron `59 15 * * *` UTC）触发，也支持 `workflow_dispatch` 手动运行。权限为 `contents: read`、`pages: write`、`id-token: write`、`actions: write`；通过 `concurrency: update-stats` 保证同一时间只有一个实例、`cancel-in-progress: false`，运行于 `ubuntu-latest`、Node 22，整体超时 40 分钟。

执行顺序为：确定目标用户名，恢复两类缓存，运行统计脚本（自身 25 分钟超时），打包 `_site/`，上传并部署 Pages，清除卡片在 camo 的缓存，最后写入运行摘要。单个仓库克隆或分析失败不会阻断发布：该仓库沿用上次缓存并打印告警，卡片照常部署。仅当配额耗尽导致整轮无法继续时脚本才以非零码退出，工作流据此不再部署，站点保持上一次发布的内容，摘要也相应显示为未发布。打包后若本次汇总与站点已发布的完全一致，上传、部署与清缓存三步一并跳过，摘要标为无需更新。

两类持久化数据分开处理：`temp_repos/` 是本地 blobless 克隆，走 `actions/cache` 的固定 key `stats-repos`，每次保存前删除旧条目，始终只保留一份；`scripts/stats_cache/*.json` 是提交明细，`scripts/stats_cache/scope/index.json` 是统计范围的发现结果，两者都发布到 Pages 的 `data/` 供直接访问（后者发布为 `data/scope.json`）。工作流从站点的 `data/manifest.json` 逐份读回明细，读取失败会重试三次；站点尚无清单时从空缓存开始全量统计。摘要包含触发方式、汇总指标、缓存恢复结果、camo 状态、各阶段耗时与站点地址，显示在 Actions 运行页顶部。

每次打包时把本次汇总写进 `data/latest.json` 一并发布，下次运行从站点读回，与前一次的汇总直接对比。对比只读这两个算好的数字对象，不再解析历史明细；无变化会明确说明，有变化则列出各项增减量与变化的仓库，同一份比对结果也决定是否需要重新部署。

```
_site/
├── contributions.svg
├── index.html
└── data/
    ├── manifest.json
    ├── latest.json
    └── <repo>.json
```

`lint.yml` 在 push 到 `main` 及 PR 时执行 `node --check` 语法检查与 `node --test` 单元测试。

## 配置

`config.toml` 包含 `[api]`、`[repos]`、`[svg]`、`[svg.layout]`、`[svg.font]`、`[svg.labels]`、`[behavior]` 七段，分别控制 API 分页与配额告警、统计范围（`discover` 是否自动发现、`include` 额外清单（同样只统计公开仓库）、`exclude` 排除名单）、卡片标题与配色、布局坐标、字体、列标签，以及图片扩展名、并发度等运行行为。卡片默认标题为 `Code Contributions`，尺寸 1200×200。脚本内置各段默认值，配置缺失或解析失败时自动回退。

| 变量 | 用途 | 必需 |
| --- | --- | --- |
| `GH_TOKEN` | 调用 REST API 与克隆仓库 | 是 |
| `EMAILS_TOKEN` | 读取账号邮箱，需 `user:email` 权限 | 是 |
| `ORIGIN_USERNAME` | 统计目标账号 | 否，缺省时读 README 头部注释 |

命令行支持 `--clear-cache`（清除本地缓存与仓库克隆副本）和 `-h` / `--help`。

## 站点产物

| 路径 | 内容 |
| --- | --- |
| `/` | 索引页，列出卡片与当次发布的所有明细 |
| `/contributions.svg` | 四列指标卡片 |
| `/data/manifest.json` | 当前明细文件清单，由工作流打包时生成 |
| `/data/<repo>.json` | 逐仓库提交明细 |

每份明细由 `_metadata` 与 `data` 两部分组成。提交记录含 `index`、`timestamp`、`additions`、`deletions`、`images`、`url` 六个字段；`_metadata` 记录该仓库的提交数、增删行数、图片数与最新提交时间，并携带 `repo_id`、`full_name`，用于仓库改名或转让后接续缓存。

## 本地运行

需要 Node 20 及以上（无第三方依赖）与两个令牌：

```bash
export GH_TOKEN=...
export EMAILS_TOKEN=...
node scripts/generate_stats.js
```

生成的 `contributions.svg` 与 `scripts/stats_cache/` 均由 `.gitignore` 排除，不会进入版本管理。

## 复用

1. Fork 本仓库，在 Settings → Pages 中将发布来源设为 GitHub Actions。
2. 配置 `EMAILS_TOKEN`；`GH_TOKEN` 由 Actions 自动注入。
3. 将 README 中的卡片链接替换为自己的 Pages 地址。站点地址由脚本按仓库归属生成，无需改动代码。

## 注意事项

- Pages 首次部署成功之前，主页的卡片链接尚无对应文件。
- Pages 固定返回 `Cache-Control: max-age=600`，且不支持自定义响应头，camo 会按该值缓存。工作流部署完成后先确认站点已是本次产物，再向 camo 发送 `PURGE` 清除这张卡片的缓存，新访客即可取到最新版本；校验未通过或清除失败时，仍按十分钟自然过期。
- 已在此前十分钟内打开过页面的浏览器可能继续使用本地缓存，`PURGE` 只影响 camo 一侧。站点上的明细文件不经 camo，访问即为最近一次发布的结果。

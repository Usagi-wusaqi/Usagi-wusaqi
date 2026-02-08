# GitHub 贡献统计脚本

## 📋 目录

1. [快速开始](#快速开始)
2. [模板系统](#模板系统)
3. [核心特性](#核心特性)
4. [配置说明](#配置说明)
5. [故障排除](#故障排除)

---

## 🚀 快速开始

### Fork 用户（推荐）

1. **Fork 仓库** - 点击右上角 "Fork" 按钮
2. **触发更新**（工作流默认使用 GitHub 内置的 `GITHUB_TOKEN`，无需额外配置）

   > **可选：** 如需统计私有仓库，可在 `Settings > Secrets and variables > Actions` 中创建 PAT（需要 `repo` 权限），用它覆盖 `GITHUB_TOKEN`

   **方式一：推送代码自动触发**
   ```bash
   git add .
   git commit -m "Update content"
   git push
   ```

   **方式二：手动触发**
   - 进入仓库的 `Actions` 标签页
   - 选择 "更新 README 统计数据" 工作流
   - 点击 "Run workflow" 按钮
   - 在弹出的对话框中点击绿色的 "Run workflow" 按钮
   - 等待几分钟，工作流完成后 README.md 会自动更新

   **方式三：定时触发**
   - 已默认配置每周日零点整自动运行 (UTC时间)
   - 无需手动操作，系统会自动更新统计数据
   - 工作流可以配置为定时运行（如每天或每周）
   - 在 `.github/workflows/` 中的 YAML 文件里添加 `schedule` 触发器：
   ```yaml
   on:
     push:
       branches: [ main, master ]
     workflow_dispatch:
     schedule:
       - cron: '0 0 * * 0'  # 默认每周日零点整触发 (UTC时间)
   ```

### 本地运行

```bash
export GH_TOKEN="your-github-token"
python scripts/generate-stats.py

# 可选参数
python scripts/generate-stats.py --no-images    # 不统计图片
python scripts/generate-stats.py --clear-cache  # 清除缓存后直接退出（不会重新生成统计）
```

---

## 🎯 模板系统

### 工作原理

使用智能模板系统解决"占位符一次性替换"问题：

1. **模板文件** (`README.template.md`) - 包含占位符的源文件
2. **脚本运行** - 从模板生成完整 README，替换所有占位符
3. **生成结果** (`README.md`) - 包含真实数据的最终文件

### 解决的核心问题

#### 传统方式的问题
- ❌ **一次性替换**：`{{ORIGIN_USERNAME}}` → `your-username`，下次运行找不到占位符
- ❌ **维护困难**：每个链接都要手动修改用户名
- ❌ **服务不兼容**：GitHub stats 看到占位符无法识别

#### 模板系统的优势
- ✅ **可重复运行**：每次从模板开始，永远有占位符可替换
- ✅ **维护简单**：只需在模板中使用占位符，自动替换所有位置
- ✅ **服务兼容**：生成真实链接，GitHub stats 正常工作

### 支持的占位符

| 占位符 | 说明 | 示例 |
| ------ | ---- | ---- |
| `{{ORIGIN_USERNAME}}` | 远端用户名 | `your-username` |
| `{{UPSTREAM_USERNAME}}` | 上游用户名 | `upstream-username` |
| `{{TOTAL_ADDITIONS}}` | 总增加行数 | `15316` |
| `{{TOTAL_DELETIONS}}` | 总删除行数 | `4231` |
| `{{TOTAL_IMAGES}}` | 总图片数量 | `109` |
| `{{LAST_UPDATED}}` | 最后更新时间 | `2026-01-28 15:30:45 UTC+8` |

### 使用示例

**模板文件内容：**
```markdown
# {{ORIGIN_USERNAME}} 的项目

![Stats](https://github-readme-stats.vercel.app/api?username={{ORIGIN_USERNAME}})

统计数据：➕additions: {{TOTAL_ADDITIONS}} ➖deletions: {{TOTAL_DELETIONS}}

最后更新：{{LAST_UPDATED}}
```

**生成的结果：**
```markdown
# your-username 的项目

![Stats](https://github-readme-stats.vercel.app/api?username=your-username)

统计数据：➕additions: 15316 ➖deletions: 4231

最后更新：2026-01-28 15:30:45 UTC+8
```

---

## ⭐ 核心特性

### 🚀 自动化与智能化
- **GitHub Actions 集成** - 推送代码或手动触发自动更新
- **智能缓存系统** - 95%+ 缓存命中率，显著提升运行速度
- **增量更新** - 只处理新增的 commits，避免重复分析
- **智能清理** - 检测变基操作，只删除消失的 commits
- **智能跳过** - 统计数据未变化时不更新 README，避免无意义的提交

### 📊 全面的数据统计
- **代码贡献** - 统计所有仓库的代码增删行数
- **图片资源** - 统计图片文件（.png, .jpg, .jpeg, .gif, .svg, .webp, .ico, .bmp）
- **Git log 优先** - 优先使用本地 git log（完整历史），API 仅在失败时兜底
- **实时更新** - 自动更新 README 中的统计数字和时间戳

### 🍴 Fork 友好设计
- **自动检测** - 智能识别 Fork 仓库，分析上游仓库而不是 Fork 本身
- **用户名管理** - 通过占位符系统，任何人 Fork 后都能正常使用
- **独立缓存** - 每个用户有自己的缓存文件，互不干扰
- **上游创建者保留** - 在"Made with ❤️ by"部分保留上游创建者信息

### 🔧 技术优势
- **零依赖** - 只使用 Python 标准库，无需额外安装
- **容错性强** - git log 失败时自动降级使用 API 兜底
- **格式保持** - 精确替换统计数字，完全保持 README 原有格式
- **向后兼容** - 支持新旧缓存格式自动转换

---

## 🔧 配置说明

### 环境变量

| 变量名 | 必需 | 默认值 | 说明 |
| ------ | ---- | ------ | ---- |
| `GH_TOKEN` | ✅ | 内置 `GITHUB_TOKEN` | GitHub Token（默认使用内置 token，如需统计私有仓库可配置 PAT） |
| `ORIGIN_USERNAME` | ❌ | 自动检测 | 远端用户名 |
| `UPSTREAM_USERNAME` | ❌ | 自动检测 | 上游用户名 |

### GitHub Actions 自动设置

在 GitHub Actions 环境中，工作流会通过 GitHub API 自动检测仓库类型并设置变量：

```yaml
env:
  GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  ORIGIN_USERNAME: ${{ steps.determine-users.outputs.ORIGIN_USERNAME }}
  UPSTREAM_USERNAME: ${{ steps.determine-users.outputs.UPSTREAM_USERNAME }}
```

### 变量用途说明

**ORIGIN_USERNAME（远端用户名）：**
- Fork 仓库时：Fork 仓库（当前 Fork 的所有者）
- 非 Fork 仓库时：和 UPSTREAM_USERNAME 一样（当前仓库所有者）
- 用于 GitHub API 调用（获取仓库列表、commit 数据等）
- 用于 GitHub Stats API（统计图表、语言分布等）

**UPSTREAM_USERNAME（上游用户名）：**
- 始终是上游用户名
- Fork 仓库时：指向上游用户名
- 非 Fork 仓库时：指向远端用户名
- 用于"Made with ❤️ by"部分的作者链接

**变量关系总结：**

| 仓库类型 | ORIGIN_USERNAME | UPSTREAM_USERNAME |
|---------|---------------|------------------|
| Fork 仓库 | 远端用户名（当前 Fork 的所有者） | 上游用户名 |
| 非 Fork 仓库 | 远端用户名 | 远端用户名 |

脚本会按以下优先级初始化变量：

**ORIGIN_USERNAME 优先级：**
1. 环境变量 `ORIGIN_USERNAME`
2. 从 README.md 读取 `ORIGIN_USERNAME = xxx`
3. 空字符串（需要手动设置）

**UPSTREAM_USERNAME 优先级：**
1. 环境变量 `UPSTREAM_USERNAME`
2. 从 README.md 读取 `UPSTREAM_USERNAME = xxx`
3. 空字符串（需要手动设置）

**注意：** 在 GitHub Actions 中，这两个变量会根据仓库类型自动设置。

### Fork 行为详解

当有人 Fork 仓库并运行工作流时：

- ✅ **ORIGIN_USERNAME = 远端用户名** - 统计远端仓库的贡献
- ✅ **UPSTREAM_USERNAME = 上游用户名** - 在"Made by"中显示上游作者
- ✅ **动态替换占位符** - 运行时将占位符替换为实际用户名
- ✅ **独立缓存文件** - 每个用户有自己的缓存，互不干扰
- ✅ **可重复运行** - 不会出现占位符消失问题

### 模板系统工作流程

1. **检测模板** - 脚本首先检查是否存在 `README.template.md`
2. **从模板生成** - 如果存在模板，从模板开始生成完整的 README
3. **替换所有占位符** - 将所有占位符替换为实际值
4. **生成最终 README** - 写入 `README.md`，包含真实数据

### 性能表现

| 场景 | 预期时间 | 说明 |
| ---- | -------- | ---- |
| 首次运行 | 2-10 分钟 | 取决于仓库数量和 commit 历史 |
| 日常更新 | 30-60 秒 | 95%+ 缓存命中率 |
| 清除缓存后 | 2-10 分钟 | 需要重新分析所有数据 |
| API 限流时 | 无明显影响 | 主要使用 git log，API 仅兜底 |

---

## 🔬 技术原理

### 工作流程

```text
1. 初始化 → 2. 获取仓库列表 → 3. 处理每个仓库 → 4. 变化检测 → 5. 更新 README → 6. 清理
   ↓              ↓                ↓               ↓              ↓            ↓
环境变量配置    GitHub API      智能缓存+分析    比较新旧数据    正则替换     临时文件清理
```

### 智能跳过

- 更新 README 前会先从现有 README 提取当前统计数字
- 如果 additions、deletions、images 三个数字都未变化，跳过 README 更新
- 避免仅因时间戳变化而产生无意义的提交

### 数据源策略

- **本地 git log（优先）** - 完整历史数据，准确可靠
- **GitHub API（兜底）** - 仅在 git log 失败时使用（有分页限制，最多 1000 条）
- **无合并逻辑** - 两个数据源只取其一，git log 优先，API 仅作回退方案

### 缓存机制

- **增量处理** - 只分析新增的 commits，避免重复分析
- **智能清理** - 检测变基操作，只删除消失的 commits
- **永久保存** - 保留比当前最老 commit 更久远的历史数据
- **格式兼容** - 自动处理新旧缓存格式转换

### 作者身份管理

- **自动学习** - 从 GitHub API 自动学习用户的所有提交身份（Name + Email）
- **防冒充** - git log 匹配时使用完整的 `Name <email>` 格式，防止同名冒充
- **持久化存储** - 以 Base64 编码保存到 `stats_cache/author_identities.json`
- **增量更新** - 每次处理仓库时增量学习新身份，支持用户改名场景
- **旧格式兼容** - 自动从纯 JSON 格式迁移到 Base64 格式

### Fork 处理逻辑

1. **检测 Fork** - 通过 `fork` 字段和 `source`/`parent` 信息
2. **获取上游** - 提取上游仓库的 owner 和 name
3. **切换目标** - 分析上游仓库而不是 Fork 本身
4. **保持归属** - 统计数据仍归属于当前用户

### 提交作者确定逻辑

工作流会根据不同的触发方式确定提交作者：

1. **定时任务** - 只有 GitHub Actions 作为作者
2. **手动触发** - GitHub Actions + 触发者（使用隐私邮箱）
3. **Push 事件** - 只有 GitHub Actions 作为作者

---

## 🐛 故障排除

### 常见问题速查

**Q: 统计没有更新？**
- 检查 GitHub Actions 是否成功运行
- 确认 `GH_TOKEN` 设置正确
- 查看 Actions 日志中的错误信息

**Q: 统计数据不准确？**
- 首次运行需要几分钟分析历史数据
- Fork 仓库会自动分析上游仓库
- 可以手动触发工作流重新统计

**Q: 脚本运行失败？**
- 检查 token 权限是否足够（如使用 PAT，需要 `repo` 权限）
- 确认网络连接正常
- 查看详细错误日志

### 详细问题解决

#### 脚本运行很慢

**可能原因：**
- 首次运行需要分析所有历史 commits
- 缓存文件被删除或损坏
- 网络连接慢，API 调用超时

**解决方法：**
```bash
# 检查缓存文件状态
ls -la scripts/stats_cache/

# 查看缓存统计信息（会显示缓存命中率）
python scripts/generate-stats.py

# 首次运行耐心等待，后续会很快（95%+ 缓存命中率）
```

#### GitHub API 调用失败

**可能原因：**
- `GH_TOKEN` 无效、过期或权限不足
- 网络连接问题或防火墙阻拦
- GitHub API 限流（每小时 5000 次调用）

**解决方法：**
```bash
# 检查 TOKEN 有效性
curl -H "Authorization: token $GH_TOKEN" https://api.github.com/user

# 检查 API 限流状态
curl -H "Authorization: token $GH_TOKEN" https://api.github.com/rate_limit

# 脚本主要使用 git log，API 仅为兜底，影响有限
```

#### Fork 后如何使用

**使用步骤：**
1. **Fork 仓库**到你的账户
2. **触发工作流**：推送代码或手动触发 GitHub Actions（默认使用内置 `GITHUB_TOKEN`）
3. **自动更新**：脚本会自动更新为你的统计数据
4. **可选**：如需统计私有仓库，在仓库 `Settings > Secrets` 中配置 PAT 覆盖 `GITHUB_TOKEN`

**预期行为：**
- ✅ 模板系统：从 `README.template.md` 生成完整的 README
- ✅ 占位符替换：所有占位符替换为实际值
- ✅ 可重复运行：每次都从干净的模板开始，永不出错
- ✅ 统计服务兼容：生成的链接包含真实用户名
- ✅ 独立缓存：生成你自己的缓存文件

### 调试方法

```bash
# 查看详细输出
python scripts/generate-stats.py

# 清除缓存（仅清除，不会重新运行统计）
python scripts/generate-stats.py --clear-cache

# 清除缓存后重新运行（需要两条命令）
python scripts/generate-stats.py --clear-cache && python scripts/generate-stats.py

# 只统计代码，不统计图片
python scripts/generate-stats.py --no-images

# 显示帮助信息
python scripts/generate-stats.py --help
```

### 支持的图片格式

**支持的格式：**
- 常见格式：`.png`, `.jpg`, `.jpeg`, `.gif`
- 矢量格式：`.svg`
- 其他格式：`.bmp`, `.webp`, `.ico`

**统计规则：**
- 只统计**新增**的图片文件（status = 'added'）
- 不统计修改或删除的图片
- 通过文件扩展名判断（不区分大小写）

### 获取帮助

- 在 Issues 中提问
- 查看 GitHub Actions 运行日志
- 检查环境变量和权限配置

---

## 📄 许可证

本项目采用 [MIT License](LICENSE) 开源协议。

**你可以：**
- ✅ 商业使用、修改代码、分发代码、私人使用

**要求：**
- 📋 保留原始的版权声明和许可证文本

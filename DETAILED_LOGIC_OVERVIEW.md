# GitHub 贡献统计脚本 - 详细说明

## 📋 目录

1. [快速开始](#快速开始)
2. [核心特性](#核心特性)
3. [输出说明](#输出说明)
4. [工作原理](#工作原理)
5. [性能优化](#性能优化)
6. [常见问题](#常见问题)

---

## 🚀 快速开始

### 基本使用
```bash
# 设置环境变量
export USERNAME="your-username"
export GH_TOKEN="your-github-token"

# 运行脚本
python scripts/generate-stats.py

# 可选参数
python scripts/generate-stats.py --no-images    # 不统计图片
python scripts/generate-stats.py --clear-cache  # 清除缓存
```

### 输出结果
- 更新 README.md 中的统计数字
- 更新 README.md 右下角的时间戳
- 生成/更新缓存文件到 `scripts/stats_cache/`

---

## ⭐ 核心特性

### 1. 智能缓存系统
- **高效率**：缓存命中率通常 95%+
- **智能清理**：只删除被变基的 commits，保留历史数据
- **增量更新**：只处理新增的 commits

### 2. 双数据源策略
- **git log**：本地完整历史（可能不是最新）
- **GitHub API**：远程最新数据（最多 1000 个 commits）
- **智能合并**：自动选择最新的数据

### 3. Fork 仓库支持
- 自动检测 Fork 仓库
- 分析上游仓库而不是 Fork 本身
- 正确统计对原项目的贡献

### 4. 格式保持
- 使用正则表达式精确替换数字
- 完全保持 README.md 原有格式
- 不会破坏 HTML 结构或样式

---

## 📊 输出说明

### README.md 更新内容
脚本会自动更新 README.md 中的两个地方：

1. **统计数字**：`➕additions: 0 ➖deletions: 0 🖼️images: 0`
2. **更新时间**：`Last updated: 2026-01-09 17:30:00 UTC+8`（右下角）

### 缓存文件
- **位置**：`scripts/stats_cache/{repo_name}.json`
- **内容**：每个仓库的 commit 贡献数据
- **作用**：避免重复分析，大幅提升性能

### 统计规则
- **代码行数**：统计所有文件的增删行数
- **图片统计**：只统计新增图片（.png, .jpg, .gif, .svg 等）
- **Fork 仓库**：自动分析上游仓库而不是 Fork 本身

---

## ⚙️ 工作原理

### 执行流程
```
1. 获取仓库列表 (GitHub API)
   ↓
2. 处理每个仓库
   ├─ 克隆/更新本地仓库
   ├─ 检查是否为 Fork
   └─ 分析 commits
       ├─ 加载缓存
       ├─ 获取 git log commits
       ├─ 获取 API commits
       ├─ 合并数据源
       ├─ 清理过期缓存
       ├─ 处理新 commits
       └─ 保存缓存
   ↓
3. 更新 README.md
   ├─ 替换统计数字
   └─ 替换更新时间
```

### 数据合并策略
当 git log 和 API 都有相同 commit 时：
- 比较时间戳
- 使用较新的数据
- 时间戳相同时优先使用 git log

### 缓存清理逻辑
- **保留**：比当前最老数据更久远的 commits（永久历史）
- **删除**：在当前数据范围内消失的 commits（被变基）

---

## 💾 性能优化

### 缓存机制
- **第一次运行**：需要分析所有历史 commits（较慢）
- **后续运行**：95%+ 缓存命中率（很快）
- **智能清理**：自动保留历史数据，删除过期缓存

### 性能表现
```
第一次运行：可能需要几分钟（取决于仓库数量和 commit 数）
第二次运行：通常 30 秒内完成
长期使用：每次运行越来越快
```

### 优化建议
- 保持缓存文件完整，不要手动删除
- 定期运行脚本，避免积累太多新 commits
- 网络良好时运行，减少 API 调用失败

---

## ❓ 常见问题

### Q1：脚本运行很慢怎么办？
**可能原因**：
- 第一次运行需要分析所有历史 commits
- 缓存文件被删除，需要重新分析
- 网络连接慢，API 调用超时

**解决方法**：
```bash
# 检查缓存文件是否存在
ls -la scripts/stats_cache/

# 第一次运行耐心等待，后续会很快（95%+ 缓存命中率）
python scripts/generate-stats.py
```

### Q2：GitHub API 调用失败
**可能原因**：
- TOKEN 无效或过期
- 网络连接问题
- GitHub API 限流（每小时 5000 次）

**解决方法**：
```bash
# 检查 TOKEN 是否有效
echo $GH_TOKEN
curl -H "Authorization: token $GH_TOKEN" https://api.github.com/user

# 等待限流恢复或使用 git log 降级模式
```

### Q3：统计数据与预期不符
**可能原因**：
- Fork 仓库统计了 Fork 而不是上游
- 缓存数据过期或损坏
- 某些 commits 被变基或删除

**解决方法**：
```bash
# 清除缓存重新统计
python scripts/generate-stats.py --clear-cache
python scripts/generate-stats.py

# 检查是否正确处理了 Fork 仓库
```

### Q4：README.md 没有更新
**可能原因**：
- README.md 格式与脚本期望的不匹配
- 正则表达式匹配失败
- 文件权限问题

**解决方法**：
- 确保 README.md 包含：`➕additions: 数字 ➖deletions: 数字 🖼️images: 数字`
- 确保包含：`Last updated: YYYY-MM-DD HH:MM:SS UTC+8`
- 检查文件是否可写

### Q5：如何提高脚本性能？
**优化建议**：
- 保持缓存文件完整（不要手动删除）
- 定期运行脚本，避免积累太多新 commits
- 网络良好时运行，减少 API 调用失败
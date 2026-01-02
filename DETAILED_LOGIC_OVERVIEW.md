# GitHub 贡献统计脚本 - 详细逻辑说明

## � 完目录

1. [总体流程](#总体流程)
2. [核心架构](#核心架构)
3. [缓存管理系统](#缓存管理系统)
4. [数据源合并策略](#数据源合并策略)
5. [缓存清理策略](#缓存清理策略)
6. [Commits 分析流程](#commits-分析流程)
7. [Fork 仓库处理](#fork-仓库处理)
8. [工作流程图](#工作流程图)
9. [快速参考](#快速参考)
10. [常见问题](#常见问题)

---

## 总体流程

### 执行流程图

```
主函数 main()
    ↓
获取仓库列表 (get_repos)
    ↓
处理每个仓库 (process_repos)
    ├─ 克隆/更新仓库
    ├─ 检查是否为 Fork（获取上游仓库）
    ├─ 分析 commits (analyze_commits)
    │   ├─ 加载缓存
    │   ├─ 获取 git log commits
    │   ├─ 获取 API commits
    │   ├─ 合并两个数据源
    │   ├─ 清理过期缓存
    │   ├─ 处理每个 commit
    │   │   ├─ 检查缓存命中
    │   │   ├─ 获取 commit 详情
    │   │   ├─ 统计代码行数和图片
    │   │   └─ 更新缓存
    │   └─ 保存缓存
    └─ 累加统计数据
    ↓
更新 README.md
    ↓
完成
```

---

## 核心架构

### 分层设计

```
┌─────────────────────────────────────────────────────────┐
│                    应用层                                │
│              (main, process_repos)                       │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│                    业务层                                │
│  (analyze_commits, merge_commits, clean_stale_cache)    │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│                    数据层                                │
│  (load_cache, save_cache, get_commits_from_*)           │
└────────────────────┬────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────┐
│                    外部接口                              │
│  (GitHub API, Git, 文件系统)                            │
└─────────────────────────────────────────────────────────┘
```

### 模块划分

```
generate-stats.py
├── 配置模块
│   ├── GITHUB_API
│   ├── USERNAME
│   ├── TOKEN
│   └── CACHE_DIR
│
├── 工具模块
│   ├── Colors（颜色定义）
│   ├── print_color（彩色输出）
│   └── run_command（命令执行）
│
├── 缓存模块
│   ├── load_cache（加载）
│   ├── save_cache（保存）
│   └── clean_stale_cache（清理）
│
├── API 模块
│   ├── get_repos（获取仓库）
│   └── get_upstream_repo（获取上游）
│
├── 数据获取模块
│   ├── get_commits_from_git_log（git log）
│   ├── get_commits_from_api（API）
│   └── merge_commits（合并）
│
├── 分析模块
│   └── analyze_commits（分析）
│
├── 处理模块
│   ├── process_repos（处理仓库）
│   └── update_readme（更新 README）
│
└── 主模块
    └── main（主函数）
```

---

## 缓存管理系统

### 缓存结构

```json
{
  "_metadata": {
    "last_updated": "2026-01-02T10:30:00.000000",
    "total_commits": 150
  },
  "data": {
    "repo_name": [
      {
        "index": 1,
        "url": "https://github.com/owner/repo_name/commit/abc123def456",
        "additions": 100,
        "deletions": 50,
        "images": 2,
        "timestamp": "2023-12-01T15:30:00Z"
      },
      {
        "index": 2,
        "url": "https://github.com/owner/repo_name/commit/def456ghi789",
        "additions": 200,
        "deletions": 30,
        "images": 0,
        "timestamp": "2023-11-15T10:20:00Z"
      }
    ]
  }
}
```

**缓存字段说明：**
- `index`: 这是第几个 commit（用于快速定位）
- `url`: commit 的完整 GitHub 链接（可直接点击查看）
- `additions`: 代码增加行数
- `deletions`: 代码删除行数
- `images`: 该 commit 中新增的图片数量（仅统计数量，不保存文件名）
- `timestamp`: commit 提交的时间戳（ISO 8601 格式）

### 缓存加载 (load_cache)

```python
def load_cache(repo_name):
    # 1. 创建缓存目录
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    # 2. 读取缓存文件
    cache_file = CACHE_DIR / f"{repo_name}.json"

    # 3. 处理新旧格式兼容
    if '_metadata' in cache_data:
        return cache_data.get('data', {})  # 新格式
    else:
        return cache_data  # 旧格式
```

**返回格式：**
```python
{
    "repo_name": [
        {"index": 1, "url": "...", "additions": 100, ...},
        {"index": 2, "url": "...", "additions": 200, ...}
    ]
}
```

### 缓存保存 (save_cache)

```python
def save_cache(repo_name, cache_data):
    # 1. 对每个仓库的 commits 按时间戳排序（从旧到新）
    sorted_cache_data = {}
    total_commits = 0

    for repo_name, commits in cache_data.items():
        if isinstance(commits, list):
            # 按 timestamp 从旧到新排序（老的在前，新的在后）
            sorted_commits = sorted(commits, key=lambda x: x.get('timestamp', ''))

            # 重新编号 index（从 1 开始）
            for idx, commit in enumerate(sorted_commits, start=1):
                commit['index'] = idx

            sorted_cache_data[repo_name] = sorted_commits
            total_commits += len(sorted_commits)

    # 2. 添加元数据
    cache_data_with_metadata = {
        '_metadata': {
            'last_updated': datetime.now().isoformat(),
            'total_commits': total_commits
        },
        'data': sorted_cache_data
    }

    # 3. 保存到文件
    with open(cache_file, 'w') as f:
        json.dump(cache_data_with_metadata, f, indent=2)
```

**排序和编号说明：**
- 按 `timestamp` 从旧到新排序（老的 commits 在前）
- 重新编号 `index`：从 1 开始，按顺序递增
- 老的 commits 有小的 index，新的 commits 有大的 index

**排序示例：**
```python
# 排序前（随机顺序）
[
    {"index": 1, "timestamp": "2025-12-14T16:20:02Z", ...},
    {"index": 3, "timestamp": "2025-12-14T07:07:52Z", ...},
    {"index": 2, "timestamp": "2025-12-07T14:57:07Z", ...}
]

# 排序后（从旧到新，重新编号）
[
    {"index": 1, "timestamp": "2025-09-01T09:14:35Z", ...},  # 最旧
    {"index": 2, "timestamp": "2025-09-26T13:55:19Z", ...},
    {"index": 3, "timestamp": "2025-09-27T15:28:36Z", ...},
    {"index": 4, "timestamp": "2025-09-28T15:59:34Z", ...},
    {"index": 5, "timestamp": "2025-12-07T14:57:07Z", ...},
    {"index": 6, "timestamp": "2025-12-14T07:07:52Z", ...},
    {"index": 7, "timestamp": "2025-12-14T16:20:02Z", ...}   # 最新
]
```

**保存格式：**
```json
{
    "_metadata": {
        "last_updated": "2026-01-02T...",
        "total_commits": 7
    },
    "data": {
        "repo_name": [
            {"index": 1, "url": "...", "timestamp": "2025-09-01T...", ...},
            {"index": 2, "url": "...", "timestamp": "2025-09-26T...", ...},
            {"index": 3, "url": "...", "timestamp": "2025-09-27T...", ...},
            {"index": 4, "url": "...", "timestamp": "2025-09-28T...", ...},
            {"index": 5, "url": "...", "timestamp": "2025-12-07T...", ...},
            {"index": 6, "url": "...", "timestamp": "2025-12-14T...", ...},
            {"index": 7, "url": "...", "timestamp": "2025-12-14T...", ...}
        ]
    }
}
```
    }
}
```

---

## 数据源合并策略

### 两个数据源

| 数据源 | 范围 | 优点 | 缺点 |
|------|------|------|------|
| git log | 完整历史 | 完整、包含老数据 | 可能不是最新 |
| GitHub API | 最近 10 页 | 最新数据 | 只有最近数据 |

### 合并流程 (merge_commits)

**第一步：分类**
```
git log commits: [A, B, C, D, E]
API commits:    [C, D, E, F, G]

相同 commits:   {C, D, E}
仅在 git log:   {A, B}
仅在 API:       {F, G}
```

**第二步：处理相同 commits**
```python
for sha in common_shas:
    git_commit = git_map[sha]
    api_commit = api_map[sha]

    git_time = git_commit.get('commit', {}).get('author', {}).get('date', '')
    api_time = api_commit.get('commit', {}).get('author', {}).get('date', '')

    # 比较时间戳，谁的新用谁的
    if api_time > git_time:
        # API 数据更新（API 时间戳 > git log 时间戳）
        merged[sha] = api_commit
    else:
        # git log 数据更新或时间戳相同
        # 包括两种情况：
        # 1. git_time > api_time：git log 更新
        # 2. git_time == api_time：时间戳相同，默认使用 git log
        merged[sha] = git_commit
```

**第三步：保留独有数据**
```python
# 保留 git log 独有的 commits（老数据）
for sha in git_only_shas:
    merged[sha] = git_map[sha]

# 保留 API 独有的 commits（新数据）
for sha in api_only_shas:
    merged[sha] = api_map[sha]
```

**最终结果**
```
合并后 commits = git log 老数据 + API 新数据 + 最新更新
```

### 处理场景

**场景 1：本地仓库过期**
```
git log: 500 commits（3 个月前同步）
API: 1000 commits（包含最近 3 个月的新 commits）

合并结果：
  相同 commits: 500 个
  比较时间戳 → 使用 API 的新数据
  最终: 1000 commits（最新）
```

**场景 2：API 限流**
```
git log: 500 commits（最新）
API: 返回失败或不完整

合并结果：
  仅使用 git log: 500 commits
  缓存中的老数据保留
  最终: 500 + 永久历史 commits
```

---

## 缓存清理策略

### 问题背景

- 本地 git log 不一定完整到非常久以前
- API 只有最近 10 页
- commits 可能被变基、压缩或重写

### 清理流程 (clean_stale_cache)

**第一步：获取当前数据范围**
```python
current_commit_set = set()
oldest_current_time = None

for commit in current_commits_with_data:
    sha = commit.get('sha')
    current_commit_set.add(sha)

    # 找出最老的 commit 时间戳
    commit_time = commit.get('commit', {}).get('author', {}).get('date', '')
    if commit_time < oldest_current_time:
        oldest_current_time = commit_time
```

**第二步：从缓存数组中提取 sha**
```python
# 新格式：数组结构
if isinstance(cache_data[repo_key], list):
    cached_shas = set()
    for item in cache_data[repo_key]:
        url = item.get('url', '')
        if url:
            sha = url.split('/')[-1]  # 从 URL 末尾提取 sha
            cached_shas.add(sha)
else:
    # 旧格式：对象结构
    cached_shas = set(cache_data[repo_key].keys())
```

**提取 sha 的详细过程：**

URL 格式：
```
https://github.com/owner/repo_name/commit/abc123def456ghi789
```

提取步骤：
```python
url = "https://github.com/owner/repo_name/commit/abc123def456ghi789"

# 第一步：用 '/' 分割
parts = url.split('/')
# 结果：['https:', '', 'github.com', 'owner', 'repo_name', 'commit', 'abc123def456ghi789']

# 第二步：取最后一个元素
sha = parts[-1]
# 结果：'abc123def456ghi789'

# 或者一行代码：
sha = url.split('/')[-1]
```

**为什么这样做？**
- URL 的最后一个 `/` 后面就是 commit sha
- `split('/')` 将 URL 分成多个部分
- `[-1]` 取最后一个部分，就是 sha

**第三步：找出消失的 commits**
```python
stale_commits = cached_shas - current_commit_set
```

**第四步：智能判断是否删除**
```python
if isinstance(cache_data[repo_key], list):
    # 新格式：过滤数组
    new_cache_list = []
    for item in cache_data[repo_key]:
        url = item.get('url', '')
        sha = url.split('/')[-1] if url else ''
        cached_commit_time = item.get('timestamp', '')

        if sha in stale_commits:
            # 如果缓存的 commit 时间比当前最老的还要老，就保留（永久历史）
            if oldest_current_time and cached_commit_time < oldest_current_time:
                new_cache_list.append(item)  # 保留
            # 否则删除（被变基）
        else:
            new_cache_list.append(item)  # 保留

    cache_data[repo_key] = new_cache_list
```

### 示例

```
缓存中有：
  - 2021-01-01 的 commit（5 年前）
  - 2023-06-01 的 commit（被变基删除）

当前合并数据最老时间：2023-01-01

判断结果：
  - 2021-01-01 的 commit < 2023-01-01 → 保留（永久历史）
  - 2023-06-01 的 commit >= 2023-01-01 → 删除（被变基）
```

---

## Commits 分析流程

### 第一步：加载缓存
```python
cache_data = load_cache(repo_name)
# 返回 {repo_name: {sha: {...}}}
```

### 第二步：获取 commits
```python
git_commits = get_commits_from_git_log(...)  # 本地完整历史
api_commits = get_commits_from_api(...)      # 远程最近 10 页
all_commits = merge_commits(git_commits, api_commits)  # 合并
```

### 第三步：清理过期缓存
```python
cache_data = clean_stale_cache(cache_data, all_commits, repo_name)
# 删除被变基的 commits，保留永久历史
```

### 第四步：处理每个 commit

**缓存命中**
```python
# 构建 commit URL
commit_url = f"https://github.com/{owner}/{repo_name}/commit/{sha}"

# 在缓存数组中查找
cached_data = None
if repo_name in cache_data and isinstance(cache_data[repo_name], list):
    for item in cache_data[repo_name]:
        if item.get('url') == commit_url:
            cached_data = item
            break

if cached_data:
    # 直接使用缓存数据
    total_additions += cached_data['additions']
    total_deletions += cached_data['deletions']
    total_image_count += cached_data['images']  # 直接加上数字
    cache_hits += 1
    continue  # 跳过后续处理
```

**缓存未命中**
```python
# 获取 commit 详情
if repo_path:
    # 本地仓库：使用 git show --numstat
    git_cmd = f'git show --numstat {sha}'
else:
    # 远程仓库：使用 GitHub API
    commit_url = f"{GITHUB_API}/repos/{owner}/{repo_name}/commits/{sha}"

# 解析文件信息
for file in commit_data['files']:
    # 统计代码行数
    additions += file['additions']
    deletions += file['deletions']

    # 统计图片（仅 added 状态，只计数）
    if file['status'] == 'added' and is_image_file(file['filename']):
        commit_image_count += 1

# 获取 commit 的时间戳（用于缓存清理时的永久历史判断）
commit_timestamp = commit.get('commit', {}).get('author', {}).get('date', '')

# 更新缓存（数组结构）
if repo_name not in cache_data:
    cache_data[repo_name] = []
cache_data[repo_name].append({
    'index': processed,  # 第几个 commit
    'url': commit_url,  # commit 链接
    'additions': additions,
    'deletions': deletions,
    'images': commit_image_count,  # 只保存数量
    'timestamp': commit_timestamp  # 使用 commit 的时间戳
})
```

### 第五步：保存缓存
```python
save_cache(repo_name, cache_data)
# 保存到 stats_cache/{repo_name}.json
```

---

## Fork 仓库处理

### 检测 Fork
```python
if repo.get('fork'):
    # 这是一个 Fork 仓库
    upstream_owner, upstream_name = get_upstream_repo(repo)
```

### 获取上游仓库
```python
def get_upstream_repo(repo):
    if not repo.get('fork'):
        return None, None

    upstream_info = repo.get('source') or repo.get('parent') or {}
    if upstream_info:
        upstream_owner = upstream_info.get('owner', {}).get('login')
        upstream_name = upstream_info.get('name')
        if upstream_owner and upstream_name:
            return upstream_owner, upstream_name
    return None, None
```

### 分析上游而不是 Fork
```python
# Fork 仓库的贡献应该统计到上游仓库
owner = upstream_owner
target_repo_name = upstream_name

analyze_commits(repo_path, owner, target_repo_name, ...)
```

---

## 工作流程图

### analyze_commits 详细流程

```
┌──────────────────────────────────────────────────────────┐
│              analyze_commits(repo_path, owner, repo_name) │
└────────────────────┬─────────────────────────────────────┘
                     │
                ┌────────▼────────┐
                │  加载缓存       │
                │ (load_cache)    │
                └────────┬────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
        ▼                ▼                ▼
   ┌─────────┐      ┌─────────┐      ┌─────────┐
   │ git log │      │  API    │      │ 缓存    │
   │ commits │      │ commits │      │ 数据    │
   └────┬────┘      └────┬────┘      └────┬────┘
        │                │                │
        └────────────────┼────────────────┘
                         │
                ┌────────▼────────────────┐
                │  合并数据源             │
                │ (merge_commits)         │
                └────────┬────────────────┘
                         │
                ┌────────▼────────────────┐
                │  清理过期缓存           │
                │ (clean_stale_cache)     │
                └────────┬────────────────┘
                         │
                ┌────────▼────────────────┐
                │  遍历每个 commit        │
                └────────┬────────────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
        ▼                ▼                ▼
   ┌─────────┐      ┌─────────┐      ┌─────────┐
   │缓存命中 │      │缓存未命中│      │处理完成 │
   │直接用  │      │获取详情 │      │统计结果 │
   │缓存    │      │分析数据 │      │        │
   └────┬────┘      └────┬────┘      └────┬────┘
        │                │                │
        └────────────────┼────────────────┘
                         │
                ┌────────▼────────────────┐
                │  保存缓存               │
                │ (save_cache)            │
                └────────┬────────────────┘
                         │
                ┌────────▼────────────────┐
                │  返回统计结果           │
                │ (additions, deletions,  │
                │  image_count)           │
                └────────────────────────┘
```

### 缓存命中流程

```
┌──────────────────────────────────────────────────────────┐
│              处理每个 commit                              │
└────────────────────┬─────────────────────────────────────┘
                     │
                ┌────────▼────────────────┐
                │  获取 commit sha        │
                └────────┬────────────────┘
                         │
                ┌────────▼────────────────┐
                │  检查缓存               │
                │ repo_name in cache_data?│
                │ sha in cache[repo_name]?│
                └────────┬────────────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
        ▼                ▼                ▼
   ┌─────────┐      ┌─────────┐      ┌─────────┐
   │ 缓存    │      │ 缓存    │      │ 缓存    │
   │ 命中    │      │ 未命中  │      │ 未命中  │
   │ ✓       │      │ ✗       │      │ ✗       │
   └────┬────┘      └────┬────┘      └────┬────┘
        │                │                │
        ▼                ▼                ▼
   ┌─────────┐      ┌─────────┐      ┌─────────┐
   │ 直接    │      │ 获取    │      │ 获取    │
   │ 使用    │      │ git     │      │ API     │
   │ 缓存    │      │ show    │      │ 详情    │
   │ 数据    │      │ 详情    │      │        │
   └────┬────┘      └────┬────┘      └────┬────┘
        │                │                │
        │                └────────┬────────┘
        │                         │
        │                ┌────────▼────────┐
        │                │ 解析文件信息    │
        │                │ 统计代码行数    │
        │                │ 统计图片        │
        │                └────────┬────────┘
        │                         │
        │                ┌────────▼────────┐
        │                │ 更新缓存        │
        │                │ cache[repo][sha]│
        │                └────────┬────────┘
        │                         │
        └────────────────┬────────┘
                         │
                ┌────────▼────────────────┐
                │ 累加统计数据            │
                │ total_additions += ...  │
                │ total_deletions += ...  │
                │ image_files.update(...) │
                └────────┬────────────────┘
                         │
                ┌────────▼────────────────┐
                │ 处理下一个 commit       │
                └────────────────────────┘
```

---

## 快速参考

### 基本使用
```bash
# 设置环境变量
export USERNAME="your-username"
export GH_TOKEN="your-github-token"

# 运行脚本
python scripts/generate-stats.py

# 不统计图片
python scripts/generate-stats.py --no-images

# 清除缓存
python scripts/generate-stats.py --clear-cache
```

### 函数速查表

| 函数 | 功能 | 输入 | 输出 |
|------|------|------|------|
| `load_cache(repo_name)` | 加载缓存 | 仓库名 | 缓存数据 |
| `save_cache(repo_name, cache_data)` | 保存缓存 | 仓库名、缓存数据 | 成功/失败 |
| `clean_stale_cache(...)` | 清理过期缓存 | 缓存、commits、仓库名 | 清理后的缓存 |
| `get_repos()` | 获取仓库列表 | 无 | 仓库列表 |
| `get_upstream_repo(repo)` | 获取上游仓库 | 仓库对象 | (owner, name) |
| `get_commits_from_git_log(...)` | 获取 git log | 路径、用户名、分支 | commits 列表 |
| `get_commits_from_api(...)` | 获取 API commits | owner、repo、用户名 | commits 列表 |
| `merge_commits(git, api)` | 合并数据源 | git commits、API commits | 合并后的 commits |
| `analyze_commits(...)` | 分析 commits | 路径、owner、repo、用户名 | (additions, deletions, images) |
| `process_repos(repos, ...)` | 处理所有仓库 | 仓库列表 | 统计结果 |
| `update_readme(stats)` | 更新 README | 统计数据 | 成功/失败 |

### 缓存命中率演变

```
第一次运行（初始化）
├─ git log: 500 commits
├─ API: 1000 commits
├─ 合并: 1200 commits
├─ 缓存命中: 0/1200 = 0%
└─ 缓存未命中: 1200/1200 = 100%

第二次运行（一周后）
├─ git log: 500 commits
├─ API: 1000 commits（950 个相同）
├─ 合并: 1050 commits（新增 50 个）
├─ 缓存命中: 1000/1050 = 95.2%
└─ 缓存未命中: 50/1050 = 4.8%

第三次运行（一个月后）
├─ git log: 500 commits
├─ API: 1000 commits（980 个相同）
├─ 合并: 1020 commits（新增 20 个）
├─ 缓存命中: 1000/1020 = 98.0%
└─ 缓存未命中: 20/1020 = 2.0%

长期运行（稳定状态）
├─ 每次运行只处理新增 commits
├─ 缓存命中率: 95%+
├─ 处理时间: 大幅减少
└─ 性能: 最优
```

---

## 常见问题

### Q1：缓存命中率低
**症状**：每次运行都处理大量 commits

**原因**：
- 缓存文件被删除
- 仓库有大量新 commits
- 本地仓库过期

**解决**：
```bash
# 检查缓存文件
ls -la scripts/stats_cache/

# 更新本地仓库
git fetch origin

# 重新运行脚本
python scripts/generate-stats.py
```

### Q2：API 调用失败
**症状**：获取 commits 失败

**原因**：
- TOKEN 无效
- 网络问题
- API 限流

**解决**：
```bash
# 检查 TOKEN
echo $GH_TOKEN

# 检查网络
curl -H "Authorization: token $GH_TOKEN" https://api.github.com/user

# 等待限流恢复
sleep 60
```

### Q3：缓存数据不一致
**症状**：统计数据与预期不符

**原因**：
- 缓存被手动修改
- 时间戳格式不一致
- 缓存清理逻辑错误
- 缓存格式从对象改成数组

**解决**：
```bash
# 清除缓存重新运行
python scripts/generate-stats.py --clear-cache
python scripts/generate-stats.py
```

### Q3.5：图片统计为什么只保存数量？
**原因**：
- 减少缓存文件大小
- 避免文件名重复统计
- 只需要统计总数，不需要具体文件名

**格式变化**：
```python
# 旧格式：保存文件名列表
"images": ["image1.png", "image2.jpg", "image3.svg"]

# 新格式：只保存数量
"images": 3
```

**缓存读取**：
```python
# 旧格式：需要去重
image_files.update(cached_data.get('images', []))

# 新格式：直接加数字
total_image_count += cached_data.get('images', 0)
```

### Q4：Fork 仓库分析错误
**症状**：Fork 仓库的统计数据为 0

**原因**：
- 上游仓库信息获取失败
- 上游仓库不存在

**解决**：
```bash
# 检查仓库是否为 Fork
curl -H "Authorization: token $GH_TOKEN" \
  https://api.github.com/repos/username/repo

# 查看 source 或 parent 字段
```

### Q5：时间戳为什么很重要？
**原因**：
- 用于判断 commits 是否被变基
- 用于区分永久历史和被变基的 commits
- 用于比较两个数据源中相同 commits 的新旧程度

**格式**：
```
ISO 8601 格式：2023-12-01T15:30:00Z
可以直接字符串比较：
  "2021-01-01T..." < "2023-01-01T..." ✓
```

### Q6：相同 commits 的时间戳相同时怎么办？
**情况**：
```
git log 中的 commit 时间戳 == API 中的 commit 时间戳
```

**处理方式**：
```python
if api_time > git_time:
    # API 更新
    merged[sha] = api_commit
else:
    # git log 更新或时间戳相同
    # 时间戳相同时，默认使用 git log 的数据
    merged[sha] = git_commit
```

**为什么选择 git log？**
- git log 是本地完整历史，数据更可靠
- 时间戳相同说明两个数据源的数据是一致的
- 优先使用本地数据可以减少 API 依赖

### Q7：缓存结构为什么改成数组？
**原因**：
- 避免 commit sha 作为 key 重复出现
- URL 已经包含了完整的 commit 信息
- 数组结构更清晰，便于删除特定 commit

**结构对比**：
```python
# 旧格式：对象结构（sha 作为 key）
{
    "repo_name": {
        "abc123": {"additions": 100, ...},
        "def456": {"additions": 200, ...}
    }
}

# 新格式：数组结构（URL 包含 sha）
{
    "repo_name": [
        {"index": 1, "url": "...commit/abc123", "additions": 100, ...},
        {"index": 2, "url": "...commit/def456", "additions": 200, ...}
    ]
}
```

**优势**：
- ✅ 不需要 sha 作为 key，更简洁
- ✅ URL 可以直接点击查看 commit
- ✅ index 便于快速定位
- ✅ 删除特定 commit 更方便（直接删除数组元素）

---

## 关键特性总结

### 1. 智能缓存
- ✅ 永久保存历史数据（比当前最老数据更久远）
- ✅ 只删除被变基/压缩的 commits
- ✅ 缓存命中率通常 95%+

### 2. 双数据源
- ✅ git log：完整历史
- ✅ API：最新数据
- ✅ 自动合并，互补优势

### 3. Fork 处理
- ✅ 自动检测 Fork 仓库
- ✅ 分析上游仓库而不是 Fork
- ✅ 正确统计贡献

### 4. 图片统计
- ✅ 只统计新增图片（status='added'）
- ✅ 支持多种格式（.png, .jpg, .gif, .svg 等）
- ✅ 与代码行数统计同时进行

### 5. 错误处理
- ✅ API 调用失败自动降级
- ✅ 缓存加载失败返回空
- ✅ 命令执行失败有提示

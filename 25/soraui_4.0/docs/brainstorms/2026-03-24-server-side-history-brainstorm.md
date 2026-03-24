---
date: 2026-03-24
topic: server-side-history-migration
status: draft
---

# Sora UI 历史记录迁移至服务端管理

## What We're Building

将 sora-ui 的历史记录从 localStorage/IndexedDB 本地持久化完全迁移到服务端管理，
参考小云雀（xyq.jianying.com）的纯服务端 SSOT 架构。

**目标状态：** 前端零历史数据持久化 — localStorage 仅存 UI 偏好设置（筛选条件、视图模式），
所有历史数据 100% 来自后端 API + SSE 实时推送。

## Why This Approach

### 小云雀架构调研结论（2026-03-24 实测）

| 维度 | 小云雀实际表现 |
|------|--------------|
| **localStorage** | 12 key, 1,269 bytes — **零历史数据** |
| **sessionStorage** | 4 key — 仅分析 session + 极薄导航缓存 |
| **IndexedDB** | 0 个数据库 — 完全未使用 |
| **历史列表 API** | `POST /api/web/v1/context/generate_light_infos` — 轻量元数据 |
| **详情加载** | `POST /api/biz/v1/agent/get_thread` — 按需加载完整线程 |
| **侧边栏历史** | `POST /api/biz/v1/agent/list_user_history` — 近期记录 |
| **过滤** | 服务端 `generate_type_list` 参数 |
| **分页** | offset/size 或 page_token 服务端分页 |

### 当前 sora-ui 的痛点

1. **存储层混乱** — 同时存在 4 种存储：localStorage (`taskRecovery`, `sora-history-*`, `sora-deleted-task-ids`)、IndexedDB、Electron 文件 API、Zustand persist
2. **JSON 序列化风暴** — SSE 每秒 2-3 次触发全量 localStorage 读写（见 P0-1 分析）
3. **同步逻辑复杂** — `backendHistorySync.ts` 有 550 行合并/过滤/去重逻辑
4. **删除幽灵** — 需要 `sora-deleted-task-ids` 防止后端同步复活已删除任务
5. **多 ID 匹配** — 每个任务有 4 种 ID（id, videoId, externalTaskId, backendVideoId），合并时极易出错

### 为什么选择纯服务端 SSOT

| 选项 | 方案 | 复杂度 | 离线支持 | 一致性 |
|------|------|--------|---------|-------|
| A | 纯服务端 SSOT（小云雀模式） | 低 | 无 | 完美 |
| B | 服务端主 + IndexedDB 缓存 | 中 | 部分 | 好 |
| C | 双向同步 + 离线优先 | 高 | 完整 | 需冲突解决 |

**选择方案 A 的理由：**
- sora-ui 是在线工具，视频生成本身就需要网络 → 离线场景不存在
- 后端已有完整 CRUD API (`/api/video/tasks`)，零新增后端工作
- SSE 已有实时推送，`generating` 状态更新有保障
- 彻底消灭 4 种存储层，代码量预计减少 800+ 行

## Current Architecture（待废弃的部分）

```
前端存储层（当前）：
├── localStorage
│   ├── taskRecovery ← TaskToken[] 恢复列表（主要痛点）
│   ├── sora-history-{date} ← VideoGeneration[] 按天存储
│   ├── sora-deleted-task-ids ← 删除防复活
│   └── zustand-persist ← authStore 持久化
├── IndexedDB
│   └── indexedDBStorage ← history.service.ts 使用
├── Electron File API
│   └── electronAPI.loadHistory/saveHistory ← 桌面端
└── 内存
    ├── taskTokens (React state) ← App.tsx 主状态
    ├── displayHistory (React state) ← 渲染用列表
    └── thumbnailCache (Map) ← 缩略图内存缓存
```

## Target Architecture

```
前端（迁移后）：
├── localStorage（极简，< 2KB）
│   ├── zustand-persist ← authStore（保留）
│   └── sora-ui-preferences ← 筛选条件、视图模式
├── React 内存状态
│   ├── taskList: TaskToken[] ← 从 API 加载的当前页数据
│   ├── generating: TaskToken[] ← SSE 正在推送的任务
│   └── thumbnailCache (Map) ← 缩略图 URL 浏览器自动缓存
└── SSE
    └── taskUpdate 事件 → 直接更新 React state（不写 localStorage）

后端（已有，微调即可）：
├── GET  /api/video/tasks?page=&pageSize=&status=&orderBy= ← 分页列表
├── GET  /api/video/tasks/:videoId ← 详情
├── POST /api/video/tasks ← 创建
├── POST /api/video/tasks/:videoId/cancel ← 取消
├── DELETE /api/video/tasks/:videoId ← 删除（如需新增）
├── SSE  /api/sse/task-updates ← 实时推送
└── POST /api/cos/thumbnail ← 缩略图上传
```

## Key Decisions

### 1. 删除操作策略

**决定：服务端硬删除，无需 `sora-deleted-task-ids`**

- 删除时调用 `DELETE /api/video/tasks/:videoId`
- 服务端从数据库删除（或软删除）
- 前端从内存 `taskList` 中移除
- 不再有"后端同步复活"的问题

### 2. 初始加载策略

**决定：首页按需加载 + SSE 增量更新**

- 进入历史页时才加载历史列表（类似小云雀 `/history` 路由）
- 默认加载最近 20 条（服务端分页）
- 滚动/翻页时加载更多
- SSE 推送 `generating` → `completed` 时实时追加到列表头部

### 3. 侧边栏/工作区历史

**决定：从 API 加载最近 N 条**

- `GET /api/video/tasks?pageSize=10&orderBy=createdAt&order=desc` 加载最近 10 条
- 按日期分组显示（昨天/本月）
- SSE 新任务实时插入

### 4. 搜索与筛选

**决定：服务端筛选**

- 状态筛选：`?status=COMPLETED`
- 模型筛选：`?model=xxx`（需后端支持）
- 搜索：`?search=prompt关键词`（需后端支持）
- 日期范围：`?startDate=&endDate=`（需后端支持）

### 5. Electron 桌面端兼容

**决定：统一到 API，废弃文件系统存储**

- Electron 版也走 HTTP API（已有 `backendUrl` 配置）
- 不再使用 `electronAPI.loadHistory/saveHistory`
- 离线场景不考虑（视频生成本身需要网络）

### 6. `generating` 任务处理

**决定：内存持有 + SSE 驱动 + 服务端兜底**

- 用户提交任务 → `POST /api/video/tasks` → 服务端创建记录 → 返回 videoId
- 前端将 videoId 加入 `generating` 列表（纯内存）
- SSE 推送状态更新 → 更新内存状态 → 不写 localStorage
- 刷新页面 → 从 `GET /api/video/tasks?status=PROCESSING` 恢复 generating 列表
- 不需要 `taskRecovery` localStorage — 服务端就是恢复源

### 7. thumbnailBase64 处理

**决定：完全走 COS URL（与 P0-2 方案一致）**

- 新任务：Remix 参考图上传到 COS → 存 `thumbnailUrl`
- 旧任务：不迁移（已完成的 P0-2 会处理）
- 前端：`<img src={thumbnailUrl}>` + 浏览器自动缓存
- 不再有 base64 内嵌 token 的问题

## 待废弃的文件/代码

| 文件 | 原因 |
|------|------|
| `taskTokenManager.ts` | 整个 localStorage 恢复机制废弃 |
| `storageManager.ts` | localStorage/Electron 按天存储废弃 |
| `backendHistorySync.ts` | 双向同步逻辑废弃（服务端是唯一源） |
| `history.service.ts` | IndexedDB 存储层废弃 |
| `utils/storage/indexedDBStorage` | IndexedDB 操作废弃 |
| `types/taskToken.ts` | 简化，去掉 `thumbnailBase64` 等 localStorage 相关字段 |
| App.tsx 中的 `beforeunload` localStorage 写入 | 废弃 |
| App.tsx 中的 `getAllHistoryFlat()` 调用 | 废弃 |

## 需要新增/修改的后端接口

| 接口 | 状态 | 说明 |
|------|------|------|
| `GET /api/video/tasks` | **已有** | 分页列表，需确认支持 status/model 筛选 |
| `GET /api/video/tasks/:id` | **已有** | 详情 |
| `DELETE /api/video/tasks/:id` | **待确认** | 硬删除或软删除 |
| `GET /api/video/tasks?search=` | **待确认** | prompt 关键词搜索 |
| `GET /api/video/tasks?model=` | **待确认** | 模型筛选 |
| `GET /api/video/tasks?startDate=&endDate=` | **待确认** | 日期范围筛选 |
| `PATCH /api/video/tasks/:id/favorite` | **可能需要** | 收藏功能（如果保留） |
| `SSE /api/sse/task-updates` | **已有** | 实时推送 |

## Resolved Questions

1. **收藏功能** → 后端新增 `isFavorite` 字段，服务端持久化（`PATCH /api/video/tasks/:id/favorite`）
2. **历史数据迁移** → 直接丢弃本地数据 — 后端已有所有任务记录（通过 `createVideoTask` 已同步）
3. **Electron 桌面端** → 统一走 HTTP API，废弃文件系统存储（`electronAPI.loadHistory/saveHistory`）

## 后端筛选能力调研

### 当前 `listVideoTasks` 已支持

| 参数 | 类型 | 说明 |
|------|------|------|
| `page` | number | 分页页码 |
| `pageSize` | number | 每页条数 |
| `status` | string | 状态筛选（QUEUED/PROCESSING/COMPLETED/FAILED/CANCELLED） |
| `orderBy` | string | 排序字段 |
| `order` | asc/desc | 排序方向 |

### 需要后端新增的能力

| 能力 | 参数 | 优先级 | 说明 |
|------|------|--------|------|
| **删除任务** | `DELETE /api/video/tasks/:id` | **P0** | 当前不存在！前端删除仅删本地 |
| **收藏** | `PATCH /api/video/tasks/:id/favorite` | **P1** | 新增 `isFavorite` 字段 |
| **模型筛选** | `?model=sora-2` | **P1** | 按模型过滤 |
| **关键词搜索** | `?search=prompt关键词` | **P1** | prompt 全文搜索 |
| **日期范围** | `?startDate=&endDate=` | **P2** | 按创建时间范围筛选 |
| **批量删除** | `DELETE /api/video/tasks` + body | **P2** | 支持多选删除 |

### 注意事项

- `sora-ui-backend` 是 git submodule，当前工作区未初始化，无法直接查看后端源码
- 后端 Prisma schema 不在 `newapi-prisma` 中（那是 Go API 的数据库），而在 `sora-ui-backend` 自己的 schema 中
- 需要初始化 `sora-ui-backend` 子模块后再进行后端改动

## Resolved Questions (Round 2)

3. **删除策略** → 软删除（标记 `deletedAt`，列表查询自动过滤 `WHERE deletedAt IS NULL`）

## 深入设计：SSE 实时更新与列表衔接

### 当前 SSE 流程（问题版本）

```
SSE taskUpdate → App.tsx onTaskUpdate → setTaskTokens(内存) + taskTokenManager.updateTask(localStorage)
```

### 目标 SSE 流程（服务端 SSOT 版本）

```
SSE taskUpdate → useTaskStore.updateTask(内存 only)
                    ↓
            状态变为 completed/failed/cancelled 时：
                    ↓
            从 generating 列表移到 history 列表（纯内存操作）
            不写 localStorage、不写 IndexedDB
```

### 关键场景设计

**场景 1：用户提交新任务**
1. `POST /api/video/tasks` → 后端创建记录 → 返回 `{ videoId, status: 'QUEUED' }`
2. 前端将任务加入 `useTaskStore.generating[]`（内存）
3. SSE 推送 `taskUpdate(videoId, status: 'PROCESSING', progress: 30)` → 更新内存
4. SSE 推送 `taskUpdate(videoId, status: 'COMPLETED', videoUrl)` → 从 `generating` 移到 `history` 列表头部

**场景 2：用户刷新页面**
1. 页面加载 → `GET /api/video/tasks?status=PROCESSING&status=QUEUED` → 恢复 `generating[]`
2. 页面加载 → `GET /api/video/tasks?pageSize=20&orderBy=createdAt&order=desc` → 加载 `history[]` 首页
3. SSE 重连 → 继续接收更新

**场景 3：SSE 断线重连**
1. EventSource 重连（已有指数退避逻辑）
2. 重连后服务端重发最近事件（如果后端支持 Last-Event-ID）
3. 或者前端重连后主动 `GET /api/video/tasks?status=PROCESSING` 刷新状态

**场景 4：多标签页**
- 每个标签页独立 SSE 连接 + 独立内存状态
- 删除操作通过 API，所有标签页下次加载时自动同步
- 不需要 BroadcastChannel 或 localStorage 事件同步（YAGNI）

## 深入设计：后端 API 接口细节

### 列表 API 增强

```
GET /api/video/tasks
  ?page=1
  &pageSize=20
  &status=COMPLETED          # 状态筛选（多选：status=COMPLETED&status=FAILED）
  &model=sora-2              # 模型筛选
  &search=风景               # prompt 关键词搜索（LIKE '%风景%'）
  &startDate=2026-03-01      # 开始日期
  &endDate=2026-03-24        # 结束日期
  &favorite=true             # 仅收藏
  &orderBy=createdAt         # 排序字段
  &order=desc                # 排序方向

Response:
{
  "success": true,
  "data": {
    "tasks": [
      {
        "videoId": "xxx",
        "status": "COMPLETED",
        "prompt": "...",
        "model": "sora-2",
        "thumbnailUrl": "https://cos.../thumb.jpg?imageMogr2/thumbnail/200x200",
        "videoUrl": "https://...",
        "imageUrl": "https://...",
        "progress": 100,
        "isFavorite": false,
        "createdAt": "2026-03-24T00:00:00Z",
        "duration": 10,
        "aspectRatio": "16:9"
      }
    ],
    "total": 438,
    "page": 1,
    "pageSize": 20,
    "hasMore": true
  }
}
```

### 删除 API（新增）

```
DELETE /api/video/tasks/:videoId
Authorization: Bearer <token>

Response: { "success": true }

实现：UPDATE video_tasks SET deleted_at = NOW() WHERE video_id = :videoId AND user_id = :userId
```

### 批量删除（新增）

```
POST /api/video/tasks/batch-delete
Authorization: Bearer <token>
Body: { "videoIds": ["id1", "id2", "id3"] }

Response: { "success": true, "data": { "deletedCount": 3 } }
```

### 收藏切换（新增）

```
PATCH /api/video/tasks/:videoId/favorite
Authorization: Bearer <token>
Body: { "isFavorite": true }

Response: { "success": true }

实现：UPDATE video_tasks SET is_favorite = :isFavorite WHERE video_id = :videoId AND user_id = :userId
```

### 分页策略选择

| 方式 | 优点 | 缺点 | 选择 |
|------|------|------|------|
| offset/limit | 简单，支持跳页 | 数据变动时可能跳过/重复 | **选此方案** |
| cursor/token | 稳定，数据变动不影响 | 不支持跳页 | 小云雀用此 |
| 混合 | 列表用 offset，实时流用 cursor | 复杂 | 过度设计 |

sora-ui 已有 `page`/`pageSize` 参数，保持一致减少改动。数据变动频率低（用户主动删除才会变），offset 足够。

## 深入设计：前端状态管理重构

### 当前状态（混乱）

```
App.tsx:
  - taskTokens: TaskToken[] (React state) ← 全部任务，500+ 条
  - displayHistory: VideoGeneration[] (React state) ← 渲染列表
  - 多个 useEffect 同步两者

storageManager.ts ← localStorage 读写
taskTokenManager.ts ← localStorage 读写
backendHistorySync.ts ← API → localStorage
history.service.ts ← IndexedDB + RxJS BehaviorSubject
```

### 目标状态（清晰分层）

```typescript
// stores/useTaskStore.ts — Zustand store（单一状态源）
interface TaskStore {
  // === 正在生成的任务（SSE 驱动） ===
  generatingTasks: Map<string, TaskToken>;
  addGenerating: (task: TaskToken) => void;
  updateGenerating: (videoId: string, updates: Partial<TaskToken>) => void;
  completeGenerating: (videoId: string) => void;

  // === 历史列表（API 驱动） ===
  historyTasks: TaskToken[];
  historyTotal: number;
  historyPage: number;
  historyLoading: boolean;
  historyFilters: HistoryFilters;

  loadHistory: (page?: number) => Promise<void>;
  setFilters: (filters: Partial<HistoryFilters>) => void;
  deleteTask: (videoId: string) => Promise<void>;
  toggleFavorite: (videoId: string) => Promise<void>;

  // === 侧边栏近期历史 ===
  recentTasks: TaskToken[];
  loadRecent: () => Promise<void>;
}

interface HistoryFilters {
  status?: TaskStatus;
  model?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
  favorite?: boolean;
}
```

### 关键设计原则

1. **`generatingTasks` 用 Map** — O(1) 查找/更新，SSE 高频更新场景必须
2. **`historyTasks` 是当前页数据** — 不缓存全部，翻页时替换（类似小云雀，438 条一次返回也才 ~200KB）
3. **筛选条件存 Zustand + localStorage persist** — 仅 `historyFilters` 需要持久化（参考小云雀的 `__pippitcn-history-search-filters`）
4. **SSE handler 直接操作 store** — 不再通过 App.tsx 中转
5. **废弃 RxJS** — `history.service.ts` 用 RxJS BehaviorSubject，迁移后用 Zustand 替代

### 组件对应关系

| 组件 | 数据源 | 变化 |
|------|--------|------|
| 侧边栏历史 | `recentTasks` | 从 `storageManager` → `loadRecent()` API |
| 历史页面 | `historyTasks` + `generatingTasks` | 从 `displayHistory` state → store 订阅 |
| 工作区 | `generatingTasks` | 从 `taskTokens` state → store 订阅 |
| SSE handler | `updateGenerating()` | 从 `onTaskUpdate` 回调 → store action |

## 深入设计：迁移过渡方案

### 阶段 1：后端 API 增强（1-2 天）

- [ ] 初始化 `sora-ui-backend` 子模块
- [ ] 新增 `DELETE /api/video/tasks/:videoId`（软删除）
- [ ] 新增 `PATCH /api/video/tasks/:videoId/favorite`
- [ ] `GET /api/video/tasks` 增加 `model`、`search`、`startDate`/`endDate`、`favorite` 筛选
- [ ] VideoTask Prisma model 增加 `isFavorite`、`deletedAt` 字段
- [ ] 测试所有新增 API

### 阶段 2：前端新建 useTaskStore（1 天）

- [ ] 创建 `stores/useTaskStore.ts`
- [ ] 实现 `loadHistory()`、`loadRecent()`、`deleteTask()`、`toggleFavorite()`
- [ ] 实现 `generatingTasks` Map 管理
- [ ] SSE handler 改为直接调用 store actions
- [ ] 新的历史筛选 UI 组件

### 阶段 3：组件迁移（2-3 天）

- [ ] 历史页面组件切换到 `useTaskStore.historyTasks`
- [ ] 侧边栏切换到 `useTaskStore.recentTasks`
- [ ] 工作区切换到 `useTaskStore.generatingTasks`
- [ ] App.tsx 移除所有 localStorage 相关逻辑
- [ ] 删除操作改为调用 `DELETE /api/video/tasks/:id`

### 阶段 4：废弃清理（1 天）

- [ ] 删除 `taskTokenManager.ts`
- [ ] 删除 `storageManager.ts`
- [ ] 删除 `backendHistorySync.ts`
- [ ] 删除 `history.service.ts`
- [ ] 删除 `indexedDBStorage` 相关代码
- [ ] 清理 App.tsx 中 500+ 行旧逻辑
- [ ] 移除 `sora-deleted-task-ids` localStorage key
- [ ] 移除 `sora-history-*` localStorage keys

### 风险控制

- **阶段 2-3 可以并行开发** — store 和组件迁移不互相阻塞
- **功能开关** — 可以用环境变量 `VITE_USE_SERVER_HISTORY=true` 控制新旧逻辑切换
- **回滚方案** — 保留旧代码文件直到新版本验证通过，再删除

## 深入设计：性能分析

### "每次都从服务端加载会不会慢？"

| 场景 | 数据量 | 网络耗时 | 对比现状 |
|------|--------|---------|---------|
| 首页加载 20 条 | ~10KB JSON | 50-100ms | 现状：解析 5MB localStorage = 200ms+ |
| 翻页 20 条 | ~10KB JSON | 50-100ms | 现状：无（全量在内存） |
| 侧边栏 10 条 | ~5KB JSON | 30-50ms | 现状：从 localStorage 读取 |
| SSE 更新 1 条 | ~200B | 实时 | 不变 |

### 为什么不会比现在慢

1. **现状的"快"是假象** — localStorage 5MB 全量 JSON.parse 阻塞主线程 200ms+，首次加载实际很慢
2. **API 返回轻量数据** — 20 条 TaskToken（不含 thumbnailBase64）约 10KB，远小于现在的 5MB
3. **后端有索引** — Prisma + PostgreSQL 有 `created_at`、`status` 索引，分页查询 < 10ms
4. **缩略图由浏览器缓存** — `thumbnailUrl` 是 COS CDN URL，浏览器自动 304 缓存
5. **SSE 不变** — 实时更新依然走 SSE push，零感知延迟

### 可选优化（YAGNI，先不做）

- **SWR/stale-while-revalidate** — 先显示上次数据，后台刷新（TanStack Query 模式）
- **预取下一页** — 用户接近底部时提前加载
- **Service Worker 缓存** — API 响应缓存层
- 这些都是**后续可加**的，先做最简单版本验证。

## 逆向结论：小云雀的极简架构（2026-03-24 深度实测）

### 数据流模式

```
小云雀：
  页面加载 → POST /api/.../generate_light_infos { offset, size, type_list }
                ↓
            服务端返回 20 条 (42KB, ~1.7s)
                ↓
            直接渲染 20 个 gridItem（无虚拟滚动）
                ↓
            Cover 图片 = CDN URL（p3-sign.douyinpic.com），浏览器自动缓存
                ↓
            翻页/筛选 → 重新调 API → 替换渲染

  实时更新：无 SSE/WebSocket，纯请求-响应 + 手动刷新按钮
  缓存：零（每次 API 调用都是新鲜数据，无 cache hit）
  本地存储：仅 1.2KB UI 偏好（筛选条件 + 视图模式）
```

### 关键发现

| 发现 | 意义 |
|------|------|
| Light info API 的 `output` 字段**内嵌** cover_url 和 video_url | 列表页不需要额外请求获取缩略图 |
| 无虚拟滚动 | 20 条/页直接 DOM 渲染足够 |
| 无 SSE/WebSocket | 纯拉取模式（sora-ui 已有 SSE，更优） |
| 无请求缓存/去重 | 每次操作都调 API（简单粗暴但有效） |
| 无 React Query/SWR/Zustand | 极简状态管理，API 响应直接驱动 UI |

### 对 sora-ui 的核心启示

**你的直觉完全正确——这就是一个"展示源替换"：**

```
当前 sora-ui 数据流：
  启动 → taskTokenManager.recoverTasks() [读 localStorage]
       → setTaskTokens(tokens)
       → 渲染 VideoHistory 列表
  
  SSE 更新 → setTaskTokens(prev => [...]) [更新内存]
           → taskTokenManager.scheduleSave() [写 localStorage] ← 这个删掉
  
  删除 → deleteFromLocalStorage() + addDeletedTaskId() ← 这些删掉

目标 sora-ui 数据流：
  启动 → backendAPI.listVideoTasks() [读 API]
       → setTaskTokens(tokens)
       → 渲染 VideoHistory 列表（组件不变！）
  
  SSE 更新 → setTaskTokens(prev => [...]) [更新内存]
           → 不写 localStorage（删掉 scheduleSave 调用）
  
  删除 → backendAPI.deleteVideoTask(id) + 从内存移除

核心改动 = 替换数据源 + 删除写入代码，UI 组件几乎不动
```

## 简化后的实施方案：展示源替换

### 原则：最小改动，最大收益

不需要新建 Zustand store，不需要重写组件。只需要：
1. **替换**数据加载源（localStorage → API）
2. **删除**所有 localStorage 写入代码
3. **新增**删除 API 调用
4. **保留** SSE handler 的内存更新逻辑（已有，只删 localStorage 写入部分）

### Phase 1：后端准备（0.5 天）

```
后端 sora-ui-backend：
  ✅ GET  /api/video/tasks (已有 - 分页列表)
  ✅ GET  /api/video/tasks/:id (已有 - 详情)  
  ✅ POST /api/video/tasks (已有 - 创建)
  ✅ POST /api/video/tasks/:id/cancel (已有 - 取消)
  ✅ SSE  /api/sse/task-updates (已有 - 实时推送)
  🆕 DELETE /api/video/tasks/:id (新增 - 软删除)
  🆕 PATCH  /api/video/tasks/:id/favorite (新增 - 收藏)
  🆕 GET    /api/video/tasks 增加 search/model/date 筛选参数
```

### Phase 2：前端展示源替换（1-2 天）

**改动 1：App.tsx — 启动加载（~20 行改动）**

```typescript
// 现在（读 localStorage）：
const tokens = await taskTokenManager.recoverTasks();
setTaskTokens(tokens);

// 改为（读 API）：
const { tasks } = await backendAPI.listVideoTasks(token, { 
  pageSize: 50, orderBy: 'createdAt', order: 'desc' 
});
const tokens = tasks.map(t => convertToTaskToken(t));
setTaskTokens(tokens);
```

**改动 2：App.tsx — SSE handler（~5 行删除）**

```typescript
// 现在：
onTaskUpdate → setTaskTokens(更新内存) + taskTokenManager.scheduleSave(写 localStorage)

// 改为：
onTaskUpdate → setTaskTokens(更新内存)  // 删掉 scheduleSave 调用即可
```

**改动 3：删除操作（~10 行改动）**

```typescript
// 现在：
handleDelete → deleteFromLocalStorage() + addDeletedTaskId(id)

// 改为：  
handleDelete → await backendAPI.deleteVideoTask(token, videoId)
             → setTaskTokens(prev => prev.filter(t => t.id !== id))
```

**改动 4：页面刷新恢复（~5 行改动）**

```typescript
// 现在（beforeunload 写 localStorage）：
window.addEventListener('beforeunload', () => taskTokenManager.flushSave());

// 改为：
// 删掉这个 listener。刷新后从 API 重新加载，不需要本地备份。
```

### Phase 3：清理废弃代码（0.5 天）

```
删除文件：
  ❌ taskTokenManager.ts（整个文件）
  ❌ storageManager.ts（整个文件）  
  ❌ backendHistorySync.ts（整个文件）
  ❌ history.service.ts（整个文件，RxJS 层）

删除 App.tsx 中的代码：
  ❌ taskTokenManager 相关的所有 import 和调用
  ❌ beforeunload localStorage 写入
  ❌ getAllHistoryFlat() 调用
  ❌ sora-deleted-task-ids 相关逻辑
  ❌ thumbnailBase64 localStorage 写入

清理 localStorage keys：
  ❌ taskRecovery
  ❌ sora-history-*
  ❌ sora-deleted-task-ids
```

### 工作量对比

| 方案 | 改动量 | 风险 |
|------|--------|------|
| 之前的方案（新建 Zustand store + 全面重构） | ~800 行新增 + ~800 行删除 | 中-高 |
| **展示源替换方案（当前）** | **~40 行改动 + ~800 行删除** | **低** |

核心差异：不新建任何抽象层，直接在现有代码中替换数据源。

## Zustand 最佳实践参考（Context7）

```typescript
// 如果后续需要提取到 store，这是 Zustand 的推荐模式：
const useTaskStore = create<TaskState>()((set, get) => ({
  tasks: [],
  loading: false,
  error: null,
  
  fetchTasks: async () => {
    set({ loading: true, error: null });
    try {
      const { tasks } = await backendAPI.listVideoTasks(token, { pageSize: 50 });
      set({ tasks, loading: false });
    } catch (error) {
      set({ error: (error as Error).message, loading: false });
    }
  },
}));

// 但第一阶段不需要 — 直接在 App.tsx 替换数据源就行
```

## Open Questions

1. **后端源码访问** — 需要 `git submodule update --init sora-ui-backend` 才能查看/修改后端代码

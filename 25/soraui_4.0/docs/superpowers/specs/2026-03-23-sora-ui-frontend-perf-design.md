---
date: 2026-03-23
topic: sora-ui-frontend-perf
---

# Sora UI 前端性能优化 — 精准修复方案

## 问题描述

Sora UI (`sora-ui`) 前端 Web 应用在持续使用 1-2 小时后出现明显卡顿：
- 整体 UI 变慢（点击、滚动、切换页面）
- 浏览器标签页内存飙升
- 特定页面（VideoHistory、Workspace）尤其明显
- 刷新后好一些但不完全恢复（运行时泄漏 + 持久化数据膨胀双重问题）

## 技术栈

- React 18 + TypeScript + Vite 5
- Ant Design 6
- Zustand 5（状态管理，带 persist 中间件）
- SSE（EventSource，实时任务更新）
- localStorage（taskTokenManager 持久化）
- 腾讯云 COS（已接入，`cosCompressionService.ts` + `assetStorageService.ts`，S3 兼容 API）
- Cloudflare R2（已接入，`r2StorageService.ts`，Presigned URL 模式，支持 `THUMBNAIL` sourceType）
- 后端已有 `POST /api/r2/migrate/batch` 接口支持 base64 批量迁移到云端

## 根因分析

### #1 根本原因：`taskTokenManager` localStorage 读写风暴

`taskTokenManager.updateTask()` 在每次 SSE 事件中被调用：

```
SSE event → App.tsx onTaskUpdate → taskTokenManager.updateTask()
                                    ↓
                              JSON.parse(全部 tokens)
                              findIndex + 修改
                              JSON.stringify(全部 tokens)
                              写入 localStorage
```

token 数组中嵌有 `thumbnailBase64`（每条 25-50KB）。500 条记录 ≈ 25MB JSON。
SSE 每秒推送 2-3 次 = **每秒 50-75MB JSON 序列化阻塞主线程**。

随着任务积累，序列化开销线性增长，这就是"用久了变卡"的直接原因。

### #2 `thumbnailBase64` 嵌入 token 放大序列化开销

`TaskToken` 接口（`taskToken.ts` 第 78 行）包含 `thumbnailBase64?: string`。
`extractToken()` 会将每个任务的 base64 缩略图复制到 token 中并持久化到 localStorage。
这使得每次 `taskTokenManager` 的读写操作都包含大量无用的 base64 数据。

### #3 Zustand 无 selector 订阅导致级联重渲染

- `useSSE.ts:40` — `const { token } = useAuthStore()` 订阅整个 authStore
- `App.tsx:183` — `const { isImpersonating, user, stopImpersonation } = useAuthStore()` 订阅整个 store

根据 Zustand 官方文档（Context7 验证），无 selector 调用等于订阅整个 store。
authStore 中任何字段变化（token 刷新、loading 状态等）都会触发 useSSE hook 和 ImpersonationBanner 重渲染。

### #4 SSE 更新时的冗余 React 状态更新

`setTaskTokens(prev => { const newTokens = [...prev]; ... })` 在无实际变化时仍创建新数组引用，
触发整个 VideoHistory 组件树重渲染。

### #5 Set/Ref 无限增长

- `recoveredTasksRef` (Set) — 只增不减，记录已恢复的任务 ID
- `processedEventsRef` (Set) — 清理逻辑有缺陷（100→删50→保留50+新增=震荡增长）
- `observedIdsRef` / `loadedImagesRef`（VideoHistory）— 只增不减

### #6 无用代码占用资源

- `useMemoryLifecycle` hook — 创建空 Map 并每 5 分钟清理空 Map，零实际效果
- 重复 Ctrl+S 监听器 — App.tsx 中两个独立 `useEffect` 注册同一快捷键
- `useMemoryMonitor` — 每 30 秒日志一次但不在生产环境使用

## 修复方案：分层精准修复

### P0 — 核心修复（预计解决 80% 卡顿）

#### P0-1: `taskTokenManager` 写入防抖

**原理：** 不再每次 SSE 事件都读写 localStorage。内存中维护 token 状态（`taskTokens` React state 已经是），
localStorage 写入改为 debounced write-back：

- SSE 更新只修改 React state（已有）
- 标记 dirty flag
- 1 秒 debounce 后批量写入 localStorage
- 任务完成/失败/取消时立即写入（关键状态不丢失）
- `beforeunload` 时同步写入（已有）
- 进程崩溃/OOM kill 最多丢失最近 1 秒的 generating 中间状态（可接受，SSE 重连后恢复）

**多标签页策略：** 当前产品为单标签页使用模式。不增加跨标签页同步机制（YAGNI）。
如果用户在多个标签页打开，以最后活跃标签页的写入为准（last-writer-wins）。

**改动范围：**
- `App.tsx` — SSE `onTaskUpdate` 中移除 `taskTokenManager.updateTask()` 调用（生成中状态）
- `taskTokenManager.ts` — 新增 `scheduleSave()` 方法（1 秒 debounce）
- 保留任务完成/取消时的立即写入

#### P0-2: `thumbnailBase64` 迁移到云端存储（COS/R2）

**原理：** 缩略图从 localStorage 内联 base64 改为上传到云端，token 中只存 URL。

**已有基础设施（无需新建后端接口）：**
- `cosCompressionService.ts` — 腾讯云 COS，S3 兼容 API，base64 直传 + 自动压缩
- `assetStorageService.ts` — 资产存储服务，`parseBase64()` + `PutObjectCommand` 直传
- `r2StorageService.ts` — Cloudflare R2，Presigned URL 模式
- `POST /api/r2/migrate/batch` — 已有批量迁移接口，接受 `{ localId, base64Data, sourceType: 'THUMBNAIL' }`

**改动范围：**

新建缩略图时（Remix、参考图生成时）：
- 生成 base64 缩略图后，调用 `POST /api/r2/migrate/batch`（单条）上传到 R2/COS
- 将返回的 `publicUrl` 存入 token 的 `thumbnailUrl` 字段（新字段，替代 `thumbnailBase64`）
- 内存 `thumbnailCache` 继续作为热缓存（避免重复网络请求）

`extractToken()` 修改：
- 不再复制 `thumbnailBase64` 到 token
- 新增 `thumbnailUrl` 字段传递

`taskTokenManager.saveTasks()` 修改：
- 写入 localStorage 前 strip `thumbnailBase64` 字段

UI 层修改：
- 优先用 `thumbnailUrl`（`<img src={thumbnailUrl}>`，浏览器自动缓存）
- 其次用 `thumbnailCache.get(taskId)`（内存热缓存）
- 都没有时显示灰色占位符

**首次部署迁移：** `taskTokenManager.recoverTasks()` 中增加一次性迁移：
1. 读取 tokens，检测含 `thumbnailBase64` 的条目
2. 后台批量调用 `/api/r2/migrate/batch` 上传到云端
3. 将返回的 URL 写入 `thumbnailUrl`，strip `thumbnailBase64`
4. 重写 localStorage

**效果：** token 体积从 ~50KB/条 降到 ~1KB/条。localStorage 从 25MB 降到 500KB。
刷新后缩略图仍可显示（通过 `thumbnailUrl` 从 COS/R2 加载）。

#### P0-3: Zustand selector 修复

**改动：**
- `useSSE.ts:40` — `const token = useAuthStore(state => state.token)`
- `App.tsx:183` — 使用 `useShallow` 选择具体字段
- 全局扫描所有 `useXxxStore()` 无 selector 调用，统一加上 selector

#### P0-4: SSE `setTaskTokens` 变化检测

在 `setTaskTokens` updater 函数中，找到匹配任务后，比较以下字段是否有实际变化：

- `status` — 严格相等 (`===`)
- `progress` — 严格相等
- `video_url` — 严格相等
- `image_url` — 严格相等
- `error` — 严格相等

如果以上 5 个字段全部无变化，直接 `return prev`。不比较其他字段（如 referenceImageUrls 数组），
避免引用比较陷阱。这 5 个字段覆盖了所有影响 UI 渲染的关键状态。

### P1 — 资源泄漏修复

#### P1-1: Set/Ref 清理

- `recoveredTasksRef` — 当无 `generating` 任务时 `clear()`
- `processedEventsRef` — 改为 Map<string, number>（key→时间戳），超过 100 条时删除 5 分钟前的旧条目。
  不做无条件 `clear()`，因为 SSE 重连后服务端可能重放近期事件，需要保留近期事件 ID 用于去重。
- `observedIdsRef` / `loadedImagesRef` — 组件卸载时 `clear()`

#### P1-2: 重复 Ctrl+S 监听器

删除 App.tsx 第 1254-1266 行的重复 handler，保留 `useAutoSave` 的版本。

#### P1-3: 无用代码移除

- `useMemoryLifecycle` — 从 VideoHistory 中移除调用（或删除整个 hook）
- 生产环境禁用 `useMemoryMonitor` 的 30 秒 setInterval

#### P1-4: 定时器 + Page Visibility API

App.tsx 中的 60 秒 URL 检查器和 5 分钟自动保存，在 `document.hidden` 时暂停。
参考 VideoHistory 中代理检查的已有实现。

### P2 — 持久化数据优化

#### P2-1: `getAllHistoryFlat()` 按需加载

将启动时/登录时的全量加载改为从 `taskTokens` + 按需 `getTaskById()` 获取。
影响 3 处一次性调用（启动清理、登录同步、任务恢复）。

#### P2-3: `performance.measure` 条目清理

测量完成后调用 `performance.clearMarks()` 和 `performance.clearMeasures()`。

## 关键决策

1. **写入防抖而非取消写入** — 保证数据最终一致性，关键状态立即持久化
2. **缩略图直接上 COS/R2** — 后端已有完整的上传/迁移 API，无需新建接口，一步到位
3. **使用 Zustand selector/useShallow 而非重构 store** — 最小改动，遵循官方推荐
4. **P0 每个修复点独立可验证** — 逐个实施，每个都能量化效果

## 验证方式

### 基线指标（修复前先测量）

| 指标 | 测量方法 | 预期修复前值 |
|------|---------|------------|
| localStorage `taskRecovery` 体积 | DevTools Application → Local Storage | ≥ 5MB (500条含 thumbnail) |
| 5 分钟 SSE 活跃期 Long Task (>50ms) 次数 | DevTools Performance 面板录制 | 高频出现 |
| JS Heap 2 小时增长量 | DevTools Memory → Heap snapshot 对比 | 持续增长 |
| SSE 更新时主线程阻塞时长 | Performance 面板单个 task 追踪 | 50-200ms/次 |

### 修复后验收标准

| 指标 | 通过条件 |
|------|---------|
| localStorage `taskRecovery` 体积 | < 500KB (500条不含 thumbnail) |
| 5 分钟 SSE 活跃期 Long Task 次数 | 减少 80%+ |
| JS Heap 2 小时增长量 | < 10MB 增长（排除浏览器自身开销） |
| SSE 更新时主线程阻塞时长 | < 5ms/次 |

### 测试环境

- 同一台机器、同一浏览器版本
- 预填充 500 条历史任务
- 模拟 SSE 推送（每秒 2-3 条 taskUpdate 事件）
- 持续运行 2 小时后测量

## 不做的事情（YAGNI）

- 不引入 React Query / SWR — 当前 SSE + Zustand 架构足够，问题在实现细节
- 不重构 taskTokenManager 为 IndexedDB — localStorage 在修复 thumbnailBase64 后体积足够小
- 不添加 Service Worker 缓存层 — 增加复杂度，收益不明确
- 不重写 VideoHistory 为虚拟列表 — 已有 `VirtualHistoryList`，问题不在渲染层

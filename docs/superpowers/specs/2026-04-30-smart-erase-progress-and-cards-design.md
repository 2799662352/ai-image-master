---
date: 2026-04-30
topic: smart-erase-progress-and-cards
---

# 智能去字幕 — 处理进度条 + 结果卡片化设计

## What We're Building

延续 [2026-04-29 智能去字幕 MVP](../plans/2026-04-29-smart-erase-feature.md)（已交付）的两点 UX 修复：

1. **A · 处理进度条**：MPS 处理阶段（占 0–95%）显示一个会动的进度条，并把轮询节奏从「分级 5/10/15s」换成「指数退避 + 上限 60s」，长视频的 API 调用次数下降 ~68%。
2. **B · 结果卡片化**：把当前占满半屏的 `EraseResultPanel`（巨幅内嵌视频）改成 Grid Split 同款的水平缩略图卡片行，点击卡片在全屏 modal 内播放。

两块共用 IPC 进度事件契约的小幅扩展，所以并到一个 spec 一并交付。

Prior plan: `docs/superpowers/plans/2026-04-29-smart-erase-feature.md`

## 基线状态

| 已有 | 状态 |
|------|------|
| `EraseQueue.tsx` 行内显示 `[状态] [取消]`，没有进度条 | 已实现 |
| `EraseResultPanel.tsx` 选中后显示 `<video w-full max-h-[60vh]>` | 已实现（上一轮裁高度修复后） |
| `runner.ts:pollIntervalMs` 分级 5s / 10s / 15s | 已实现 |
| `EraseTask.uploadProgress` 0–100（COS 上传） | 已实现（上一轮 0.98% bug 修复后） |
| `EraseTask.processingProgress` 字段 | **未实现** |
| 渲染端基于 `startedAt` 的本地动画 ticker | **未实现** |
| `EraseResultCard` / `EraseResultGrid` / `EraseResultModal` | **未实现** |

## 设计决策

### 决策 A1：进度数字 = 时间渐近曲线（方案 time-asymptotic）

MPS 的 `DescribeTaskDetail` 不返回 `Progress` 字段（直接验证 SDK 类型 `node_modules/tencentcloud-sdk-nodejs-mps/.../mps_models.d.ts`，零匹配）。Tencent 接入文档（用户提供 URL `cloud.tencent.com/document/product/862/119629`）也只描述 `Status: WAITING / PROCESSING / FINISH`。**真实进度不可得，只能估**。

公式（纯函数，渲染端独立计算）：

```typescript
// src/renderer/src/pages-react/smart-erase/eraseProgress.ts (NEW)
export function computeProcessingProgress(opts: {
  startedAt: number       // ms; 当 status === 'processing' 时由 useEraseEvents 写入
  durationSeconds: number // 视频长度（来自 ffprobe）
  status: EraseTask['status']
  now: number
}): number {
  if (opts.status === 'finished') return 100
  if (opts.status !== 'processing') return 0
  // 显式 NaN/缺失守卫：startedAt 缺失 → elapsed=NaN → 整条曲线 NaN，不靠
  // Math.max(0, NaN) 兜底（它返回 NaN 不是 0）。明确返回 0 是「比崩好」的契约。
  if (!Number.isFinite(opts.startedAt) || !Number.isFinite(opts.now)) return 0
  const elapsedSec = Math.max(0, (opts.now - opts.startedAt) / 1000)
  const safeDuration = Number.isFinite(opts.durationSeconds) && opts.durationSeconds > 0
    ? opts.durationSeconds
    : 0
  const tau = Math.max(60, safeDuration * 2)
  // 95 * (1 - e^(-elapsed/τ))
  // - elapsed = τ      → 60.0%
  // - elapsed = 4τ     → 93.3%（即轮询 deadline 处）
  // - elapsed → ∞      → 95%（永不到 100%）
  return Math.round(95 * (1 - Math.exp(-elapsedSec / tau)))
}
```

**为什么渐近**：

- 不撒谎：永远不会显示 99% 然后再卡 5 分钟；
- 视频长度自适应：`durationSeconds` 进 τ，5s 视频和 30min 视频的曲线斜率不同；
- 与轮询节奏解耦：渲染端 `setInterval(1s)` 自己 tick，所以哪怕轮询 60s 才一次，进度条也每秒动；
- `status='finished'` 一到立刻跳 100% 完成绝对真实的尾段。

**否决方案**：

- 「轮询次数线性 `40 + (attempt/120)*50`」（Grid Split 同款）：忽略视频时长，5s 和 30min 视频看起来一样快，违反用户直觉；
- 「时间线性 `elapsed/(duration*4)`」：到达 95% 后就硬卡或硬跳到 99%，欺骗感重；
- 「不要数字、纯不确定型动画」：用户明确要「进度条」，要数字。

### 决策 A2：轮询节奏 = 指数退避 + 60s 上限

```typescript
// src/main/services/smartErase/runner.ts (REPLACE pollIntervalMs)
const POLL_INITIAL_MS = 5_000
const POLL_BACKOFF_FACTOR = 1.4
const POLL_CAP_MS = 60_000

export function pollIntervalMs(attempt: number): number {
  return Math.min(
    POLL_CAP_MS,
    Math.round(POLL_INITIAL_MS * Math.pow(POLL_BACKOFF_FACTOR, attempt - 1)),
  )
}
```

序列（取整）：5s, 7s, 10s, 14s, 20s, 28s, 39s, 55s, 60s, 60s, …

**预期 API 调用次数**：

| 视频时长 | deadline | 现行（5/10/15）| 新（exp 1.4） | 节省 |
|----------|----------|----------------|---------------|------|
| 5s       | 60min    | ~232           | ~62           | 73%  |
| 5min     | 60min    | ~232           | ~62           | 73%  |
| 30min    | 120min   | ~464           | ~123          | 73%  |

注：MPS 任务在 deadline 之前就完成时实际调用次数远少于上表上限。重点是**长任务的尾段不再每 15s 一次**。

不加 jitter（`exp-and-jitter` 选项被否决）。本应用「个人/单租户」场景，一次最多并发 ~3 个 SmartErase（受 `MAX_INFLIGHT = 40` 约束但实际很少打满），轮询同步触发的概率很低，加 jitter 收益不抵代码复杂度。

**否决方案**：

- 「保留分级 5/10/15s」：长视频的尾段单调浪费 API 配额；
- 「指数退避 + jitter」：YAGNI，单租户场景不需要。

### 决策 A3：`processingStartedAt` 字段从哪儿来

进入 `processing` 阶段的瞬间，渲染端给 `EraseTask` 写一次 `processingStartedAt: Date.now()`；后续 ticker 用它算 `elapsed`。

数据流：

```
runner.ts: events.onProgress({ stage: 'processing', mpsTaskId })
  → smartErase/index.ts: safeSend('erase:progress', { taskId, status: 'processing', mpsTaskId })
  → useEraseEvents.ts: when (incoming.status === 'processing' && prev.status !== 'processing')
                       session.updateTaskStatus(..., processingStartedAt: Date.now())
  → useEraseSessionStore.ts: 在 reducer 里 merge 进 task
```

这样**不**让主进程参与 ticker —— 它只发一次「进入处理」事件，渲染端自己起 setInterval。如果用户切到别的 tab 再切回来，时间继续走（`Date.now()` 是绝对时间）。

### 决策 B1：组件拆分

```
SmartErasePage
├── EraseUploader            (unchanged)
├── EraseQueue               (内部行追加进度条；下面详述)
├── EraseResultGrid    NEW   ← 横向滚动一行卡片，替代 EraseResultPanel
│   └── EraseResultCard NEW
├── EraseResultModal   NEW   ← 全屏 modal 容纳视频/对比/下载/复制/移除
└── EraseHistoryDrawer       (unchanged，右抽屉的全量历史保留作为辅助入口)
```

**EraseResultPanel.tsx 删除**，它的所有按钮逻辑（download / copy / remove / compare）搬进 `EraseResultModal.tsx`。

为什么不保留 panel：保留就是两个入口看同一个 item，状态同步成本 + 心智负担都无收益。

**`EraseHistoryDrawer` 联动**：drawer 当前的 item 点击行为 `setSelectedHistoryId` 是给已删除 panel 用的；改为调 `setModalItemId(item.id)` 直接打开 modal。drawer 自己的 `selectedHistoryId` 高亮可保留也可删除（YAGNI 偏向删除——modal 自身就是被选中的视觉信号）。

### 决策 B2：`EraseResultCard` 视觉规格（Grid Split 同款）

固定尺寸 `w-[180px] h-[160px]`（与 `storyboard-split` 历史卡片对齐）：

```
┌────────────────────────────┐  border d-neon-frame · cursor-pointer · hover:ring-1 ring-cyan
│ [完了/DONE]      [6d?]     │  顶栏：完成徽章 (绿) + 过期倒计时徽章 (右)
│                            │
│      <img poster>          │  flex-1 · object-cover · bg-black
│                            │
│ filename.mp4              │  truncate · d-mono text-[11px]
│ 04/30 16:20·0:15·8MB·#a3c │  d-mono text-[10px] text-ink-mute · 文件名后五行
└────────────────────────────┘
```

字段（用户的 A+B 选择 = minimal + rich 全要）：

| 字段 | 来源 | 显示规则 |
|------|------|----------|
| 完成徽章 | 总是 | `[ 完了 / DONE ]` 绿色 pill |
| 过期徽章 | `videoExpiresAt - now` | `> 1d`：`[ 6d ]` 灰；`< 24h`：`[ 4h ]` 黄；`< 0`：`[ 已过期 ]` 红 |
| 缩略图 | `posterDataUrl` | `<img>` filling，无 src 时占位黑底 |
| 文件名 | `filename` | `truncate max-w-full` |
| 时间 | `finishedAt` | `MM/DD HH:mm` |
| 时长 | `durationSeconds` | `formatDuration` 重用现有函数 |
| 大小 | `fileSize` | `formatBytes` 重用 |
| mpsTaskId 末尾 | `mpsTaskId.slice(-6)` | 前缀 `#` 视觉化「任务编号」 |

a11y：整张卡是 `<button type="button">`（不是 `<div onClick>`），`aria-label="查看 ${filename} 处理结果"`，自动有键盘 focus。

### 决策 B3：`EraseResultGrid` 行为

- 数据源：`history`（持久化）+ `recentlyFinished`（session）合并去重，按 `finishedAt` desc。
- 容器 `flex gap-3 overflow-x-auto pb-2`，最右侧不要 fade-mask（保持极客像素感与 Grid Split 一致）。
- 空状态：返回 `null`（不占布局）；与 `EraseQueue.tsx` 空状态行为一致。
- `recentlyFinished` 高亮：被命中的卡片 5s 内多一圈 `ring-2 ring-green ring-offset-2`，5s 后清掉（重用现有 `useEraseSessionStore.recentlyFinished` 状态 + 设置 timer）。

### 决策 B4：`EraseResultModal`

- 语义：`<dialog>` 元素 + `useEffect(() => dialog.showModal(), [open])`；不用 `<div role="dialog">` 因为 `<dialog>` 自带 ESC 关闭、焦点 trap、background scroll lock。
- 视觉：背景 `bg-black/85 backdrop-blur-sm`，内容 `max-w-[1000px] mx-auto`，视频区 `max-h-[60vh] object-contain w-full bg-black`。
- 点击 backdrop（`<dialog>` 本体）关闭，内容区 `onClick={(e) => e.stopPropagation()}`。
- 工具栏按 spec 顺序：`[ 对比 ] [ 下载 ] [ 复制 URL ] [ 移除历史 ]`（最后一个 `ml-auto`）。
- 对比模式：迁移（不是复用——panel 会被删）现有 `EraseResultPanel` 的 `grid-cols-2` 布局到 modal 内部，两个 video 都 `max-h-[60vh] object-contain`，宽度自动填半。

### 决策 B5：状态：`modalItemId` 进 session store

```typescript
// useEraseSessionStore.ts (ADD)
modalItemId: string | null
setModalItemId: (id: string | null) => void
```

不进持久化 store。关闭 modal、切 tab、刷新都会清。

`EraseResultCard.onClick` → `setModalItemId(item.id)`。

`EraseResultModal` 自己读：`history.find(h => h.id === modalItemId)`，返回 `null` 则不渲染。

## 数据流：进度条端到端

```
[main]
runProcessAndPoll() loop
  ├─ 上传完成      → events.onProgress({ stage: 'submitting' })
  ├─ ProcessMedia 返回 → events.onProgress({ stage: 'processing', mpsTaskId })
  └─ poll 循环 (exp backoff)
                  → 不再重复发 stage='processing' 事件，无 progress payload

[ipc]
safeSend('erase:progress', {
  taskId, status,
  uploadProgress?,    // 已有
  mpsTaskId?,         // 已有
  // 注意：processingProgress 不通过 IPC 传，渲染端自己算
})

[renderer]
useEraseEvents.ts
  on 'erase:progress' →
    if (data.status === 'processing' && prevStatus !== 'processing')
      session.updateTaskStatus(taskId, status, ..., { processingStartedAt: Date.now() })
    else session.updateTaskStatus(...)

EraseQueue.tsx
  useTicker(intervalMs=1000) → 每秒 setNow(Date.now())
  for each task in 'processing' status
    barPercent = computeProcessingProgress({ startedAt, durationSeconds, status, now })
  for each task in 'uploading' status
    barPercent = task.uploadProgress ?? 0
```

`useTicker` 是个轻量 hook（10 行）：仅当 store 中有 `processing` 任务时才启 interval；没有时停掉，避免空 tick。

## 错误处理

| 场景 | 处理 |
|------|------|
| `durationSeconds <= 0`（probe 失败但仍 submit） | `tau = max(60, 0)` = 60s，曲线还是会动；视频时长当 0 处理 |
| `processingStartedAt` 缺失（极边缘 race） | `now - undefined → NaN`，computeProcessingProgress 返回 0；进度条停在 0%，比崩好 |
| MPS 提前完成（曲线还在 30%） | status 切到 'finished' → 函数直接返回 100，CSS transition 平滑跳到 100% |
| MPS 超过 deadline | 现有 `POLL_TIMEOUT` 路径不变；任务进入 'failed'，进度条变红 + 文字「失败」 |
| `videoExpiresAt < now`（卡片显示中过期） | 徽章变 `[ 已过期 ]` 红色；点击卡片仍能进 modal，但播放/下载按钮 `disabled` 加 toast「URL 已过期」 |
| Modal 内 ESC 关闭 + 任务还在跑 | 任务不受影响（只是 UI 关掉），下次点对应卡片照常 |

## 测试

新增 / 修改：

| 文件 | 类型 | 验证 |
|------|------|------|
| `src/renderer/.../eraseProgress.test.ts` (NEW) | unit | `finished→100`, `queued→0`, `now<startedAt→0` (clamp), `startedAt=undefined→0` (NaN 守卫), `durationSeconds=0→tau=60` floor; **τ 自适应锚点**：5s 视频 elapsed=60s → ≈60%（elapsed=τ 处），5min 视频 elapsed=10min → ≈60%（同样 elapsed=τ 处），证明 τ 跟视频长度走 |
| `src/main/.../runner.test.ts` (EDIT) | unit | `pollIntervalMs(1)===5000`, `pollIntervalMs(2)===7000`, `pollIntervalMs(10)===60000`（cap 命中），`pollIntervalMs(20)===60000`（仍 cap） |
| `src/renderer/.../EraseResultCard.test.tsx` (NEW) | RTL | 渲染完成徽章；过期倒计时 6d/4h/已过期 三态切换；`onClick` 触发 `setModalItemId(id)` |
| `src/renderer/.../EraseQueue.test.tsx` (NEW) | RTL | uploading 行 width === uploadProgress%；processing 行随时间推移 width 增大 (`vi.useFakeTimers + advanceTimersByTime`) |

不写 modal 自身的 RTL 测试 —— `<dialog>` + jsdom 兼容性差，Phase 8 已有的 EraseResultPanel 测试其实因此跳过，沿用既定决策。

## 文件影响清单

**新增 (5)**：
- `src/renderer/src/pages-react/smart-erase/eraseProgress.ts`
- `src/renderer/src/pages-react/smart-erase/EraseResultCard.tsx`
- `src/renderer/src/pages-react/smart-erase/EraseResultGrid.tsx`
- `src/renderer/src/pages-react/smart-erase/EraseResultModal.tsx`
- `src/renderer/src/pages-react/smart-erase/eraseProgress.test.ts`

**修改 (8)**：
- `src/types/smartErase.ts`：`EraseTask` 加 `processingStartedAt?: number`
- `src/main/services/smartErase/runner.ts`：替换 `pollIntervalMs`，更新内部常量；删 `FAST_THRESHOLD / MED_THRESHOLD / POLL_INTERVAL_FAST_MS / POLL_INTERVAL_MED_MS / POLL_INTERVAL_SLOW_MS`
- `src/main/services/smartErase/runner.test.ts`：替换分级测试为指数退避测试
- `src/renderer/src/stores/useEraseSessionStore.ts`：加 `modalItemId / setModalItemId`；将 `updateTaskStatus` 改为接收一个可选的 `patch: Partial<EraseSessionTask>` 第三参数（替代当前的位置参数 `uploadProgress, mpsTaskId`），让 `processingStartedAt` 自然加入而无需再扩展签名
- `src/renderer/src/pages-react/smart-erase/EraseQueue.tsx`：行内追加进度条 div，引入 `useTicker` 与 `computeProcessingProgress`
- `src/renderer/src/pages-react/smart-erase/useEraseEvents.ts`：(1) 在 `processing` 转换时写 `processingStartedAt: Date.now()`；(2) 跟随 `updateTaskStatus` 签名变更
- `src/renderer/src/pages-react/smart-erase/EraseHistoryDrawer.tsx`：item 点击改为调 `setModalItemId(item.id)` 而不是 `setSelectedHistoryId`
- `src/renderer/src/pages-react/SmartErasePage.tsx`：替换 `<EraseResultPanel />` 为 `<EraseResultGrid /> <EraseResultModal />`

**删除 (1)**：
- `src/renderer/src/pages-react/smart-erase/EraseResultPanel.tsx`（迁移完成后）

## Out of Scope

- 真正的 MPS 实时进度（API 不支持，已经验证）
- 视频内嵌字幕翻译预览（MVP 范围之外）
- Modal 中视频拖拽进度条预览（浏览器自带 controls 已足够）
- 卡片右键菜单（YAGNI；按钮已经齐全）
- jitter（决策 A2 已否决）
- IPC 推送 `processingProgress` 数字（决策 A3 已论证渲染端自算更优）

## 已知风险 + 缓解

| 风险 | 概率 | 缓解 |
|------|------|------|
| `<dialog>` 在 Electron Chromium 旧版本不支持 | 极低（Electron ≥ 110 原生支持） | 验证当前 electron 版本；不行就回退到 `role="dialog"` + 手动 ESC |
| `useTicker` 内存泄漏（unmount 不清 interval） | 中 | hook 内 `useEffect` 必须 return cleanup |
| 渐近曲线 `e^(-elapsed/τ)` 在 elapsed 极大时数值下溢 | 极低 | 数学上下溢到 0，95×1=95，不影响 |
| `modalItemId` 指向已删除的 history item | 低 | modal 渲染时 `find` 返回 undefined → 不渲染，自动正确 |

---


---
date: 2026-04-30
topic: smart-erase-progress-and-cards
---

# 智能去字幕 — 处理进度条 + 结果卡片化设计

## What We're Building

延续 [2026-04-29 智能去字幕 MVP](../plans/2026-04-29-smart-erase-feature.md)（已交付）的两点 UX 修复：

1. **A · 处理进度条**：MPS 处理阶段（占 0–95%）显示一个会动的进度条，并把轮询节奏从「分级 5/10/15s」换成「指数退避 + 上限 60s」，长视频的 API 调用次数下降 **~74%**（原版 ~254 次 → 新版 ~65 次，60min deadline）。
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
  // 显式 NaN/缺失守卫：startedAt 缺失 → elapsed=NaN → 95×(1-e^NaN)=NaN，
  // 不依赖任何下游 clamp。返回 0 是「比崩好」的契约。
  if (!Number.isFinite(opts.startedAt) || !Number.isFinite(opts.now)) return 0
  const elapsedSec = Math.max(0, (opts.now - opts.startedAt) / 1000)
  const safeDuration = Number.isFinite(opts.durationSeconds) && opts.durationSeconds > 0
    ? opts.durationSeconds
    : 0
  // τ = max(15, dur*2)：15s 下限（不是 60s）专门服务短视频。
  // - 5s 视频  (τ=15)  : elapsed=15s → 60%, elapsed=30s → 82%。MPS 通常 ~25s 完成
  //   → 跳变约 18%（旧 60s 下限会跳 60%+）。
  // - 60s 视频 (τ=120) : elapsed=240s = 2τ → 82%。
  // - 30min 视频 (τ=3600): elapsed=60min = 1τ → 60%。τ 跟视频长度走，长视频曲线更慢。
  const tau = Math.max(15, safeDuration * 2)
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

序列（实际算法值，毫秒精度）：5000ms, 7000ms, 9800ms, 13720ms, 19208ms, 26891ms, 37648ms, 52707ms, 60000ms, 60000ms, … （即 5.0, 7.0, 9.8, 13.7, 19.2, 26.9, 37.6, 52.7, 60.0, 60.0 …秒）

**预期 API 调用次数**（deadline 兜底场景，即任务跑满到 timeout 才会触达）：

| 视频时长 | deadline | 现行（5/10/15）| 新（exp 1.4 cap 60s） | 节省 |
|----------|----------|----------------|------------------------|------|
| 5s/5min  | 60min    | ~254           | ~65                    | ~74% |
| 30min    | 120min   | ~494           | ~125                   | ~74% |

**计算依据**：
- 现行 5/10/15s 分级（`runner.ts` 当前实现 FAST_THRESHOLD=30s, MED_THRESHOLD=5min）：60min deadline = `6×5s + 30×10s + 218×15s = 254` 次。
- 新版 exp(1.4) 60s cap：前 8 次累计 172s，剩余 (3600-172)/60 = 57 次，总计 65 次。

注：MPS 任务在 deadline 之前完成时实际调用次数远少于上表上限。重点是**长任务的尾段不再每 15s 一次**。

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

这样**不**让主进程参与 ticker —— 它只发一次「进入处理」事件，渲染端自己起 setInterval。

**架构依赖（必须显式记录）**：本设计依赖现有的 React 挂载策略——`src/renderer/src/react-app/main.tsx:238-260` 的 `mountSmartEraseReact` 是「首次挂载 + 之后只切 `display:none`」，所以 `SmartErasePage`（以及它内部的 `useEraseEvents`）**不会因为切 tab 而 unmount**。如果未来有人把这个挂载方式改成标准 React tab 切换（unmount/remount），`useEraseEvents` 会在切走时 `removeSmartEraseListeners` 取消订阅，主进程的 `erase:finished` / `erase:failed` 事件会被丢失，**新进度条会被永远卡在 95% 上**（曲线渐近永不到 100%，状态也永不会切到 `'finished'`）。

加固方式（如果将来确实要改成 unmount 模式）：把 `useEraseEvents` 调用从 `SmartErasePage` 提到 `react-app/main.tsx` 的全局挂载点（与 `mountGlobalToast` 同级），或加 `smart-erase:get-active-state` IPC 在重新挂载时对账。当前 MVP+1 不做这个加固——文档此约束 + 在 `useEraseEvents.ts` 顶部留 `// CRITICAL: do not move; see decisions A3` 注释即可。

### 决策 B1：组件拆分 & Grid/Drawer 角色分工

```
SmartErasePage
├── EraseUploader            (unchanged)
├── EraseQueue               (内部行追加进度条；下面详述)
├── EraseResultGrid    NEW   ← 横向滚动一行卡片（最多展示最近 12 条）
│   └── EraseResultCard NEW
├── EraseResultModal   NEW   ← 全屏 modal 容纳视频/对比/下载/复制/移除
└── EraseHistoryDrawer       (保留，重新定位为「历史管理 UI」，详见下方角色分工)
```

**EraseResultPanel.tsx 删除**，它的所有按钮逻辑（download / copy / remove / compare）搬进 `EraseResultModal.tsx`。

为什么不保留 panel：保留就是两个入口看同一个 item，状态同步成本 + 心智负担都无收益。

**Grid vs Drawer 角色分工**（必须明确，否则两个 UI 看同一份数据会成 bit-rot 温床）：

| 维度 | `EraseResultGrid`（新） | `EraseHistoryDrawer`（保留） |
|------|-----------------------|------------------------------|
| 定位 | **结果查看入口**——刚处理完的视频「就近回看」 | **历史管理 UI**——批量删除、清理 COS |
| 显示范围 | `history.slice(0, 12)`（最近 12 条） | 全量 `history` |
| 卡片尺寸 | 180×160（详见 §B2） | 64×36 缩略图（不变） |
| 触发 | 总是显示在页面 inline | 通过右上角「历史」按钮打开 |
| 主要交互 | 点卡片 → 打开 modal 看视频 | 点条目 → 打开 modal 看视频；右侧 [×] 删除；底部清空 |

关键约束：**两个组件都点击进同一个 modal**（`setModalItemId`），所以「正在看哪一项」是同一个事实。历史记录管理（删/清空 + COS 清理）只在 drawer 里出现，避免功能在 grid 上重复。

**`EraseHistoryDrawer` 联动改造**：
- drawer 当前的 item 点击 `setSelectedHistoryId(h.id) + toggle()` 改为 `setModalItemId(h.id) + toggle()`：drawer 关闭、modal 打开（参考 `EraseHistoryDrawer.tsx:96-99`）。
- **保留** `selectedHistoryId` 字段并复用为「当前 modal 显示的 item」高亮信号——`setModalItemId(x)` 同步写 `selectedHistoryId = x`，`setModalItemId(null)` 同步写 `selectedHistoryId = null`。Drawer 的现有 highlight 语义（`HistoryRow`：`selected={h.id === selectedId}`）继续工作，用户重开 drawer 时能直接看到「上一次看的是哪条」。
- 这样不删除任何 store 字段，drawer 高亮路径不需要重写——只是把单一 setter 替换成「modalItemId 是真相，selectedHistoryId 是它的镜像」。

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

**关闭契约（必须显式）**：所有关闭路径**必须**最终调用 `setModalItemId(null)`，否则会出现「点同一张卡再也打不开」的 bug——因为 `useEffect(() => dialog.showModal(), [modalItemId])` 仅在依赖变化时触发，已有值不变就不重新调用。三条关闭路径：

1. **ESC** —— 监听 `dialog.addEventListener('close', () => setModalItemId(null))`（`<dialog>` 在 ESC 时自动 `close` 事件）。
2. **点击 backdrop** —— `onClick={(e) => { if (e.target === dialogRef.current) dialogRef.current.close() }}`，由 #1 的 `close` 事件统一收尾。
3. **点击 [×] / 工具栏「关闭」按钮** —— `dialog.close()`，同样靠 #1 收尾。

把 `close` 事件作为唯一的状态收尾点（single source of truth），避免「ESC 走一条路、按钮走另一条路」造成的状态漂移。

### 决策 B5：状态：`modalItemId` 进 session store

```typescript
// useEraseSessionStore.ts (ADD)
modalItemId: string | null
setModalItemId: (id: string | null) => void  // 同时写 selectedHistoryId（见 §B1）
```

**生命周期**（修正 — 不进持久化 store **不等于** 切 tab 会清）：

- `useEraseSessionStore` 是普通 `create()`（无 persist 中间件），存在于 module scope。
- 应用内切 tab → 现有挂载策略是 `display:none` 而非 unmount（见 §A3 架构依赖）→ store **不会**被清。
- 完整页面刷新 / 应用重启 → store 重建为初始 `null` → modal 不会被复活。

所以 `modalItemId` 的生命周期 = **会话生命周期**。这意味着 §B4 的关闭契约**必须** authoritative ——一旦 modal 关闭（任何路径），`modalItemId` 必须立即归 `null`，否则切 tab 回来后已关闭的 modal 可能因为 React 的 `useEffect([modalItemId])` 重新评估而被错误重开（具体行为依赖 React 重渲染时机，不要依赖）。

`EraseResultCard.onClick` → `setModalItemId(item.id)`（同时镜像写 `selectedHistoryId`，见 §B1）。

`EraseResultModal` 自己读：`history.find(h => h.id === modalItemId)`，返回 `null` 则不渲染（防止 `modalItemId` 指向已删除的 history item）。

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
    const patch: Partial<EraseSessionTask> = {
      uploadProgress: data.uploadProgress,
      mpsTaskId: data.mpsTaskId,
    }
    if (data.status === 'processing' && prevStatus !== 'processing')
      patch.processingStartedAt = Date.now()
    session.updateTaskStatus(taskId, status, patch)

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
| `durationSeconds <= 0`（probe 失败但仍 submit） | `tau = max(15, 0)` = 15s，曲线照常动（短视频锚点）；视频时长当 0 处理 |
| `processingStartedAt` 缺失（极边缘 race） | `now - undefined → NaN`，computeProcessingProgress 返回 0；进度条停在 0%，比崩好 |
| MPS 提前完成（曲线还在 30%） | status 切到 'finished' → 函数直接返回 100，CSS transition 平滑跳到 100% |
| MPS 超过 deadline | 现有 `POLL_TIMEOUT` 路径不变；任务进入 'failed'，进度条变红 + 文字「失败」 |
| `videoExpiresAt < now`（卡片显示中过期） | 徽章变 `[ 已过期 ]` 红色；点击卡片仍能进 modal，但播放/下载按钮 `disabled` 加 toast「URL 已过期」 |
| Modal 内 ESC 关闭 + 任务还在跑 | 任务不受影响（只是 UI 关掉），下次点对应卡片照常 |

## 测试

新增 / 修改：

| 文件 | 类型 | 验证 |
|------|------|------|
| `src/renderer/.../eraseProgress.test.ts` (NEW) | unit | `finished→100`, `queued→0`, `now<startedAt→0` (clamp), `startedAt=undefined→0` (NaN 守卫), `durationSeconds=0→tau=15` floor 锚点：elapsed=15s → 60%；**τ 自适应锚点**：5s 视频 (τ=15) elapsed=15s → 60%（即 elapsed=τ 处），5min 视频 (τ=600) elapsed=600s → 60%（同样 elapsed=τ 处），证明 τ 跟视频长度走且短视频曲线更敏感 |
| `src/main/.../runner.test.ts` (EDIT) | unit | `pollIntervalMs(1)===5000`, `pollIntervalMs(2)===7000`, `pollIntervalMs(3)===9800`, `pollIntervalMs(5)===19208`（验证毫秒精度，不是秒-rounding），`pollIntervalMs(10)===60000`（cap 命中），`pollIntervalMs(20)===60000`（仍 cap） |
| `src/renderer/.../EraseResultCard.test.tsx` (NEW) | RTL | 渲染完成徽章；过期倒计时 6d/4h/已过期 三态切换；`onClick` 触发 `setModalItemId(id)`（同时镜像写 `selectedHistoryId`） |
| `src/renderer/.../EraseResultModal.test.tsx` (NEW) | RTL（依赖上方 polyfill） | (1) `modalItemId='x'` 后 `dialog.open===true`；(2) ESC / backdrop 点击 / [×] 按钮三条路径都触发 `close` 事件；(3) `close` 事件统一调 `setModalItemId(null)`；(4) 已删除的 item 渲染为 `null` |
| `src/renderer/.../EraseQueue.test.tsx` (NEW) | RTL | uploading 行 width === uploadProgress%；processing 行随时间推移 width 增大 (`vi.useFakeTimers + advanceTimersByTime`) |
| Playwright e2e 追加 | e2e | 现有 "drop mp4 → see result" 之后追加：点击 grid 卡片 → modal 打开 → ESC → modal 关闭 |

**Modal 测试覆盖（修正：不再「全部跳过」）**：jsdom 27.4.0 确实不实现 `HTMLDialogElement.prototype.showModal/close`，但有 8 行 polyfill 即可解决：

```typescript
// vitest.setup.ts (NEW —— 在 vitest config 的 setupFiles 中加载)
if (typeof HTMLDialogElement !== 'undefined') {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () { this.open = true }
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.open = false
      this.dispatchEvent(new Event('close'))
    }
  }
}
```

新增 `EraseResultModal.test.tsx` (RTL): 验证 (1) `setModalItemId('x')` 后 dialog `open=true`；(2) `setModalItemId(null)` / 触发 `close` 事件后 `open=false`；(3) close 路径必然走 `setModalItemId(null)`（监视 store）。Polyfill 不模拟焦点 trap / 真正的 ESC 行为——这些靠 `<dialog>` 原生 + 一条 Playwright e2e（"drop mp4 → click thumbnail → modal opens → ESC closes" 一条断言追加到现有 e2e）兜底。

## 文件影响清单

**新增 (6)**：
- `src/renderer/src/pages-react/smart-erase/eraseProgress.ts`
- `src/renderer/src/pages-react/smart-erase/eraseProgress.test.ts`
- `src/renderer/src/pages-react/smart-erase/EraseResultCard.tsx`
- `src/renderer/src/pages-react/smart-erase/EraseResultGrid.tsx`
- `src/renderer/src/pages-react/smart-erase/EraseResultModal.tsx`
- `vitest.setup.ts`（如不存在；含 `<dialog>` polyfill 见 §测试）

**修改 (9)**：
- `src/types/smartErase.ts`：`EraseTask` 加 `processingStartedAt?: number`
- `src/main/services/smartErase/runner.ts`：替换 `pollIntervalMs`（改为 `5000 * 1.4^(n-1)` cap 60s）；删 `FAST_THRESHOLD / MED_THRESHOLD / POLL_INTERVAL_FAST_MS / POLL_INTERVAL_MED_MS / POLL_INTERVAL_SLOW_MS`
- `src/main/services/smartErase/runner.test.ts`：替换分级测试为指数退避测试（具体值见 §测试）
- `src/renderer/src/stores/useEraseSessionStore.ts`：(1) 加 `modalItemId / setModalItemId`，setter **必须**同时镜像写 `selectedHistoryId`（详见 §B1）；(2) 将 `updateTaskStatus` 第三参数从 `uploadProgress?: number, mpsTaskId?: string` 改为 `patch?: Partial<EraseSessionTask>`，让 `processingStartedAt` 自然加入。更新唯一 caller（`useEraseEvents.ts`，已 grep 确认无其他 caller）。
- `src/renderer/src/pages-react/smart-erase/useEraseEvents.ts`：(1) 顶部加 `// CRITICAL: do not move; see decisions A3` 注释；(2) 在 `processing` 转换时写 `processingStartedAt: Date.now()`；(3) 跟随 `updateTaskStatus` 签名变更
- `src/renderer/src/pages-react/smart-erase/EraseQueue.tsx`：行内追加进度条 div，引入 `useTicker` 与 `computeProcessingProgress`
- `src/renderer/src/pages-react/smart-erase/EraseHistoryDrawer.tsx`：item 点击 `setSelectedHistoryId` → `setModalItemId`（保留 `toggle()` 关闭抽屉，避免抽屉与 modal 视觉重叠）；highlight 路径不变（依赖 `selectedHistoryId` 镜像）
- `src/renderer/src/pages-react/SmartErasePage.tsx`：替换 `<EraseResultPanel />` 为 `<EraseResultGrid /> <EraseResultModal />`
- `electron.vite.config.ts` 或 `vitest.config.ts`：把 `vitest.setup.ts` 加进 `test.setupFiles`（若已存在 setup 则追加 polyfill）

**删除 (1)**：
- `src/renderer/src/pages-react/smart-erase/EraseResultPanel.tsx`（仅在迁移最后一步删除——见下方实施顺序）

## 实施顺序（保持每一步 build 绿）

破坏顺序会让中间步骤 typecheck 失败。按以下编号严格执行：

1. **基础设施**（不依赖任何旧代码删除）：
   1. 加 `eraseProgress.ts` + `eraseProgress.test.ts`
   2. 加 `vitest.setup.ts` + 配置 `setupFiles`
   3. `src/types/smartErase.ts` 加 `processingStartedAt?: number`
2. **store 重构**：
   4. 改 `useEraseSessionStore.ts`：加 `modalItemId / setModalItemId`，重做 `updateTaskStatus` 签名
   5. 同步改 `useEraseEvents.ts`（唯一 caller）跟随新签名 + 写 `processingStartedAt`
3. **新组件**（暂不接入，build 绿）：
   6. 加 `EraseResultCard.tsx` + 测试
   7. 加 `EraseResultGrid.tsx`
   8. 加 `EraseResultModal.tsx` + 测试
4. **接入新组件**：
   9. 改 `EraseHistoryDrawer.tsx`：rewire 到 `setModalItemId + toggle()`
   10. 改 `SmartErasePage.tsx`：删 `<EraseResultPanel />` 引用 + import，加 `<EraseResultGrid /> <EraseResultModal />`
   11. 此时手动 smoke：`npm run dev` → 上传 → 等完成 → 点 grid 卡片 → modal → ESC
5. **进度条 + 轮询**（与 1-4 完全独立，可并行做或最后做）：
   12. 改 `EraseQueue.tsx`：接入 `useTicker` + `computeProcessingProgress`
   13. 改 `runner.ts`：替换 `pollIntervalMs`
   14. 改 `runner.test.ts`：换测试断言
6. **清理**（必须最后做）：
   15. 删 `EraseResultPanel.tsx`（此时已无 import 引用）
   16. `npm run typecheck && npm run test:run` 全绿后提交

## Out of Scope

- 真正的 MPS 实时进度（API 不支持，已经验证）
- 视频内嵌字幕翻译预览（MVP 范围之外）
- Modal 中视频拖拽进度条预览（浏览器自带 controls 已足够）
- 卡片右键菜单（YAGNI；按钮已经齐全）
- jitter（决策 A2 已否决）
- IPC 推送 `processingProgress` 数字（决策 A3 已论证渲染端自算更优）
- **Windows 任务栏进度集成**（`mainWindow.setProgressBar()`）：当前不做。如果将来要做，主进程需要持有进度数字——届时主进程持有「权威」，渲染端镜像，而不是反过来。本设计不为此做提前抽象。
- 主进程→渲染端 active-task 重启对账 IPC：见 §A3，依赖现有 display:none 挂载模式即可，不加 `smart-erase:get-active-state`。

## 已知风险 + 缓解

| 风险 | 概率 | 缓解 |
|------|------|------|
| `<dialog>` 在当前 Electron 不支持 | 0 | 已验证：`package.json:90` `electron@^41.2.1` → 内嵌 Chromium 138；`<dialog>.showModal()` 在 Chromium 37 (2014) 起原生支持。不需要 fallback。 |
| jsdom 缺 `HTMLDialogElement.showModal/close` | 高（已知） | 用 §测试 中 8 行 polyfill 覆盖，焦点 trap / ESC 走 Playwright e2e |
| `useTicker` 内存泄漏（unmount 不清 interval） | 中 | hook 内 `useEffect` 必须 return cleanup（详见 §数据流） |
| `modalItemId` 不归 null → 同卡不能再开 | 中 | §B4 关闭契约：`close` 事件作为唯一收尾点，必然 `setModalItemId(null)` |
| 用户切 tab 期间 `useEraseEvents` 取消订阅，丢 `erase:finished` 事件，新进度条卡 95% | **当前为 0**（依赖 §A3 的 display:none 挂载策略），未来重构挂载方式可能复活 | §A3 架构依赖；`useEraseEvents.ts` 顶部加 `// CRITICAL: do not move; see decisions A3` 注释；将来真要改 unmount 时把 `useEraseEvents` 提到 `react-app/main.tsx` 全局挂载点 |
| `modalItemId` 指向已删除的 history item | 低 | modal 渲染时 `find` 返回 undefined → 不渲染，自动正确 |
| 渐近曲线 `e^(-elapsed/τ)` 数值下溢 | 结构性不可达（>12h 才到 underflow，POLL_TIMEOUT 已先生效） | 数学上下溢到 0，95×1=95，不影响 |

---


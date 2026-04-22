# 宫格拆图 UI/UX 重构规格书

> 日期: 2026-04-22  
> 状态: APPROVED — 可开始实施  
> 相关页面: `StoryboardSplitPage` (`#storyboardSplit` tab)

---

## 1. 目标

将当前"宫格拆图"页面从基础功能态提升至与 History 页 (donor-theme) 一致的视觉品质和交互能力:

- **预览**: 全屏 lightbox, SINGLE/GRID 双模式
- **下载**: 单图保存 + 单任务 ZIP 打包
- **删除**: 本地即时 + COS 后台静默清理
- **视觉**: 全面 donor-theme 赛博朋克风

---

## 2. 设计决定汇总 (Q1–Q10)

| # | 问题 | 决定 | 关键影响 |
|---|------|------|---------|
| Q1 | 完成态呈现 | DonorCard 风 + 列数可调 | 视觉与历史页统一 |
| Q2 | 批量下载粒度 | 单任务整包 ZIP | 不做跨任务多选 |
| Q3 | 预览灯箱 | 派生 SplitPreview | Portal/键盘/CORS 降级一致 |
| Q4 | 网格选项 | 仅列数: 2/3/4/6 | 简单粗暴 |
| Q5 | 历史抽屉 | 同步升级 donor-theme | 整页风格闭环 |
| Q6 | 完成数据归属 | 完成 → auto spawn 到 persist.history, session 仅留 active + recentlyFinished(3s) | 单一数据源 |
| Q7 | 进行中 vs 完成组件 | 拆成 ActiveQueueItem + SplitResultCard | 两种形态独立演化 |
| Q8 | gridCols 存储 | persist (持久化) | 下次打开记住 |
| Q9 | 列数选择器位置 | 顶部 SplitHeader `[ 2 \| 3 \| 4 \| 6 ]` 按钮组 | 一目了然 |
| Q10 | 删除语义 | 本地删除立即 + COS 后台静默清理 (失败不阻塞) | 干净不卡 |

---

## 3. 状态架构

### 3.1 useSplitSessionStore (内存, 关页即丢)

```typescript
interface SplitSessionState {
  activeTasks: SplitTask[]          // 仅 status ∈ {pending,queued,uploading,submitted,processing}
  recentlyFinished: string | null   // 最近完成的 history item id, 3s 后清空
  selectedHistoryId: string | null  // 当前预览的 history item id
  previewMode: 'single' | 'grid'   // 预览模式
  previewIndex: number              // 当前预览子图索引 (SINGLE 模式)

  // actions
  addTask: (task: SplitTask) => void
  removeActiveTask: (taskId: string) => void
  updateTaskProgress: (taskId: string, status, progress, stage?) => void
  failTask: (taskId: string, error: string, errorCode?: string) => void
  cancelTask: (taskId: string) => void
  clearImageData: (taskId: string) => void
  setRecentlyFinished: (id: string | null) => void
  setSelectedHistoryId: (id: string | null) => void
  setPreviewMode: (mode: 'single' | 'grid') => void
  setPreviewIndex: (index: number) => void
}
```

**关键变化 (vs 现有):**
- `tasks` → `activeTasks` (语义更清晰)
- 移除 `finishTask` (完成态不再留在 session)
- 移除 `drawerOpen` (移至 persist)
- 移除 `reopenHistory` (不再需要, 完成卡直接从 persist 读)
- 新增 `recentlyFinished`, `selectedHistoryId`, `previewMode`, `previewIndex`

### 3.2 useSplitPersistStore (electron-store, 持久化)

```typescript
interface SplitPersistState {
  history: SplitHistoryItem[]
  defaultConfig: SplitConfig
  gridCols: 2 | 3 | 4 | 6          // 新增 (default=3)
  historyDrawerOpen: boolean        // 新增 (从 session 迁入)

  // actions
  pushHistory: (item: SplitHistoryItem) => void
  removeHistory: (id: string) => void
  clearHistory: () => void
  updateDefaultConfig: (config: SplitConfig) => void
  setGridCols: (n: 2 | 3 | 4 | 6) => void
  toggleHistoryDrawer: () => void
}
```

**关键变化 (vs 现有):**
- 新增 `gridCols`, `historyDrawerOpen`
- `partialize` 需要包含这两个新字段

### 3.3 SplitHistoryItem 类型 (扩展)

```typescript
// src/types/storyboardSplit.ts — 更新
export interface SplitHistoryItem {
  id: string                  // 复用 task.id (uuid)
  filename: string            // 原文件名 (去扩展名用于 ZIP 命名)
  thumbnailDataUrl: string    // ≤25KB 极小预览
  config: SplitConfig         // 配置快照
  results: SplitResult[]      // 子图 URL + cosPath
  createdAt: number
  finishedAt: number
  // 以下新增:
  coverUrl?: string           // 输入图 COS URL (可选, 用于卡封面, 比 thumbnail 清晰)
  inputCosKey?: string        // 输入图 COS Key (删除时需要, R3 审阅新增)
  rows?: number               // 拆分行数
  cols?: number               // 拆分列数
}
```

### 3.4 不变式

1. 任何时刻一个 task 只在一个 store: 进行中→session.activeTasks; 完成→persist.history
2. session 不存 dataUrl (仅 thumbnailDataUrl)
3. persist 只存 URL, 不存 base64
4. 预览/下载/历史抽屉统一从 persist.history 取数据
5. 完成事件: 先 pushHistory 后 removeActiveTask (避免"任务消失一帧"竞态)

---

## 4. 组件结构

```
StoryboardSplitPage  (DonorShell 包裹, donor-theme 全宽)
├── SplitHeader           ← 新增
│   ├── 标题 "宫格拆图 / GRID.SPLIT"
│   ├── 凭证状态徽章 (d-status-tag)
│   ├── 列数选择器 [ 2 | 3 | 4 | 6 ]
│   └── HISTORY (N) 按钮 → toggleHistoryDrawer
│
├── DefaultsBar           ← 保留, 样式升级
│   └── d-neon-frame 边框, d-mono 字体
│
├── Dropzone              ← 保留, 样式升级
│   └── d-neon-frame 切角面板, 品红×青双层边框
│
├── ActiveQueue           ← 新增 (进行中区)
│   └── ActiveQueueItem × N
│       ├── 文件名 + 进度条 (d-scan-bar 风格)
│       ├── 阶段文字 (uploading-cos → polling-mps)
│       └── [ CANCEL ] 按钮
│   (无任务时整块折叠不占位)
│
└── ResultsGrid           ← 新增 (完成卡区)
    ├── grid-cols-{2|3|4|6} 由 persist.gridCols 驱动
    └── SplitResultCard × N
        ├── 封面图 (首张子图 URL)
        ├── ×N 角标 (子图数量)
        ├── 文件名 + 时间
        ├── 高亮条件: item.id === session.recentlyFinished
        └── hover 操作栏:
            ├── [ VIEW ]     → openPreview
            ├── [ SAVE.ZIP ] → zipDownload
            └── [ DELETE ]   → removeHistory + COS 清理

SplitPreview              ← 新增 (全屏 Portal lightbox)
├── 条件渲染: session.selectedHistoryId !== null
├── 数据源: persist.history.find(h => h.id === selectedHistoryId)
├── 头部:
│   ├── ● PREVIEW 标签
│   ├── #ID 编号
│   ├── 模式切换: [ SINGLE ] [ GRID ]
│   └── [ ESC ] 关闭
├── SINGLE 模式:
│   ├── 大图展示 + 左右翻页 (←→ 键)
│   ├── 底部缩略图轨道
│   └── 操作: [ SAVE.IMG ] [ SAVE.ZIP ] [ OPEN.URL ]
└── GRID 模式:
    ├── 按原拆分布局平铺
    └── 点任意子图回到 SINGLE 该索引

HistoryDrawer             ← 重写 (donor-theme 抽屉)
├── 开关: persist.historyDrawerOpen
├── donor-theme 侧滑面板
├── 列表: persist.history (按 finishedAt 降序)
└── MiniSplitResultCard (SplitResultCard 紧凑变体)
    ├── 缩略图 + 文件名 + 子图数 + 相对时间
    ├── [ VIEW ] → 打开预览
    └── [ DELETE ] → 删除
```

---

## 5. 新增文件清单

### 5.1 renderer/pages-react/storyboard-split/

| 文件 | 职责 | 预估行数 |
|------|------|---------|
| `SplitHeader.tsx` | 标题 + 凭证徽章 + 列数选择器 + 历史按钮 | ~80 |
| `ActiveQueue.tsx` | 进行中任务容器 (折叠逻辑) | ~30 |
| `ActiveQueueItem.tsx` | 单个进度条目 + 取消 | ~60 |
| `ResultsGrid.tsx` | 完成卡栅格容器 | ~25 |
| `SplitResultCard.tsx` | donor 风完成卡 (封面 + 角标 + hover 操作) | ~130 |
| `SplitPreview.tsx` | 全屏 Portal lightbox (SINGLE/GRID) | ~200 |
| `utils/zipDownload.ts` | JSZip 批量打包工具函数 | ~80 |

### 5.2 重写

| 文件 | 变化 |
|------|------|
| `HistoryDrawer.tsx` | 全面 donor-theme 重写 |
| `StoryboardSplitPage.tsx` | 编排器重写: DonorShell 包裹, 新组件接入, IPC 事件流重构 |
| `DefaultsBar.tsx` | 样式升级: d-neon-frame + d-mono (结构不变) |
| `Dropzone.tsx` | 样式升级: d-neon-frame 切角 + 品红边框 (逻辑不变) |

### 5.3 Store 变更

| 文件 | 变化 |
|------|------|
| `useSplitSessionStore.ts` | tasks→activeTasks, 新增 recentlyFinished/selectedHistoryId/previewMode/previewIndex, 移除 finishTask/drawerOpen/reopenHistory |
| `useSplitPersistStore.ts` | 新增 gridCols/historyDrawerOpen/setGridCols/toggleHistoryDrawer, 更新 partialize 和 migrate |
| `src/types/storyboardSplit.ts` | SplitHistoryItem 新增 coverUrl/rows/cols 可选字段 |

### 5.4 Main 进程

| 文件 | 变化 |
|------|------|
| `storyboardSplit/index.ts` | 新增 `deleteRemoteObjects(cosPaths: string[])` 导出 + IPC handler |
| `storyboardSplit/cosClient.ts` | 新增 `deleteObjects(cosPaths: string[])` 函数 |

### 5.5 废弃

| 文件 | 处理 |
|------|------|
| `TaskCard.tsx` | 实施完成后删除 |

---

## 6. 数据流: 完成事件

```
[main] pollUntilFinish() resolves
  ↓
[main] safeSend('storyboard-split:finished', { taskId, results })
  ↓
[preload] window.electronAPI.onStoryboardSplitEvent(handler)
  ↓
[renderer] StoryboardSplitPage useEffect handler:
  1. const task = session.activeTasks.find(t => t.id === taskId)
  2. const historyItem = buildHistoryItem(task, results)
  3. persist.pushHistory(historyItem)         ← 先入历史
  4. session.removeActiveTask(taskId)         ← 再从 active 拿掉
  5. session.setRecentlyFinished(historyItem.id)
  6. setTimeout(() => session.setRecentlyFinished(null), 3000)
```

**顺序关键**: 先 push 后 remove, 避免某一帧 UI 同时找不到任务。

---

## 7. 数据流: ZIP 下载

```
[SplitResultCard] 用户点击 [ SAVE.ZIP ]
  ↓
zipDownload(subImageUrls, taskName, onProgress?)
  ↓
1. const JSZip = await getJSZip()       ← LazyLibraries 复用
2. const zip = new JSZip()
3. for (i, url) of subImageUrls:
     try:
       const resp = await fetch(url, { mode: 'cors' })
       const blob = await resp.blob()
       zip.file(`${taskName}-${i+1}.jpg`, blob)
     catch:
       zip.file(`_FAILED_${i+1}.txt`, `原 URL: ${url}\n错误: ${err.message}`)
4. const blob = await zip.generateAsync(
     { type: 'blob', compression: 'STORE' },  ← 图片不重复压缩
     (meta) => onProgress?.(meta.percent)
   )
5. saveAs(blob)  ← DonorPreview 同款 a.download 模式
```

**要点:**
- `compression: 'STORE'` — 子图已是 JPEG/PNG, DEFLATE 无收益但浪费 CPU
- 单张失败不阻断整包, 改为写 `_FAILED_*.txt` 记录原 URL
- `getJSZip()` 已由 `preloadLibraries()` 在 idle 时预热

---

## 8. 数据流: 删除 (Q10 — 本地即时 + COS 后台静默)

```
[SplitResultCard / HistoryDrawer] 用户点击 [ DELETE ]
  ↓
1. window.confirm('确认删除?')
2. const item = persist.history.find(h => h.id === id)
3. persist.removeHistory(id)                    ← UI 立即消失
4. if (session.selectedHistoryId === id)
     session.setSelectedHistoryId(null)         ← 关闭正在预览的
5. const cosPaths = item.results.map(r => r.cosPath)
6. api.storyboardSplitDeleteRemote(cosPaths)    ← fire-and-forget IPC
     .catch(console.warn)                       ← 失败不报警
```

**Main 进程新增:**
```typescript
// storyboardSplit/index.ts
export async function deleteRemoteObjects(cosPaths: string[]) {
  if (!cosPaths.length) return { success: true }
  try {
    await deleteObjects(cosPaths)  // cosClient.deleteObjects
    return { success: true }
  } catch (err: any) {
    console.warn('[SplitService] COS delete failed:', err.message)
    return { success: false, error: err.message }
  }
}
```

---

## 9. SplitPreview 详细规格

### 9.1 SINGLE 模式

- 全屏 Portal (createPortal → document.body), zIndex: 70000
- 背景: `rgba(10,5,16,0.92)` + `backdrop-filter: blur(4px)`
- 主体: `d-neon-frame d-clip-corner-br`
- 头部: `● PREVIEW` + `#ID` + `idx/total` + `[ SINGLE | GRID ]` + `[ ESC ]`
- 图片区: `max-h-[65vh] object-contain`
- 左右翻页: `◀ / ▶` 按钮, 键盘 ← →
- 底部缩略图轨道: 水平滚动, 当前高亮, 点击跳转
- 操作区: `[ SAVE.IMG ]` `[ SAVE.ZIP ]` `[ OPEN.URL ]`

### 9.2 GRID 模式

- 替换图片区为栅格平铺 (按 item.rows × item.cols 或自动推断)
- 每张子图可点击, 点击后切回 SINGLE 并跳到该索引
- 如果 rows/cols 未知, fallback 到 `Math.ceil(sqrt(total))` 列

### 9.3 键盘快捷键

| 键 | 动作 |
|----|------|
| `Escape` | 关闭预览 |
| `←` / `→` | 上/下一张 (SINGLE 模式) |
| `G` | 切换 SINGLE ↔ GRID |

### 9.4 单图保存 (照搬 DonorPreview)

```typescript
const handleSave = async () => {
  const url = urls[idx]
  if (!url) return
  const filename = `${item.filename}-${idx + 1}.jpg`
  try {
    const res = await fetch(url, { mode: 'cors' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const objUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000)
  } catch {
    // CORS 降级: 新标签页打开
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.target = '_blank'
    a.rel = 'noreferrer'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }
}
```

---

## 10. 样式规范

### 10.1 复用的 donor-theme CSS token

所有新组件直接使用 `donor-theme.css` 中已有的 CSS 变量和 class:

| 用途 | Token / Class |
|------|---------------|
| 背景 | `var(--donor-bg-0)`, `var(--donor-bg-1)` |
| 文字 | `var(--donor-ink)`, `var(--donor-ink-dim)`, `var(--donor-ink-mute)` |
| 品红 | `var(--donor-magenta)`, `var(--donor-magenta-dim)` |
| 青色 | `var(--donor-cyan)`, `var(--donor-cyan-dim)` |
| 红色 | `var(--donor-red)` |
| 边框 | `d-neon-frame` |
| 切角 | `d-clip-corner-tl`, `d-clip-corner-br` |
| 等宽字体 | `d-mono` |
| 霓虹文字 | `d-neon-text-c`, `d-neon-text-m` |
| 状态标签 | `d-status-tag`, `d-status-tag--ok`, `d-status-tag--pending` |
| Hover 反色 | `d-hover-invert`, `d-hover-invert-cyan` |
| HUD 数字 | `d-hud-digit` |
| 扫描线 | `d-scan-bar` |

### 10.2 不新增 CSS

**0 行新 CSS**。所有样式通过 Tailwind utility + 现有 donor-theme token 组合实现。

### 10.3 DefaultsBar / Dropzone 样式升级要点

**DefaultsBar:**
- 外层: `d-neon-frame` 替换 `bg-zinc-900/50 border border-zinc-700 rounded-lg`
- 文字: `d-mono` 替换默认 sans
- select/input: `bg-[color:var(--donor-bg-1)] border-[color:var(--donor-magenta-dim)]`

**Dropzone:**
- 外层: `d-neon-frame d-clip-corner-br` 替换 `border-2 border-dashed rounded-lg`
- 拖拽高亮: `border-[color:var(--donor-cyan)]` 替换 `border-cyberpunk-yellow`
- 文字: `d-mono tracking-widest uppercase`

---

## 11. IPC 接口变更

### 11.1 新增 IPC handler (main)

```typescript
ipcMain.handle('storyboard-split:delete-remote', async (_, cosPaths: string[]) => {
  return deleteRemoteObjects(cosPaths)
})
```

### 11.2 新增 preload API

```typescript
// preload/index.ts — ElectronAPI 接口新增:
storyboardSplitDeleteRemote: (cosPaths: string[]) => Promise<{ success: boolean; error?: string }>
```

---

## 12. 实施计划 (10 步, subagent 友好切片)

| 步骤 | 内容 | 依赖 | 预计复杂度 |
|------|------|------|-----------|
| **T1** | Types: 扩展 `SplitHistoryItem` (coverUrl/rows/cols) | 无 | 低 |
| **T2** | Stores: 重构 session + persist (新字段/actions) | T1 | 中 |
| **T3** | `utils/zipDownload.ts` | 无 (纯函数) | 低 |
| **T4** | `SplitPreview.tsx` | T2 | 高 |
| **T5** | `SplitResultCard.tsx` + `ResultsGrid.tsx` | T2, T3 | 中 |
| **T6** | `ActiveQueue.tsx` + `ActiveQueueItem.tsx` | T2 | 低 |
| **T7** | `SplitHeader.tsx` | T2 | 低 |
| **T8** | `HistoryDrawer.tsx` 重写 | T2, T5 | 中 |
| **T9** | `StoryboardSplitPage.tsx` 编排器重写 + DefaultsBar/Dropzone 样式升级 | T2–T8 | 高 |
| **T10** | Main 进程 `deleteRemoteObjects` IPC + preload | 无 | 低 |

**并行机会:**
- T1, T3, T10 可并行 (无互相依赖)
- T4, T5, T6, T7 依赖 T2 但彼此间可并行
- T8 依赖 T5 (复用 SplitResultCard 紧凑变体)
- T9 是最后的集成步骤

---

## 13. 验收标准

- [ ] 拆分完成后, 子图以 DonorCard 风格卡片展示在 ResultsGrid
- [ ] 列数选择器 `[ 2 | 3 | 4 | 6 ]` 即时切换, 偏好持久化
- [ ] 点击 `[ VIEW ]` 打开全屏 SplitPreview, ESC/背景点击关闭
- [ ] SplitPreview SINGLE 模式: 大图 + 左右翻页 + 缩略图轨道
- [ ] SplitPreview GRID 模式: 按拆分布局平铺, 点击跳 SINGLE
- [ ] `[ SAVE.IMG ]` 下载当前子图 (CORS 降级兜底)
- [ ] `[ SAVE.ZIP ]` 整包下载, 进度可见
- [ ] `[ DELETE ]` 本地立即消失, COS 后台静默清理
- [ ] 进行中任务以紧凑横条展示, 有进度和取消按钮
- [ ] 历史抽屉 donor-theme 风格, 列表可打开预览/删除
- [ ] DefaultsBar / Dropzone 视觉升级至 donor-theme
- [ ] 0 行新 CSS, 完全复用现有 donor-theme token
- [ ] 无 lint error
- [ ] `npm run dev` 跑通, 页面可正常切换
- [ ] 旧 TaskCard.tsx 删除

---

## 14. Context7 审阅修订 (2026-04-22)

### 修订 R1: Zustand persist `migrate` 必须 bump version

**问题:** 现有 `useSplitPersistStore` version=1。新增 `gridCols` 和 `historyDrawerOpen` 字段后，旧用户持久化数据不包含这些字段，可能导致 `undefined` 引用。

**修复:** version 从 `1` → `2`，`migrate` 函数补默认值:

```typescript
version: 2,
migrate: (persisted: any, version: number) => {
  if (version < 2) {
    persisted.gridCols = 3
    persisted.historyDrawerOpen = false
  }
  return persisted
},
partialize: (state) => ({
  history: state.history.slice(0, MAX_HISTORY),
  defaultConfig: state.defaultConfig,
  gridCols: state.gridCols,            // ← 新增
  historyDrawerOpen: state.historyDrawerOpen,  // ← 新增
}),
```

### 修订 R2: Tailwind v4 动态 grid-cols 必须用静态映射

**问题:** Tailwind v4 CSS-first 模式只扫描源码中字面出现的 class。`grid-cols-${n}` 动态拼接不会被检测，运行时样式缺失。

**修复:** `ResultsGrid.tsx` 使用静态映射:

```typescript
const GRID_COLS_CLASS: Record<2 | 3 | 4 | 6, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
  6: 'grid-cols-6',
}
// 使用: <div className={`grid ${GRID_COLS_CLASS[gridCols]} gap-4`}>
```

同样，`SplitPreview` GRID 模式的列数映射也必须用此方式。

### 修订 R3: COS 批量删除 API 签名

**问题:** spec §8 的 `deleteObjects(cosPaths)` 需要确认 SDK 调用方式。

**修复:** 使用 `cos.deleteMultipleObject`:

```typescript
export async function deleteObjects(cosPaths: string[]): Promise<void> {
  const cos = getCosInstance()
  const { Bucket, Region } = getBucketAndRegion()
  await new Promise<void>((resolve, reject) => {
    cos.deleteMultipleObject({
      Bucket,
      Region,
      Objects: cosPaths.map(key => ({ Key: key })),
      Quiet: true,  // 只返回失败项, 减少响应体积
    }, (err: any, data: any) => {
      if (err) return reject(err)
      if (data.Error?.length) {
        console.warn('[COS] partial delete failures:', data.Error)
      }
      resolve()
    })
  })
}
```

每个 task 的输入图 cosPath 也应一并删除 (不只是输出子图):

```typescript
// deleteRemoteObjects 调用时:
const allPaths = [
  ...item.results.map(r => r.cosPath),      // 输出子图
  `storyboard-split/${item.id}/input.*`,     // 输入图 (需精确路径)
]
```

> **注意:** 输入图的 key 在 `SplitHistoryItem` 中没有存储。需要新增 `inputCosKey?: string` 字段，或约定固定格式 `storyboard-split/${id}/input.${ext}`。推荐前者更可靠。

---

## 15. 风险 & 缓解

| 风险 | 缓解措施 |
|------|---------|
| COS URL 过期后 SplitResultCard 图片 404 | 同 DonorCard: `onError` 显示 NO_IMAGE_DATA 占位 |
| JSZip 打包大量子图内存峰值 | `compression: 'STORE'` 避免 CPU+内存双杀; 单张失败不阻断 |
| SplitPreview GRID 模式 rows/cols 未知 | fallback `Math.ceil(sqrt(total))` 列 |
| persist store 迁移 (version bump) | migrate v1→v2: 补 `gridCols=3`, `historyDrawerOpen=false` (R1) |
| deleteObjects COS 权限不足 | fire-and-forget, console.warn, 不影响 UI |
| Tailwind v4 动态 class 不被扫描 | 静态映射对象确保字面出现 (R2) |
| 输入图 COS key 丢失无法清理 | SplitHistoryItem 新增 `inputCosKey` 字段 (R3) |

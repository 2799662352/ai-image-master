# 宫格拆图 UI/UX 重构 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将"宫格拆图"页面从基础功能态升级至 donor-theme 赛博朋克风，支持预览、下载、批量打包、历史管理。

**Architecture:** 两层 Zustand store（session 内存 + persist 持久化）驱动 React 组件树。完成态 task 自动 spawn 到 persist.history，session 仅保留进行中。UI 全面复用 donor-theme CSS token，0 行新 CSS。

**Tech Stack:** React 19, Zustand v5 (persist middleware), Tailwind CSS v4, JSZip (lazy via getJSZip), createPortal, cos-nodejs-sdk-v5, Electron IPC

**Spec 文档:** `docs/2026-04-22-split-ui-redesign-spec.md`

---

## 文件结构

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/renderer/src/pages-react/storyboard-split/SplitHeader.tsx` | 页面标题 + 凭证徽章 + 列数选择器 + 历史按钮 |
| `src/renderer/src/pages-react/storyboard-split/ActiveQueue.tsx` | 进行中任务容器（折叠） |
| `src/renderer/src/pages-react/storyboard-split/ActiveQueueItem.tsx` | 单个进行中条目 |
| `src/renderer/src/pages-react/storyboard-split/ResultsGrid.tsx` | 完成卡栅格容器 |
| `src/renderer/src/pages-react/storyboard-split/SplitResultCard.tsx` | donor 风完成卡 |
| `src/renderer/src/pages-react/storyboard-split/SplitPreview.tsx` | 全屏 Portal lightbox |
| `src/renderer/src/pages-react/storyboard-split/utils/zipDownload.ts` | JSZip 打包工具函数 |

### 修改文件

| 文件 | 变化 |
|------|------|
| `src/types/storyboardSplit.ts` | SplitHistoryItem 新增 coverUrl/inputCosKey/rows/cols |
| `src/renderer/src/stores/useSplitSessionStore.ts` | 重构: tasks→activeTasks, 新增 preview 状态 |
| `src/renderer/src/stores/useSplitPersistStore.ts` | 新增 gridCols/historyDrawerOpen, version bump 1→2 |
| `src/renderer/src/pages-react/storyboard-split/DefaultsBar.tsx` | 样式升级至 donor-theme |
| `src/renderer/src/pages-react/storyboard-split/Dropzone.tsx` | 样式升级至 donor-theme |
| `src/renderer/src/pages-react/storyboard-split/HistoryDrawer.tsx` | 全面 donor-theme 重写 |
| `src/renderer/src/pages-react/StoryboardSplitPage.tsx` | 编排器重写: DonorShell + 新组件 |
| `src/main/services/storyboardSplit/cosClient.ts` | 新增 deleteObjects() |
| `src/main/services/storyboardSplit/index.ts` | 新增 deleteRemoteObjects() 导出 |
| `src/main/index.ts` | 新增 IPC handler: storyboard-split:delete-remote |
| `src/preload/index.ts` | 新增 storyboardSplitDeleteRemote API + IPC 通道 |

### 删除文件

| 文件 | 时机 |
|------|------|
| `src/renderer/src/pages-react/storyboard-split/TaskCard.tsx` | Task 9 最后删除 |

---

## Task 1: 扩展类型定义

**Files:**
- Modify: `src/types/storyboardSplit.ts`

- [ ] **Step 1: 扩展 SplitHistoryItem 接口**

在 `SplitHistoryItem` 中新增 4 个可选字段:

```typescript
export interface SplitHistoryItem {
  id: string
  filename: string
  thumbnailDataUrl: string
  config: SplitConfig
  results: SplitResult[]
  createdAt: number
  finishedAt: number
  coverUrl?: string
  inputCosKey?: string
  rows?: number
  cols?: number
}
```

把 `src/types/storyboardSplit.ts` 中现有 `SplitHistoryItem` 替换为以上版本。只添加 4 个可选字段 (`coverUrl`, `inputCosKey`, `rows`, `cols`)，其余不变。

- [ ] **Step 2: 验证编译**

运行: `cd D:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit --pretty 2>&1 | head -20`

预期: 无新增错误（可选字段向后兼容）。

- [ ] **Step 3: 提交**

```bash
git add src/types/storyboardSplit.ts
git commit -m "feat(split): extend SplitHistoryItem with coverUrl, inputCosKey, rows, cols"
```

---

## Task 2: 重构 Zustand stores

**Files:**
- Modify: `src/renderer/src/stores/useSplitSessionStore.ts`
- Modify: `src/renderer/src/stores/useSplitPersistStore.ts`

- [ ] **Step 1: 重写 useSplitSessionStore**

用以下完整内容替换 `useSplitSessionStore.ts`:

```typescript
import { create } from 'zustand'
import type { SplitTask, SplitTaskStatus, SplitStage } from '../../../types/storyboardSplit'

interface SplitSessionState {
  activeTasks: SplitTask[]
  recentlyFinished: string | null
  selectedHistoryId: string | null
  previewMode: 'single' | 'grid'
  previewIndex: number

  addTask: (task: SplitTask) => void
  removeActiveTask: (taskId: string) => void
  updateTaskProgress: (taskId: string, status: SplitTaskStatus, progress: number, stage?: SplitStage) => void
  failTask: (taskId: string, error: string, errorCode?: string) => void
  cancelTask: (taskId: string) => void
  clearImageData: (taskId: string) => void
  setRecentlyFinished: (id: string | null) => void
  setSelectedHistoryId: (id: string | null) => void
  setPreviewMode: (mode: 'single' | 'grid') => void
  setPreviewIndex: (index: number) => void
}

export const useSplitSessionStore = create<SplitSessionState>()((set) => ({
  activeTasks: [],
  recentlyFinished: null,
  selectedHistoryId: null,
  previewMode: 'single' as const,
  previewIndex: 0,

  addTask: (task) => set((s) => ({ activeTasks: [...s.activeTasks, task] })),

  removeActiveTask: (taskId) =>
    set((s) => ({ activeTasks: s.activeTasks.filter((t) => t.id !== taskId) })),

  updateTaskProgress: (taskId, status, progress, stage) =>
    set((s) => ({
      activeTasks: s.activeTasks.map((t) =>
        t.id === taskId ? { ...t, status, progress, stage: stage ?? t.stage } : t
      ),
    })),

  failTask: (taskId, error, errorCode) =>
    set((s) => ({
      activeTasks: s.activeTasks.map((t) =>
        t.id === taskId ? { ...t, status: 'failed' as const, error, errorCode } : t
      ),
    })),

  cancelTask: (taskId) =>
    set((s) => ({
      activeTasks: s.activeTasks.map((t) =>
        t.id === taskId ? { ...t, status: 'cancelled' as const } : t
      ),
    })),

  clearImageData: (taskId) =>
    set((s) => ({
      activeTasks: s.activeTasks.map((t) =>
        t.id === taskId ? { ...t, imageDataUrl: '' } : t
      ),
    })),

  setRecentlyFinished: (id) => set({ recentlyFinished: id }),
  setSelectedHistoryId: (id) => set({ selectedHistoryId: id }),
  setPreviewMode: (mode) => set({ previewMode: mode }),
  setPreviewIndex: (index) => set({ previewIndex: index }),
}))
```

- [ ] **Step 2: 扩展 useSplitPersistStore**

用以下完整内容替换 `useSplitPersistStore.ts`:

```typescript
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SplitHistoryItem, SplitConfig } from '../../../types/storyboardSplit'
import { DEFAULT_SPLIT_CONFIG } from '../../../types/storyboardSplit'

const MAX_HISTORY = 50
const MAX_THUMBNAIL_BYTES = 25000

type GridCols = 2 | 3 | 4 | 6

interface SplitPersistState {
  history: SplitHistoryItem[]
  defaultConfig: SplitConfig
  gridCols: GridCols
  historyDrawerOpen: boolean

  pushHistory: (item: SplitHistoryItem) => void
  removeHistory: (id: string) => void
  clearHistory: () => void
  updateDefaultConfig: (config: SplitConfig) => void
  setGridCols: (n: GridCols) => void
  toggleHistoryDrawer: () => void
}

export const useSplitPersistStore = create<SplitPersistState>()(
  persist(
    (set) => ({
      history: [],
      defaultConfig: { ...DEFAULT_SPLIT_CONFIG },
      gridCols: 3 as GridCols,
      historyDrawerOpen: false,

      pushHistory: (item) =>
        set((s) => {
          let thumb = item.thumbnailDataUrl
          if (thumb && thumb.length > MAX_THUMBNAIL_BYTES) {
            console.warn(`[SplitPersist] thumbnail too large (${thumb.length}), truncating`)
            thumb = ''
          }
          const updated = [{ ...item, thumbnailDataUrl: thumb }, ...s.history].slice(0, MAX_HISTORY)
          return { history: updated }
        }),

      removeHistory: (id) =>
        set((s) => ({ history: s.history.filter((h) => h.id !== id) })),

      clearHistory: () => set({ history: [] }),

      updateDefaultConfig: (config) => set({ defaultConfig: { ...config } }),

      setGridCols: (n) => set({ gridCols: n }),

      toggleHistoryDrawer: () => set((s) => ({ historyDrawerOpen: !s.historyDrawerOpen })),
    }),
    {
      name: 'storyboard-split-storage',
      version: 2,
      migrate: (persisted: any, version: number) => {
        if (version < 2) {
          persisted.gridCols = persisted.gridCols ?? 3
          persisted.historyDrawerOpen = persisted.historyDrawerOpen ?? false
        }
        return persisted
      },
      partialize: (state) => ({
        history: state.history.slice(0, MAX_HISTORY),
        defaultConfig: state.defaultConfig,
        gridCols: state.gridCols,
        historyDrawerOpen: state.historyDrawerOpen,
      }),
    }
  )
)
```

- [ ] **Step 3: 验证编译**

运行: `cd D:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit --pretty 2>&1 | head -30`

预期: `StoryboardSplitPage.tsx` 会报引用 `tasks`、`drawerOpen`、`finishTask`、`reopenHistory`、`toggleDrawer` 等已移除字段的错误。这是预期中的——Task 9 会修复。此时只确保两个 store 文件自身无语法错误。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/src/stores/useSplitSessionStore.ts src/renderer/src/stores/useSplitPersistStore.ts
git commit -m "feat(split): refactor stores — activeTasks, gridCols, historyDrawerOpen, version 2 migration"
```

---

## Task 3: zipDownload 工具函数

**Files:**
- Create: `src/renderer/src/pages-react/storyboard-split/utils/zipDownload.ts`

- [ ] **Step 1: 创建 zipDownload.ts**

```typescript
import { getJSZip } from '../../../utils/LazyLibraries'

export interface ZipProgress {
  phase: 'fetching' | 'zipping'
  percent: number
}

export async function zipDownload(
  urls: string[],
  baseName: string,
  onProgress?: (p: ZipProgress) => void,
): Promise<void> {
  const JSZip = await getJSZip()
  const zip = new JSZip()
  const total = urls.length

  for (let i = 0; i < total; i++) {
    const url = urls[i]
    onProgress?.({ phase: 'fetching', percent: Math.round(((i + 1) / total) * 50) })
    try {
      const resp = await fetch(url, { mode: 'cors' })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const blob = await resp.blob()
      const ext = guessExt(resp.headers.get('content-type'))
      zip.file(`${baseName}-${String(i + 1).padStart(2, '0')}.${ext}`, blob)
    } catch (err: any) {
      zip.file(
        `_FAILED_${String(i + 1).padStart(2, '0')}.txt`,
        `URL: ${url}\nError: ${err.message}\n`,
      )
    }
  }

  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'STORE' },
    (meta: { percent: number }) => {
      onProgress?.({ phase: 'zipping', percent: 50 + Math.round(meta.percent / 2) })
    },
  )

  const objUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objUrl
  a.download = `${baseName}-split.zip`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(objUrl), 1000)
}

function guessExt(contentType: string | null): string {
  if (!contentType) return 'jpg'
  if (contentType.includes('png')) return 'png'
  if (contentType.includes('webp')) return 'webp'
  return 'jpg'
}
```

- [ ] **Step 2: 验证编译**

运行: `cd D:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit --pretty 2>&1 | grep zipDownload`

预期: 无错误。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/src/pages-react/storyboard-split/utils/zipDownload.ts
git commit -m "feat(split): add zipDownload utility — JSZip STORE compression, per-item error resilience"
```

---

## Task 4: SplitPreview 全屏灯箱

**Files:**
- Create: `src/renderer/src/pages-react/storyboard-split/SplitPreview.tsx`

- [ ] **Step 1: 创建 SplitPreview.tsx**

```typescript
import { useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { SplitHistoryItem } from '../../../../types/storyboardSplit'
import { useSplitSessionStore } from '../../stores'
import { zipDownload } from './utils/zipDownload'

interface Props {
  item: SplitHistoryItem
  onClose: () => void
}

export default function SplitPreview({ item, onClose }: Props) {
  const mode = useSplitSessionStore((s) => s.previewMode)
  const idx = useSplitSessionStore((s) => s.previewIndex)
  const setMode = useSplitSessionStore((s) => s.setPreviewMode)
  const setIdx = useSplitSessionStore((s) => s.setPreviewIndex)

  const urls = item.results.map((r) => r.url)
  const total = urls.length

  const next = useCallback(() => setIdx((idx + 1) % total), [idx, total, setIdx])
  const prev = useCallback(() => setIdx((idx - 1 + total) % total), [idx, total, setIdx])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' && mode === 'single') next()
      else if (e.key === 'ArrowLeft' && mode === 'single') prev()
      else if (e.key.toLowerCase() === 'g') setMode(mode === 'single' ? 'grid' : 'single')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, next, prev, mode, setMode])

  const url = urls[idx]

  const handleSaveImg = async () => {
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

  const handleSaveZip = () => {
    zipDownload(urls, item.filename)
  }

  const gridCols = item.cols || Math.ceil(Math.sqrt(total))

  const GRID_PREVIEW_COLS: Record<number, string> = {
    1: 'grid-cols-1',
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-4',
    5: 'grid-cols-5',
    6: 'grid-cols-6',
  }

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 70000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        backgroundColor: 'rgba(10, 5, 16, 0.92)',
        backdropFilter: 'blur(4px)',
      }}
      onClick={onClose}
    >
      <div
        className="donor-theme d-neon-frame d-clip-corner-br relative max-w-[92vw] max-h-[92vh] w-full md:w-auto flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-[color:var(--donor-magenta-dim)] d-mono text-[11px]">
          <div className="flex items-center gap-3">
            <span className="d-neon-text-c">● PREVIEW</span>
            <span className="text-[color:var(--donor-ink-dim)]">#{item.id.slice(-6).toUpperCase()}</span>
            {mode === 'single' && total > 1 && (
              <span className="d-hud-digit">
                {(idx + 1).toString().padStart(2, '0')}/{total.toString().padStart(2, '0')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMode('single')}
              className={`px-2 py-0.5 tracking-widest uppercase ${mode === 'single' ? 'text-[color:var(--donor-cyan)] border border-[color:var(--donor-cyan)]' : 'text-[color:var(--donor-ink-mute)] d-hover-invert-cyan'}`}
            >
              SINGLE
            </button>
            <button
              type="button"
              onClick={() => setMode('grid')}
              className={`px-2 py-0.5 tracking-widest uppercase ${mode === 'grid' ? 'text-[color:var(--donor-cyan)] border border-[color:var(--donor-cyan)]' : 'text-[color:var(--donor-ink-mute)] d-hover-invert-cyan'}`}
            >
              GRID
            </button>
            <button
              type="button"
              onClick={onClose}
              className="d-hover-invert px-3 py-1 tracking-widest uppercase"
            >
              [ ESC ]
            </button>
          </div>
        </div>

        {/* 图片区 */}
        {mode === 'single' ? (
          <div className="relative bg-[color:var(--donor-bg-0)] flex items-center justify-center p-4" style={{ minHeight: '40vh' }}>
            {url ? (
              <img src={url} alt={`${item.filename} #${idx + 1}`} className="max-w-full max-h-[65vh] object-contain" />
            ) : (
              <div className="py-20 text-center text-[color:var(--donor-red)] d-mono">NO_DATA</div>
            )}
            {total > 1 && (
              <>
                <button
                  type="button"
                  onClick={prev}
                  className="absolute left-2 top-1/2 -translate-y-1/2 d-hover-invert-cyan px-3 py-2 d-mono text-[14px]"
                >
                  ◀
                </button>
                <button
                  type="button"
                  onClick={next}
                  className="absolute right-2 top-1/2 -translate-y-1/2 d-hover-invert-cyan px-3 py-2 d-mono text-[14px]"
                >
                  ▶
                </button>
              </>
            )}
          </div>
        ) : (
          <div className={`bg-[color:var(--donor-bg-0)] p-4 grid ${GRID_PREVIEW_COLS[gridCols] || 'grid-cols-3'} gap-2 max-h-[70vh] overflow-y-auto`}>
            {urls.map((u, i) => (
              <button
                key={i}
                type="button"
                onClick={() => { setIdx(i); setMode('single') }}
                className="aspect-square overflow-hidden bg-[color:var(--donor-bg-1)] border border-transparent hover:border-[color:var(--donor-cyan)] transition-colors"
              >
                <img src={u} alt={`#${i + 1}`} className="w-full h-full object-cover" loading="lazy" />
              </button>
            ))}
          </div>
        )}

        {/* 缩略图轨道 (SINGLE 模式) */}
        {mode === 'single' && total > 1 && (
          <div className="flex gap-1 px-4 py-2 overflow-x-auto bg-[color:var(--donor-bg-1)]/50 border-t border-[color:var(--donor-magenta-dim)]">
            {urls.map((u, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setIdx(i)}
                className={`flex-shrink-0 w-12 h-12 overflow-hidden border-2 transition-colors ${i === idx ? 'border-[color:var(--donor-cyan)]' : 'border-transparent hover:border-[color:var(--donor-magenta-dim)]'}`}
              >
                <img src={u} alt={`thumb ${i + 1}`} className="w-full h-full object-cover" loading="lazy" />
              </button>
            ))}
          </div>
        )}

        {/* 操作区 */}
        <div className="px-4 py-3 border-t border-[color:var(--donor-magenta-dim)] bg-[color:var(--donor-bg-1)]/70 flex items-center gap-2 flex-wrap">
          <span className="d-mono text-[10px] text-[color:var(--donor-ink-mute)] mr-auto">
            {item.filename} · {total} 子图
          </span>
          {url && mode === 'single' && (
            <button
              type="button"
              onClick={handleSaveImg}
              className="d-hover-invert px-3 py-1 d-mono text-[11px] tracking-widest uppercase"
            >
              [ SAVE.IMG ]
            </button>
          )}
          <button
            type="button"
            onClick={handleSaveZip}
            className="d-hover-invert-cyan px-3 py-1 d-mono text-[11px] tracking-widest uppercase"
          >
            [ SAVE.ZIP ]
          </button>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="d-hover-invert px-3 py-1 d-mono text-[11px] tracking-widest uppercase no-underline"
            >
              [ OPEN.URL ]
            </a>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
```

- [ ] **Step 2: 验证编译**

运行: `cd D:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit --pretty 2>&1 | grep SplitPreview`

预期: 无错误（组件尚未被引用，不影响其他文件）。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/src/pages-react/storyboard-split/SplitPreview.tsx
git commit -m "feat(split): add SplitPreview Portal lightbox — SINGLE/GRID modes, keyboard nav, save/zip"
```

---

## Task 5: SplitResultCard + ResultsGrid

**Files:**
- Create: `src/renderer/src/pages-react/storyboard-split/SplitResultCard.tsx`
- Create: `src/renderer/src/pages-react/storyboard-split/ResultsGrid.tsx`

- [ ] **Step 1: 创建 SplitResultCard.tsx**

```typescript
import { useState, useCallback } from 'react'
import type { SplitHistoryItem } from '../../../../types/storyboardSplit'
import { zipDownload } from './utils/zipDownload'

interface Props {
  item: SplitHistoryItem
  isHighlighted: boolean
  onPreview: (id: string) => void
  onDelete: (id: string) => void
}

export default function SplitResultCard({ item, isHighlighted, onPreview, onDelete }: Props) {
  const [imgError, setImgError] = useState(false)
  const [zipping, setZipping] = useState(false)

  const primaryUrl = item.results[0]?.url
  const hasImage = !!primaryUrl && !imgError
  const count = item.results.length

  const ts = new Date(item.finishedAt).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (window.confirm('确认删除? / 削除しますか?')) {
      onDelete(item.id)
    }
  }, [item.id, onDelete])

  const handleZip = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    setZipping(true)
    try {
      await zipDownload(item.results.map((r) => r.url), item.filename)
    } finally {
      setZipping(false)
    }
  }, [item])

  return (
    <article
      className={`d-neon-frame d-clip-corner-tl group relative flex flex-col cursor-pointer transition-all duration-300 hover:-translate-y-[2px] ${isHighlighted ? 'ring-2 ring-[color:var(--donor-cyan)] animate-pulse' : ''}`}
      onClick={() => hasImage && onPreview(item.id)}
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-[color:var(--donor-bg-1)]">
        {hasImage ? (
          <>
            <img
              src={primaryUrl}
              alt={item.filename}
              loading="lazy"
              onError={() => setImgError(true)}
              className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
            />
            {count > 1 && (
              <div className="absolute top-2 right-2 d-mono text-[10px] px-2 py-0.5 bg-[color:var(--donor-bg-0)]/80 text-[color:var(--donor-cyan)] border border-[color:var(--donor-cyan)]">
                ×{count}
              </div>
            )}
          </>
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 relative">
            <div
              className="absolute inset-0 opacity-30"
              style={{
                backgroundImage: 'repeating-linear-gradient(45deg, transparent 0 10px, rgba(255,45,74,0.2) 10px 12px)',
              }}
            />
            <div className="relative text-center">
              <div className="d-mono text-[42px] text-[color:var(--donor-red)] leading-none">✕</div>
              <div className="mt-2 d-mono text-[11px] tracking-widest text-[color:var(--donor-red)]">NO_IMAGE_DATA</div>
            </div>
          </div>
        )}

        <div className="absolute left-2 top-2 d-status-tag d-status-tag--ok">
          <span>◆</span>
          <span>完了</span>
          <em className="opacity-80">/DONE</em>
        </div>
      </div>

      <div className="p-3 border-t border-[color:var(--donor-magenta-dim)] flex-1 flex flex-col gap-2 bg-[color:var(--donor-bg-1)]/60">
        <div className="flex items-center justify-between d-mono text-[10px] text-[color:var(--donor-ink-mute)]">
          <span>#{item.id.slice(-6).toUpperCase()}</span>
          <span>{ts}</span>
        </div>
        <p className="text-[12px] leading-[1.5] text-[color:var(--donor-ink)] line-clamp-2 d-mono">
          {item.filename}
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="d-mono text-[10px] px-2 py-0.5 border border-[color:var(--donor-cyan-dim)] text-[color:var(--donor-cyan)]">
            {count} 子図
          </span>
          {item.rows && item.cols && (
            <span className="d-mono text-[10px] px-2 py-0.5 text-[color:var(--donor-ink-dim)] border border-[color:var(--donor-ink-mute)]/40">
              {item.rows}×{item.cols}
            </span>
          )}
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 translate-y-full group-hover:translate-y-0 transition-transform duration-150 flex border-t border-[color:var(--donor-magenta)] bg-[color:var(--donor-bg-0)]/95">
        {hasImage && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onPreview(item.id) }}
            className="flex-1 py-2 d-mono text-[11px] tracking-widest uppercase text-[color:var(--donor-cyan)] hover:bg-[color:var(--donor-cyan)] hover:text-[color:var(--donor-bg-0)] transition-colors cursor-pointer"
          >
            [ VIEW ]
          </button>
        )}
        <button
          type="button"
          onClick={handleZip}
          disabled={zipping}
          className="flex-1 py-2 d-mono text-[11px] tracking-widest uppercase text-[color:var(--donor-magenta)] hover:bg-[color:var(--donor-magenta)] hover:text-[color:var(--donor-bg-0)] transition-colors cursor-pointer disabled:opacity-50"
        >
          {zipping ? '[ ZIPPING... ]' : '[ SAVE.ZIP ]'}
        </button>
        <button
          type="button"
          onClick={handleDelete}
          className="flex-1 py-2 d-mono text-[11px] tracking-widest uppercase text-[color:var(--donor-red)] hover:bg-[color:var(--donor-red)] hover:text-[color:var(--donor-bg-0)] transition-colors cursor-pointer"
        >
          [ DELETE ]
        </button>
      </div>
    </article>
  )
}
```

- [ ] **Step 2: 创建 ResultsGrid.tsx**

```typescript
import type { SplitHistoryItem } from '../../../../types/storyboardSplit'
import SplitResultCard from './SplitResultCard'

const GRID_COLS_CLASS: Record<2 | 3 | 4 | 6, string> = {
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
  6: 'grid-cols-6',
}

interface Props {
  items: SplitHistoryItem[]
  gridCols: 2 | 3 | 4 | 6
  highlightId: string | null
  onPreview: (id: string) => void
  onDelete: (id: string) => void
}

export default function ResultsGrid({ items, gridCols, highlightId, onPreview, onDelete }: Props) {
  if (items.length === 0) return null

  return (
    <div className={`grid ${GRID_COLS_CLASS[gridCols]} gap-4`}>
      {items.map((item) => (
        <SplitResultCard
          key={item.id}
          item={item}
          isHighlighted={item.id === highlightId}
          onPreview={onPreview}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}
```

注意: `GRID_COLS_CLASS` 使用静态映射而非动态拼接，确保 Tailwind v4 能扫描到所有 class。

- [ ] **Step 3: 验证编译**

运行: `cd D:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit --pretty 2>&1 | grep -E "SplitResultCard|ResultsGrid"`

预期: 无错误。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/src/pages-react/storyboard-split/SplitResultCard.tsx src/renderer/src/pages-react/storyboard-split/ResultsGrid.tsx
git commit -m "feat(split): add SplitResultCard + ResultsGrid — donor-theme cards with VIEW/ZIP/DELETE"
```

---

## Task 6: ActiveQueue + ActiveQueueItem

**Files:**
- Create: `src/renderer/src/pages-react/storyboard-split/ActiveQueueItem.tsx`
- Create: `src/renderer/src/pages-react/storyboard-split/ActiveQueue.tsx`

- [ ] **Step 1: 创建 ActiveQueueItem.tsx**

```typescript
import type { SplitTask } from '../../../../types/storyboardSplit'

const STAGE_LABELS: Record<string, string> = {
  'uploading-cos': 'COS 上传中',
  'submitting-mps': '提交 MPS',
  'polling-mps': '处理中',
  done: '完成',
}

interface Props {
  task: SplitTask
  onCancel: (id: string) => void
}

export default function ActiveQueueItem({ task, onCancel }: Props) {
  const stageLabel = task.stage ? STAGE_LABELS[task.stage] || task.stage : task.status

  return (
    <div className="d-neon-frame flex items-center gap-3 px-3 py-2 d-mono text-[11px]">
      <span className="text-[color:var(--donor-ink)] truncate max-w-[40%]">{task.filename}</span>

      <div className="flex-1 h-1.5 bg-[color:var(--donor-bg-0)] overflow-hidden">
        <div
          className="h-full bg-[color:var(--donor-cyan)] transition-all duration-500"
          style={{ width: `${task.progress}%` }}
        />
      </div>

      <span className="text-[color:var(--donor-cyan)] tracking-widest whitespace-nowrap">
        {stageLabel} {task.progress}%
      </span>

      <button
        type="button"
        onClick={() => onCancel(task.id)}
        className="d-hover-invert px-2 py-0.5 text-[color:var(--donor-red)] tracking-widest uppercase"
      >
        [ ✕ ]
      </button>
    </div>
  )
}
```

- [ ] **Step 2: 创建 ActiveQueue.tsx**

```typescript
import type { SplitTask } from '../../../../types/storyboardSplit'
import ActiveQueueItem from './ActiveQueueItem'

interface Props {
  tasks: SplitTask[]
  onCancel: (id: string) => void
}

export default function ActiveQueue({ tasks, onCancel }: Props) {
  const active = tasks.filter((t) =>
    ['pending', 'queued', 'uploading', 'submitted', 'processing'].includes(t.status)
  )
  if (active.length === 0) return null

  return (
    <div className="space-y-2">
      <div className="d-mono text-[10px] text-[color:var(--donor-magenta)] tracking-widest uppercase">
        ◐ PROCESSING // {active.length} TASK{active.length > 1 ? 'S' : ''}
      </div>
      {active.map((task) => (
        <ActiveQueueItem key={task.id} task={task} onCancel={onCancel} />
      ))}
    </div>
  )
}
```

- [ ] **Step 3: 验证编译**

运行: `cd D:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit --pretty 2>&1 | grep -E "ActiveQueue"`

预期: 无错误。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/src/pages-react/storyboard-split/ActiveQueue.tsx src/renderer/src/pages-react/storyboard-split/ActiveQueueItem.tsx
git commit -m "feat(split): add ActiveQueue + ActiveQueueItem — donor-theme progress bars"
```

---

## Task 7: SplitHeader

**Files:**
- Create: `src/renderer/src/pages-react/storyboard-split/SplitHeader.tsx`

- [ ] **Step 1: 创建 SplitHeader.tsx**

```typescript
import type { CredentialState } from '../../../../types/storyboardSplit'

type GridCols = 2 | 3 | 4 | 6
const GRID_OPTIONS: GridCols[] = [2, 3, 4, 6]

const CRED_SOURCE_LABEL: Record<string, string> = {
  env: 'ENV',
  store: 'USER',
  builtin: 'BUILTIN',
  none: 'NONE',
}

interface Props {
  credentialState: CredentialState | null
  gridCols: GridCols
  historyCount: number
  onGridColsChange: (n: GridCols) => void
  onToggleHistory: () => void
}

export default function SplitHeader({ credentialState, gridCols, historyCount, onGridColsChange, onToggleHistory }: Props) {
  return (
    <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
      <div className="flex items-center gap-3">
        <h1 className="d-mono text-lg text-[color:var(--donor-magenta)] tracking-widest uppercase">
          宫格拆图 <span className="text-[color:var(--donor-cyan)]">/ GRID.SPLIT</span>
        </h1>
        {credentialState && (
          <span className={`d-status-tag ${credentialState.hasCredentials ? 'd-status-tag--ok' : 'd-status-tag--fail'}`}>
            <span>{credentialState.hasCredentials ? '◆' : '✕'}</span>
            <span>{CRED_SOURCE_LABEL[credentialState.credentialSource] || 'N/A'}</span>
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <div className="flex d-mono text-[11px]">
          {GRID_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onGridColsChange(n)}
              className={`px-2 py-1 border border-[color:var(--donor-magenta-dim)] transition-colors ${n === gridCols ? 'bg-[color:var(--donor-cyan)] text-[color:var(--donor-bg-0)]' : 'text-[color:var(--donor-ink-dim)] hover:text-[color:var(--donor-cyan)]'}`}
            >
              {n}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={onToggleHistory}
          className="d-hover-invert-cyan px-3 py-1 d-mono text-[11px] tracking-widest uppercase"
        >
          [ HISTORY ({historyCount}) ]
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 验证编译，提交**

```bash
git add src/renderer/src/pages-react/storyboard-split/SplitHeader.tsx
git commit -m "feat(split): add SplitHeader — grid cols selector, credential badge, history toggle"
```

---

## Task 8: HistoryDrawer 重写

**Files:**
- Modify: `src/renderer/src/pages-react/storyboard-split/HistoryDrawer.tsx`

- [ ] **Step 1: 用 donor-theme 重写 HistoryDrawer**

用以下完整内容替换 `HistoryDrawer.tsx`:

```typescript
import type { SplitHistoryItem } from '../../../../types/storyboardSplit'

interface Props {
  open: boolean
  history: SplitHistoryItem[]
  onClose: () => void
  onPreview: (id: string) => void
  onDelete: (id: string) => void
}

export function HistoryDrawer({ open, history, onClose, onPreview, onDelete }: Props) {
  if (!open) return null

  return (
    <div className="donor-theme fixed inset-y-0 right-0 w-80 bg-[color:var(--donor-bg-0)] border-l border-[color:var(--donor-magenta)] shadow-2xl z-50 flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[color:var(--donor-magenta-dim)]">
        <h3 className="d-mono text-[11px] tracking-widest uppercase">
          <span className="d-neon-text-m">● HISTORY</span>
          <span className="text-[color:var(--donor-ink-mute)] ml-2">// 拆図履歴</span>
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="d-hover-invert px-2 py-0.5 d-mono text-[11px] tracking-widest"
        >
          [ ✕ ]
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {history.length === 0 && (
          <div className="py-12 text-center d-mono text-[11px] text-[color:var(--donor-ink-mute)] tracking-widest">
            NO_RECORDS // 履歴なし
          </div>
        )}
        {history.map((item) => {
          const allExpired = item.results.every((r) => Date.now() > r.expiresAt)
          const ts = formatRelativeTime(item.finishedAt)
          const primaryUrl = item.results[0]?.url

          return (
            <div
              key={item.id}
              className="d-neon-frame p-2.5 space-y-2 cursor-pointer hover:border-[color:var(--donor-cyan)] transition-colors"
              onClick={() => !allExpired && onPreview(item.id)}
            >
              <div className="flex gap-2">
                {item.thumbnailDataUrl ? (
                  <img
                    src={item.thumbnailDataUrl}
                    alt=""
                    className={`w-10 h-10 object-cover ${allExpired ? 'opacity-30 grayscale' : ''}`}
                  />
                ) : primaryUrl && !allExpired ? (
                  <img
                    src={primaryUrl}
                    alt=""
                    className="w-10 h-10 object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-10 h-10 bg-[color:var(--donor-bg-1)] flex items-center justify-center d-mono text-[10px] text-[color:var(--donor-ink-mute)]">?</div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="d-mono text-[11px] text-[color:var(--donor-ink)] truncate">{item.filename}</p>
                  <p className="d-mono text-[10px] text-[color:var(--donor-ink-mute)]">
                    {item.results.length} 子図 · {ts}
                  </p>
                  {allExpired && (
                    <p className="d-mono text-[10px] text-[color:var(--donor-red)] tracking-widest">// EXPIRED</p>
                  )}
                </div>
              </div>
              <div className="flex gap-1.5">
                {!allExpired && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onPreview(item.id) }}
                    className="d-mono text-[10px] px-2 py-0.5 text-[color:var(--donor-cyan)] border border-[color:var(--donor-cyan-dim)] hover:bg-[color:var(--donor-cyan)] hover:text-[color:var(--donor-bg-0)] transition-colors"
                  >
                    VIEW
                  </button>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (window.confirm('确認削除?')) onDelete(item.id)
                  }}
                  className="d-mono text-[10px] px-2 py-0.5 text-[color:var(--donor-red)] border border-[color:var(--donor-red)]/30 hover:bg-[color:var(--donor-red)] hover:text-[color:var(--donor-bg-0)] transition-colors"
                >
                  DELETE
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <footer className="px-4 py-2 border-t border-[color:var(--donor-magenta-dim)] d-mono text-[10px] text-[color:var(--donor-ink-mute)] flex justify-between">
        <span>// SPLIT_ARCHIVE</span>
        <span className="d-neon-text-c">[ {history.length.toString().padStart(3, '0')} ]</span>
      </footer>
    </div>
  )
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}時間前`
  const days = Math.floor(hours / 24)
  return `${days}日前`
}
```

- [ ] **Step 2: 验证编译，提交**

```bash
git add src/renderer/src/pages-react/storyboard-split/HistoryDrawer.tsx
git commit -m "feat(split): rewrite HistoryDrawer — donor-theme cyberpunk aesthetic"
```

---

## Task 9: StoryboardSplitPage 编排器重写 + 样式升级

**Files:**
- Modify: `src/renderer/src/pages-react/StoryboardSplitPage.tsx`
- Modify: `src/renderer/src/pages-react/storyboard-split/DefaultsBar.tsx`
- Modify: `src/renderer/src/pages-react/storyboard-split/Dropzone.tsx`
- Delete: `src/renderer/src/pages-react/storyboard-split/TaskCard.tsx`

- [ ] **Step 1: 升级 DefaultsBar 样式**

用以下完整内容替换 `DefaultsBar.tsx`:

```typescript
import { useState } from 'react'
import type { SplitConfig } from '../../../../types/storyboardSplit'

interface DefaultsBarProps {
  config: SplitConfig
  onChange: (config: SplitConfig) => void
}

export function DefaultsBar({ config, onChange }: DefaultsBarProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="d-neon-frame">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-2 flex items-center justify-between d-mono text-[11px] text-[color:var(--donor-ink-dim)] hover:text-[color:var(--donor-cyan)] transition-colors tracking-widest uppercase"
      >
        <span>⚙ PARAMS // パラメータ</span>
        <span>{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-3 border-t border-[color:var(--donor-magenta-dim)]">
          <label className="flex items-center justify-between mt-3">
            <span className="d-mono text-[11px] text-[color:var(--donor-ink)]">拆分模式</span>
            <select
              value={config.modelSamplingAuraFlow}
              onChange={(e) => onChange({ ...config, modelSamplingAuraFlow: parseFloat(e.target.value) })}
              className="bg-[color:var(--donor-bg-1)] border border-[color:var(--donor-magenta-dim)] text-[color:var(--donor-ink)] d-mono text-[11px] px-3 py-1.5"
            >
              <option value={0.1}>AI 分镜 (0.1)</option>
              <option value={1.0}>漫画分镜 (1.0)</option>
            </select>
          </label>

          <label className="flex items-center justify-between">
            <span className="d-mono text-[11px] text-[color:var(--donor-ink)]">仅拆第 N 张 (空=全部)</span>
            <input
              type="number"
              min={0}
              value={config.processIndex ?? ''}
              onChange={(e) => {
                const val = e.target.value
                onChange({
                  ...config,
                  processIndex: val === '' ? undefined : parseInt(val, 10),
                })
              }}
              placeholder="ALL"
              className="w-20 bg-[color:var(--donor-bg-1)] border border-[color:var(--donor-magenta-dim)] text-[color:var(--donor-ink)] d-mono text-[11px] px-2 py-1.5 text-center"
            />
          </label>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 升级 Dropzone 样式**

用以下完整内容替换 `Dropzone.tsx`:

```typescript
import { useState, useRef, useCallback } from 'react'

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_SIZE = 10 * 1024 * 1024

interface DropzoneProps {
  disabled?: boolean
  onFiles: (files: File[]) => void
  onReject?: (reason: string) => void
}

export function Dropzone({ disabled, onFiles, onReject }: DropzoneProps) {
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const validate = useCallback((files: FileList | File[]): File[] => {
    const valid: File[] = []
    let rejectedType = 0
    let rejectedSize = 0
    for (const f of Array.from(files)) {
      if (!ACCEPTED_TYPES.includes(f.type)) { rejectedType++; continue }
      if (f.size > MAX_SIZE) { rejectedSize++; continue }
      valid.push(f)
    }
    if (onReject) {
      if (rejectedType > 0) onReject(`${rejectedType} 個ファイル形式不対応 (JPG/PNG/WebP のみ)`)
      if (rejectedSize > 0) onReject(`${rejectedSize} 個ファイル超過 10MB`)
    }
    return valid
  }, [onReject])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      if (disabled) return
      const valid = validate(e.dataTransfer.files)
      if (valid.length) onFiles(valid)
    },
    [disabled, onFiles, validate]
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (disabled) return
      const files: File[] = []
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind === 'file') {
          const f = item.getAsFile()
          if (f) files.push(f)
        }
      }
      if (files.length) {
        const valid = validate(files)
        if (valid.length) onFiles(valid)
      }
    },
    [disabled, onFiles, validate]
  )

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onPaste={handlePaste}
      onClick={() => !disabled && inputRef.current?.click()}
      className={`
        d-neon-frame d-clip-corner-br relative p-8 text-center cursor-pointer transition-colors
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
        ${dragOver ? 'border-[color:var(--donor-cyan)] bg-[color:var(--donor-cyan)]/5' : ''}
      `}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) {
            const valid = validate(e.target.files)
            if (valid.length) onFiles(valid)
          }
          e.target.value = ''
        }}
      />
      <div className="d-mono text-[color:var(--donor-cyan)] text-3xl mb-2">⊞</div>
      <p className="d-mono text-[color:var(--donor-ink)] text-[13px] tracking-widest uppercase">
        DROP / PASTE / CLICK
      </p>
      <p className="d-mono text-[10px] text-[color:var(--donor-ink-mute)] mt-1 tracking-widest">
        JPG / PNG / WebP · ≤ 10MB
      </p>
    </div>
  )
}
```

- [ ] **Step 3: 重写 StoryboardSplitPage**

用以下完整内容替换 `StoryboardSplitPage.tsx`:

```typescript
import React, { useEffect, useCallback } from 'react'
import { useSplitSessionStore, useSplitPersistStore, useToastStore } from '../stores'
import type {
  SplitTask,
  SplitProgressEvent,
  SplitFinishedEvent,
  SplitFailedEvent,
  CredentialState,
} from '../../../types/storyboardSplit'
import DonorShell from '../components/donor/DonorShell'
import SplitHeader from './storyboard-split/SplitHeader'
import { DefaultsBar } from './storyboard-split/DefaultsBar'
import { Dropzone } from './storyboard-split/Dropzone'
import ActiveQueue from './storyboard-split/ActiveQueue'
import ResultsGrid from './storyboard-split/ResultsGrid'
import SplitPreview from './storyboard-split/SplitPreview'
import { HistoryDrawer } from './storyboard-split/HistoryDrawer'

const api = (window as any).electronAPI

export default function StoryboardSplitPage() {
  const activeTasks = useSplitSessionStore((s) => s.activeTasks)
  const recentlyFinished = useSplitSessionStore((s) => s.recentlyFinished)
  const selectedHistoryId = useSplitSessionStore((s) => s.selectedHistoryId)
  const addTask = useSplitSessionStore((s) => s.addTask)
  const removeActiveTask = useSplitSessionStore((s) => s.removeActiveTask)
  const updateTaskProgress = useSplitSessionStore((s) => s.updateTaskProgress)
  const failTask = useSplitSessionStore((s) => s.failTask)
  const cancelTaskInStore = useSplitSessionStore((s) => s.cancelTask)
  const clearImageData = useSplitSessionStore((s) => s.clearImageData)
  const setRecentlyFinished = useSplitSessionStore((s) => s.setRecentlyFinished)
  const setSelectedHistoryId = useSplitSessionStore((s) => s.setSelectedHistoryId)
  const setPreviewIndex = useSplitSessionStore((s) => s.setPreviewIndex)

  const history = useSplitPersistStore((s) => s.history)
  const defaultConfig = useSplitPersistStore((s) => s.defaultConfig)
  const gridCols = useSplitPersistStore((s) => s.gridCols)
  const historyDrawerOpen = useSplitPersistStore((s) => s.historyDrawerOpen)
  const pushHistory = useSplitPersistStore((s) => s.pushHistory)
  const removeHistory = useSplitPersistStore((s) => s.removeHistory)
  const updateDefaultConfig = useSplitPersistStore((s) => s.updateDefaultConfig)
  const setGridCols = useSplitPersistStore((s) => s.setGridCols)
  const toggleHistoryDrawer = useSplitPersistStore((s) => s.toggleHistoryDrawer)

  const addToast = useToastStore((s) => s.addToast)

  const [credentialState, setCredentialState] = React.useState<CredentialState | null>(null)

  useEffect(() => {
    api?.storyboardSplitGetConfig?.().then((res: any) => {
      if (res?.success) {
        setCredentialState(res.credentials ?? null)
      }
    })
  }, [])

  useEffect(() => {
    if (!api?.onStoryboardSplitEvent) return

    api.onStoryboardSplitEvent((channel: string, data: any) => {
      if (channel === 'storyboard-split:progress') {
        const d = data as SplitProgressEvent
        updateTaskProgress(d.taskId, d.status, d.progress, d.stage)
      } else if (channel === 'storyboard-split:finished') {
        const d = data as SplitFinishedEvent
        const task = useSplitSessionStore.getState().activeTasks.find((t) => t.id === d.taskId)
        if (task) {
          pushHistory({
            id: task.id,
            filename: task.filename,
            thumbnailDataUrl: task.thumbnailDataUrl || '',
            config: task.config,
            results: d.results,
            createdAt: task.createdAt,
            finishedAt: Date.now(),
          })
          removeActiveTask(d.taskId)
          setRecentlyFinished(task.id)
          setTimeout(() => setRecentlyFinished(null), 3000)
          addToast({ message: `${task.filename} 拆分完成`, type: 'success' })
        }
      } else if (channel === 'storyboard-split:failed') {
        const d = data as SplitFailedEvent
        failTask(d.taskId, d.error, d.errorCode)
      }
    })

    return () => {
      api.removeStoryboardSplitListeners?.()
    }
  }, [])

  const handleFiles = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        const dataUrl = await readFileAsDataUrl(file)
        const thumb = await createThumbnail(dataUrl)
        const taskId = crypto.randomUUID()
        const task: SplitTask = {
          id: taskId,
          filename: file.name,
          imageDataUrl: dataUrl,
          thumbnailDataUrl: thumb,
          status: 'pending',
          progress: 0,
          config: { ...defaultConfig },
          createdAt: Date.now(),
        }
        addTask(task)

        api?.storyboardSplitSubmit?.({
          taskId,
          base64Data: dataUrl,
          filename: file.name,
          config: task.config,
        }).then((res: any) => {
          if (res && !res.success) {
            failTask(taskId, res.error || '提交失敗', res.errorCode)
            addToast({ message: res.error || '拆図タスク提出失敗', type: 'error' })
          }
          clearImageData(taskId)
        })
      }
    },
    [defaultConfig, addTask, failTask, clearImageData, addToast]
  )

  const handleCancel = useCallback(
    (taskId: string) => {
      cancelTaskInStore(taskId)
      api?.storyboardSplitCancel?.(taskId)
    },
    [cancelTaskInStore]
  )

  const handlePreview = useCallback(
    (id: string) => {
      setPreviewIndex(0)
      setSelectedHistoryId(id)
    },
    [setSelectedHistoryId, setPreviewIndex]
  )

  const handleDelete = useCallback(
    (id: string) => {
      const item = useSplitPersistStore.getState().history.find((h) => h.id === id)
      removeHistory(id)
      if (selectedHistoryId === id) setSelectedHistoryId(null)
      if (item) {
        const cosPaths = item.results.map((r) => r.cosPath)
        if (item.inputCosKey) cosPaths.push(item.inputCosKey)
        api?.storyboardSplitDeleteRemote?.(cosPaths)?.catch(console.warn)
      }
      addToast({ message: '削除しました / DELETED', type: 'success' })
    },
    [removeHistory, selectedHistoryId, setSelectedHistoryId, addToast]
  )

  const previewItem = selectedHistoryId
    ? history.find((h) => h.id === selectedHistoryId) ?? null
    : null

  return (
    <DonorShell>
      <div
        aria-hidden="true"
        className="pointer-events-none select-none d-mono font-black leading-none"
        style={{
          position: 'absolute',
          right: '12px',
          top: '-8px',
          fontSize: '180px',
          opacity: 0.08,
          color: 'var(--donor-cyan)',
          zIndex: 1,
        }}
      >
        07
      </div>

      <SplitHeader
        credentialState={credentialState}
        gridCols={gridCols}
        historyCount={history.length}
        onGridColsChange={setGridCols}
        onToggleHistory={toggleHistoryDrawer}
      />

      {credentialState && !credentialState.hasCredentials && (
        <div className="d-neon-frame p-3 mb-4 d-mono text-[11px] text-[color:var(--donor-red)] tracking-widest">
          ⚠ NO_CREDENTIALS — 設定ページで腾讯云キーを配置してください
        </div>
      )}

      <div className="space-y-4">
        <DefaultsBar config={defaultConfig} onChange={updateDefaultConfig} />

        <Dropzone
          disabled={credentialState !== null && !credentialState.hasCredentials}
          onFiles={handleFiles}
          onReject={(reason) => addToast({ message: reason, type: 'warning' })}
        />

        <ActiveQueue tasks={activeTasks} onCancel={handleCancel} />

        <ResultsGrid
          items={history}
          gridCols={gridCols}
          highlightId={recentlyFinished}
          onPreview={handlePreview}
          onDelete={handleDelete}
        />
      </div>

      <footer className="mt-6 pt-3 border-t border-[color:var(--donor-magenta-dim)] d-mono text-[10px] text-[color:var(--donor-ink-mute)] flex items-center justify-between flex-wrap gap-2">
        <span>// GRID_SPLIT_v2.0 — active {activeTasks.length} / archive {history.length}</span>
        <span className="d-neon-text-c">[ EOF ]</span>
      </footer>

      {previewItem && (
        <SplitPreview item={previewItem} onClose={() => setSelectedHistoryId(null)} />
      )}

      <HistoryDrawer
        open={historyDrawerOpen}
        history={history}
        onClose={toggleHistoryDrawer}
        onPreview={handlePreview}
        onDelete={handleDelete}
      />
    </DonorShell>
  )
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

async function createThumbnail(dataUrl: string): Promise<string> {
  if (!dataUrl) return ''
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        const MAX = 200
        let w = img.width, h = img.height
        if (w > h) { h = Math.round((h / w) * MAX); w = MAX }
        else { w = Math.round((w / h) * MAX); h = MAX }
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.7))
      } catch {
        resolve('')
      }
    }
    img.onerror = () => resolve('')
    img.src = dataUrl
  })
}
```

- [ ] **Step 4: 删除 TaskCard.tsx**

```bash
rm src/renderer/src/pages-react/storyboard-split/TaskCard.tsx
```

- [ ] **Step 5: 验证编译**

运行: `cd D:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit --pretty 2>&1 | head -30`

预期: 可能因 `storyboardSplitDeleteRemote` 在 preload 中尚未注册而报 TypeScript 警告（ElectronAPI 接口）。由于使用 `(window as any).electronAPI`，实际不会阻塞编译。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat(split): rewrite page orchestrator + donor-theme DefaultsBar/Dropzone, remove TaskCard"
```

---

## Task 10: Main 进程 deleteRemoteObjects + IPC + preload

**Files:**
- Modify: `src/main/services/storyboardSplit/cosClient.ts`
- Modify: `src/main/services/storyboardSplit/index.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: cosClient 新增 deleteObjects**

在 `cosClient.ts` 末尾追加:

```typescript
export async function deleteObjects(cosPaths: string[]): Promise<void> {
  if (!cosPaths.length) return
  const cos = getCosInstance()
  const { Bucket, Region } = getBucketAndRegion()
  await new Promise<void>((resolve, reject) => {
    cos.deleteMultipleObject({
      Bucket,
      Region,
      Objects: cosPaths.map((key) => ({ Key: key })),
      Quiet: true,
    }, (err: any, data: any) => {
      if (err) return reject(err)
      if (data?.Error?.length) {
        console.warn('[COS] partial delete failures:', data.Error)
      }
      resolve()
    })
  })
}
```

- [ ] **Step 2: index.ts 新增 deleteRemoteObjects 导出**

在 `src/main/services/storyboardSplit/index.ts` 的 import 中追加 `deleteObjects`:

```typescript
import { uploadOriginal, getPresignedUrl, deleteObjects } from './cosClient'
```

在文件末尾（`setDefaultsFromUI` 之后）追加:

```typescript
export async function deleteRemoteObjects(cosPaths: string[]) {
  if (!cosPaths.length) return { success: true }
  try {
    await deleteObjects(cosPaths)
    return { success: true }
  } catch (err: any) {
    console.warn('[SplitService] COS delete failed:', err.message)
    return { success: false, error: err.message }
  }
}
```

- [ ] **Step 3: main/index.ts 注册 IPC handler**

在 `src/main/index.ts` 的 import 中追加 `deleteRemoteObjects`:

```typescript
import {
  submitSplit,
  cancelTask,
  getConfig as getSplitConfig,
  setCredentialsFromUI,
  setDefaultsFromUI,
  setMainWindow as setSplitMainWindow,
  deleteRemoteObjects,
} from './services/storyboardSplit'
```

在 `storyboard-split:set-defaults` handler 之后追加:

```typescript
ipcMain.handle('storyboard-split:delete-remote', async (_event, cosPaths: string[]) => {
  return deleteRemoteObjects(cosPaths)
})
```

- [ ] **Step 4: preload 注册 IPC 通道和 API**

在 `src/preload/index.ts` 的 `IPC_CHANNELS.STORYBOARD_SPLIT` 对象中追加:

```typescript
DELETE_REMOTE: 'storyboard-split:delete-remote',
```

在 `ElectronAPI` 接口中追加:

```typescript
storyboardSplitDeleteRemote: (cosPaths: string[]) => Promise<{ success: boolean; error?: string }>
```

在 `electronAPI` 实现的 `storyboardSplitSetDefaults` 之后追加:

```typescript
storyboardSplitDeleteRemote: (cosPaths: string[]) =>
  safeInvoke(IPC_CHANNELS.STORYBOARD_SPLIT.DELETE_REMOTE, cosPaths),
```

- [ ] **Step 5: 验证编译**

运行: `cd D:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit --pretty 2>&1 | head -30`

预期: 无错误。

- [ ] **Step 6: 验证 dev server**

运行: `cd D:\tecx\text\temp-ai-image-master-source && npm run dev`

预期: 启动无报错，切换到"宫格拆图" tab 能看到全新的 donor-theme 界面。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat(split): add COS deleteRemoteObjects IPC — fire-and-forget cleanup on history delete"
```

---

## 自检清单

| 检查项 | 状态 |
|--------|------|
| Spec §2 (Q1-Q10 设计决定) 每一项都有对应 Task | ✅ |
| Spec §3 (状态架构) → Task 2 完整实现 | ✅ |
| Spec §4 (组件结构) → Task 4-9 逐一实现 | ✅ |
| Spec §7 (ZIP 下载) → Task 3 zipDownload | ✅ |
| Spec §8 (删除) → Task 10 deleteRemoteObjects | ✅ |
| Spec §9 (SplitPreview) → Task 4 SINGLE/GRID 模式 | ✅ |
| R1: migrate v1→v2 → Task 2 Step 2 | ✅ |
| R2: Tailwind 静态映射 → Task 5 GRID_COLS_CLASS | ✅ |
| R3: COS deleteMultipleObject → Task 10 Step 1 | ✅ |
| 类型一致性: SplitHistoryItem 所有字段在 Task 1/2/9 一致 | ✅ |
| 无占位符 (TBD/TODO) | ✅ |
| 每步有完整代码 | ✅ |

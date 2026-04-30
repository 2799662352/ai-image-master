# Smart Erase — Progress Bar + Result Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an animated processing progress bar (asymptotic curve, renderer-side ticker) and replace the large inline video panel with a compact card grid + full-screen modal viewer.

**Architecture:** Renderer-only progress estimation decoupled from main-process polling. Three new React components (`EraseResultCard`, `EraseResultGrid`, `EraseResultModal`) replace `EraseResultPanel`. Main-process polling switches to exponential backoff. `<dialog>` element for native modal semantics.

**Tech Stack:** React 19, Zustand 5, Tailwind CSS 4, Vitest 4, jsdom 27 + polyfill, Playwright

**Spec:** `docs/superpowers/specs/2026-04-30-smart-erase-progress-and-cards-design.md`

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/renderer/src/pages-react/smart-erase/eraseProgress.ts` | Pure function: `computeProcessingProgress` |
| Create | `src/renderer/src/pages-react/smart-erase/eraseProgress.test.ts` | Unit tests for the curve |
| Create | `src/renderer/src/pages-react/smart-erase/useTicker.ts` | 1-second interval hook, active only when processing tasks exist |
| Create | `src/renderer/src/pages-react/smart-erase/EraseResultCard.tsx` | 180×160 thumbnail card |
| Create | `src/renderer/src/pages-react/smart-erase/EraseResultCard.test.tsx` | RTL tests for card badges + click |
| Create | `src/renderer/src/pages-react/smart-erase/EraseResultGrid.tsx` | Horizontal scrollable grid of cards (max 12) |
| Create | `src/renderer/src/pages-react/smart-erase/EraseResultModal.tsx` | Full-screen `<dialog>` video player + compare + toolbar |
| Create | `src/renderer/src/pages-react/smart-erase/EraseResultModal.test.tsx` | RTL tests with dialog polyfill |
| Create | `vitest.setup.ts` | HTMLDialogElement polyfill for jsdom |
| Modify | `src/types/smartErase.ts` | Add `processingStartedAt`, `mpsTaskId`, `finishedAt` to `EraseHistoryItem` |
| Modify | `src/renderer/src/stores/useEraseSessionStore.ts` | Add `modalItemId` + patch-based `updateTaskStatus` |
| Modify | `src/renderer/src/stores/useErasePersistStore.ts` | Bump persist version to 2 for new history fields |
| Modify | `src/renderer/src/pages-react/smart-erase/useEraseEvents.ts` | Write `processingStartedAt`, follow new `updateTaskStatus` signature, add `mpsTaskId`+`finishedAt` to history push |
| Modify | `src/renderer/src/pages-react/smart-erase/EraseQueue.tsx` | Add progress bar row + `useTicker` |
| Modify | `src/renderer/src/pages-react/smart-erase/EraseHistoryDrawer.tsx` | Rewire click to `setModalItemId` + keep `toggle()` |
| Modify | `src/renderer/src/pages-react/SmartErasePage.tsx` | Replace `<EraseResultPanel>` with Grid + Modal |
| Modify | `src/main/services/smartErase/runner.ts` | Replace tiered polling with exponential backoff |
| Modify | `src/main/services/smartErase/__tests__/runner.test.ts` | Update polling assertions |
| Modify | `electron.vite.config.ts` | Add `test.setupFiles` pointing to `vitest.setup.ts` |
| Delete | `src/renderer/src/pages-react/smart-erase/EraseResultPanel.tsx` | Replaced by Grid + Modal |

---

### Task 1: Progress curve + vitest setup (foundations)

**Files:**
- Create: `src/renderer/src/pages-react/smart-erase/eraseProgress.ts`
- Create: `src/renderer/src/pages-react/smart-erase/eraseProgress.test.ts`
- Create: `vitest.setup.ts`
- Modify: `electron.vite.config.ts`

- [ ] **Step 1: Create `eraseProgress.ts`**

```typescript
// src/renderer/src/pages-react/smart-erase/eraseProgress.ts
import type { EraseTask } from '../../../../types/smartErase'

export function computeProcessingProgress(opts: {
  startedAt: number
  durationSeconds: number
  status: EraseTask['status']
  now: number
}): number {
  if (opts.status === 'finished') return 100
  if (opts.status !== 'processing') return 0
  if (!Number.isFinite(opts.startedAt) || !Number.isFinite(opts.now)) return 0

  const elapsedSec = Math.max(0, (opts.now - opts.startedAt) / 1000)
  const safeDuration =
    Number.isFinite(opts.durationSeconds) && opts.durationSeconds > 0
      ? opts.durationSeconds
      : 0
  const tau = Math.max(15, safeDuration * 2)
  return Math.round(95 * (1 - Math.exp(-elapsedSec / tau)))
}
```

- [ ] **Step 2: Create `eraseProgress.test.ts`**

```typescript
// src/renderer/src/pages-react/smart-erase/eraseProgress.test.ts
import { describe, it, expect } from 'vitest'
import { computeProcessingProgress } from './eraseProgress'

const base = {
  startedAt: 1000000,
  durationSeconds: 30,
  status: 'processing' as const,
  now: 1000000,
}

describe('computeProcessingProgress', () => {
  it('finished → 100 regardless of elapsed', () => {
    expect(computeProcessingProgress({ ...base, status: 'finished' })).toBe(100)
  })

  it('queued-upload → 0', () => {
    expect(computeProcessingProgress({ ...base, status: 'queued-upload' })).toBe(0)
  })

  it('now < startedAt → clamp to 0', () => {
    expect(computeProcessingProgress({ ...base, now: base.startedAt - 5000 })).toBe(0)
  })

  it('startedAt = undefined (NaN guard) → 0', () => {
    expect(computeProcessingProgress({ ...base, startedAt: undefined as any })).toBe(0)
  })

  it('durationSeconds = 0 → tau = 15s floor', () => {
    const opts = { ...base, durationSeconds: 0, now: base.startedAt + 15000 }
    expect(computeProcessingProgress(opts)).toBe(60)
  })

  it('5s video: elapsed = τ (15s) → ~60%', () => {
    const opts = { ...base, durationSeconds: 5, now: base.startedAt + 15000 }
    expect(computeProcessingProgress(opts)).toBe(60)
  })

  it('5min video: elapsed = τ (600s) → ~60%', () => {
    const opts = { ...base, durationSeconds: 300, now: base.startedAt + 600_000 }
    expect(computeProcessingProgress(opts)).toBe(60)
  })

  it('progress increases over time', () => {
    const a = computeProcessingProgress({ ...base, now: base.startedAt + 5000 })
    const b = computeProcessingProgress({ ...base, now: base.startedAt + 30000 })
    expect(b).toBeGreaterThan(a)
  })

  it('never exceeds 95 for processing status', () => {
    const opts = { ...base, now: base.startedAt + 999_999_999 }
    expect(computeProcessingProgress(opts)).toBeLessThanOrEqual(95)
  })
})
```

- [ ] **Step 3: Create `vitest.setup.ts` with `<dialog>` polyfill**

```typescript
// vitest.setup.ts
if (typeof HTMLDialogElement !== 'undefined') {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true
    }
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function () {
      this.open = false
      this.dispatchEvent(new Event('close'))
    }
  }
}
```

- [ ] **Step 4: Wire vitest setup in `electron.vite.config.ts`**

Add the following `test` block at the top level of the default export (peer of `main`, `preload`, `renderer`):

```typescript
// electron.vite.config.ts — add at root level of defineConfig({})
// NOTE: electron-vite passes test config through to vitest
test: {
  setupFiles: ['./vitest.setup.ts'],
  environment: 'jsdom',
},
```

If `electron-vite` does not support a top-level `test` key, create `vitest.config.ts` instead:

```typescript
// vitest.config.ts (fallback)
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    environment: 'jsdom',
  },
})
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/renderer/src/pages-react/smart-erase/eraseProgress.test.ts`
Expected: all 8 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/pages-react/smart-erase/eraseProgress.ts src/renderer/src/pages-react/smart-erase/eraseProgress.test.ts vitest.setup.ts electron.vite.config.ts
git commit -m "feat(smart-erase): add computeProcessingProgress + vitest dialog polyfill"
```

---

### Task 2: Type + store refactor

**Files:**
- Modify: `src/types/smartErase.ts`
- Modify: `src/renderer/src/stores/useEraseSessionStore.ts`
- Modify: `src/renderer/src/stores/useErasePersistStore.ts`

- [ ] **Step 1: Add `processingStartedAt` to `EraseTask` in `src/types/smartErase.ts`**

After line 40 (`errorMessage?: string`), add:

```typescript
  processingStartedAt?: number   // ms; set by renderer when status → 'processing'
```

Also add `mpsTaskId` and `finishedAt` to `EraseHistoryItem`. After `createdAt: number` (line 54), add:

```typescript
  mpsTaskId?: string
  finishedAt?: number
```

- [ ] **Step 2: Refactor `useEraseSessionStore.ts`**

Replace the entire file with:

```typescript
import { create } from 'zustand'
import type { EraseTask, EraseProbeResult } from '../../../types/smartErase'

export interface EraseSessionTask extends EraseTask {
  filePath: string
  posterDataUrl: string
}

interface EraseSessionState {
  activeTasks: EraseSessionTask[]
  recentlyFinished: string | null
  selectedHistoryId: string | null
  modalItemId: string | null

  pendingProbes: EraseProbeResult[]
  showCostConfirm: boolean

  addTask: (task: EraseSessionTask) => void
  removeActiveTask: (taskId: string) => void
  updateTaskStatus: (
    taskId: string,
    status: EraseTask['status'],
    patch?: Partial<EraseSessionTask>,
  ) => void
  failTask: (taskId: string, errorMessage: string, errorCode?: string) => void
  cancelTask: (taskId: string) => void

  setRecentlyFinished: (id: string | null) => void
  setSelectedHistoryId: (id: string | null) => void
  setModalItemId: (id: string | null) => void

  setPendingProbes: (probes: EraseProbeResult[]) => void
  setShowCostConfirm: (open: boolean) => void
}

export const useEraseSessionStore = create<EraseSessionState>()((set) => ({
  activeTasks: [],
  recentlyFinished: null,
  selectedHistoryId: null,
  modalItemId: null,
  pendingProbes: [],
  showCostConfirm: false,

  addTask: (task) => set((s) => ({ activeTasks: [...s.activeTasks, task] })),

  removeActiveTask: (taskId) =>
    set((s) => ({ activeTasks: s.activeTasks.filter((t) => t.id !== taskId) })),

  updateTaskStatus: (taskId, status, patch) =>
    set((s) => ({
      activeTasks: s.activeTasks.map((t) =>
        t.id === taskId
          ? { ...t, ...patch, status }
          : t,
      ),
    })),

  failTask: (taskId, errorMessage, errorCode) =>
    set((s) => ({
      activeTasks: s.activeTasks.map((t) =>
        t.id === taskId
          ? { ...t, status: 'failed' as const, errorMessage, errorCode }
          : t,
      ),
    })),

  cancelTask: (taskId) =>
    set((s) => ({
      activeTasks: s.activeTasks.filter((t) => t.id !== taskId),
    })),

  setRecentlyFinished: (id) => set({ recentlyFinished: id }),
  setSelectedHistoryId: (id) => set({ selectedHistoryId: id }),
  setModalItemId: (id) => set({ modalItemId: id, selectedHistoryId: id }),

  setPendingProbes: (probes) => set({ pendingProbes: probes }),
  setShowCostConfirm: (open) => set({ showCostConfirm: open }),
}))
```

Key changes from current code:
- `updateTaskStatus` third arg changes from `(uploadProgress?, mpsTaskId?)` to `(patch?: Partial<EraseSessionTask>)`.
- New field `modalItemId` + setter `setModalItemId` that mirrors to `selectedHistoryId`.

- [ ] **Step 3: Bump persist version in `useErasePersistStore.ts`**

Change `version: 1` to `version: 2` on line 100. The new `mpsTaskId` and `finishedAt` fields on `EraseHistoryItem` are optional, so no migration function is needed — old items without these fields simply won't show a task ID or exact finish time on cards.

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: 1 error in `useEraseEvents.ts` (call site still uses old positional args). This is expected and will be fixed in Task 3.

- [ ] **Step 5: Commit**

```bash
git add src/types/smartErase.ts src/renderer/src/stores/useEraseSessionStore.ts src/renderer/src/stores/useErasePersistStore.ts
git commit -m "refactor(smart-erase): patch-based updateTaskStatus + modalItemId + history fields"
```

---

### Task 3: Update `useEraseEvents.ts`

**Files:**
- Modify: `src/renderer/src/pages-react/smart-erase/useEraseEvents.ts`

- [ ] **Step 1: Replace the file contents**

```typescript
// CRITICAL: do not move this hook out of SmartErasePage — see spec §A3.
// The current mount strategy (display:none toggle in react-app/main.tsx:238-260)
// guarantees this component never unmounts on tab switch. Moving to an unmount-
// based router would silently lose erase:finished events and pin the progress
// bar at 95% forever.
import { useEffect } from 'react'
import { useEraseSessionStore } from '../../stores/useEraseSessionStore'
import { useErasePersistStore } from '../../stores/useErasePersistStore'
import { useToastStore } from '../../stores'
import type {
  EraseProgressEvent,
  EraseFinishedEvent,
  EraseFailedEvent,
} from '../../../../types/smartErase'

const api = (window as any).electronAPI

export function useEraseEvents(): void {
  useEffect(() => {
    if (!api?.onSmartEraseEvent) return

    api.onSmartEraseEvent((channel: string, data: any) => {
      const session = useEraseSessionStore.getState()
      const persist = useErasePersistStore.getState()
      const toast = useToastStore.getState()

      if (channel === 'erase:progress') {
        const d = data as EraseProgressEvent
        const prev = session.activeTasks.find((t) => t.id === d.taskId)
        const patch: Partial<typeof prev & {}> = {
          uploadProgress: d.uploadProgress,
          mpsTaskId: d.mpsTaskId,
        }
        if (d.status === 'processing' && prev?.status !== 'processing') {
          patch.processingStartedAt = Date.now()
        }
        session.updateTaskStatus(d.taskId, d.status, patch)

        if (d.status === 'cancelled') {
          session.removeActiveTask(d.taskId)
          toast.addToast({ message: '已取消 / CANCELLED', type: 'info' })
        }
      } else if (channel === 'erase:finished') {
        const d = data as EraseFinishedEvent
        const task = session.activeTasks.find((t) => t.id === d.taskId)
        if (!task) return

        persist.pushHistory({
          id: task.id,
          filename: task.filename,
          fileSize: task.fileSize,
          durationSeconds: task.durationSeconds,
          videoUrl: d.videoUrl,
          videoExpiresAt: d.videoExpiresAt,
          posterDataUrl: task.posterDataUrl ?? '',
          outputCosKey: d.outputCosKey,
          inputCosKey: d.inputCosKey,
          originalFilePath: task.filePath ?? '',
          createdAt: task.startedAt,
          mpsTaskId: task.mpsTaskId,
          finishedAt: Date.now(),
        })
        session.removeActiveTask(d.taskId)
        session.setRecentlyFinished(task.id)
        setTimeout(() => {
          useEraseSessionStore.getState().setRecentlyFinished(null)
        }, 3000)
        toast.addToast({ message: '完成 / DONE', type: 'success' })
      } else if (channel === 'erase:failed') {
        const d = data as EraseFailedEvent
        session.failTask(d.taskId, d.errorMessage, d.errorCode)
        toast.addToast({
          message: d.errorMessage || '处理失败 / FAILED',
          type: 'error',
        })
      }
    })

    return () => {
      api.removeSmartEraseListeners?.()
    }
  }, [])
}
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (0 errors)

- [ ] **Step 3: Run existing tests**

Run: `npx vitest run`
Expected: all existing tests pass

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/pages-react/smart-erase/useEraseEvents.ts
git commit -m "feat(smart-erase): useEraseEvents writes processingStartedAt + history fields"
```

---

### Task 4: `useTicker` hook + progress bar in `EraseQueue`

**Files:**
- Create: `src/renderer/src/pages-react/smart-erase/useTicker.ts`
- Modify: `src/renderer/src/pages-react/smart-erase/EraseQueue.tsx`

- [ ] **Step 1: Create `useTicker.ts`**

```typescript
// src/renderer/src/pages-react/smart-erase/useTicker.ts
import { useState, useEffect } from 'react'

export function useTicker(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [active, intervalMs])

  return now
}
```

- [ ] **Step 2: Add progress bar to `EraseQueue.tsx`**

Replace the entire file:

```typescript
import { useEraseSessionStore, type EraseSessionTask } from '../../stores/useEraseSessionStore'
import type { EraseTask } from '../../../../types/smartErase'
import { computeProcessingProgress } from './eraseProgress'
import { useTicker } from './useTicker'

const api = (window as any).electronAPI

const STATUS_LABEL: Record<EraseTask['status'], string> = {
  'queued-upload': '排队上传',
  uploading: '上传中',
  'queued-process': '排队处理',
  submitting: '提交中',
  processing: '处理中',
  finished: '完成',
  failed: '失败',
  cancelled: '已取消',
}

const STATUS_COLOR: Record<EraseTask['status'], string> = {
  'queued-upload': 'var(--donor-ink-mute)',
  uploading: 'var(--donor-cyan)',
  'queued-process': 'var(--donor-ink-mute)',
  submitting: 'var(--donor-yellow)',
  processing: 'var(--donor-yellow)',
  finished: 'var(--donor-green)',
  failed: 'var(--donor-red)',
  cancelled: 'var(--donor-ink-dim)',
}

export function EraseQueue() {
  const tasks = useEraseSessionStore((s) => s.activeTasks)
  const hasProcessing = tasks.some((t) => t.status === 'processing')
  const now = useTicker(hasProcessing)

  if (tasks.length === 0) return null

  const counts = countByPhase(tasks)

  return (
    <div className="d-neon-frame p-4 space-y-3">
      <div className="flex items-center gap-3 flex-wrap d-mono text-[11px] tracking-widest uppercase">
        <Counter label="QUEUE" value={counts.queued} color="var(--donor-ink-mute)" />
        <Counter label="UPLOAD" value={counts.uploading} color="var(--donor-cyan)" />
        <Counter label="PROC" value={counts.processing} color="var(--donor-yellow)" />
        <Counter label="FAIL" value={counts.failed} color="var(--donor-red)" />
      </div>

      <ul className="space-y-1.5">
        {tasks.map((t) => (
          <TaskRow key={t.id} task={t} now={now} />
        ))}
      </ul>
    </div>
  )
}

function TaskRow({ task: t, now }: { task: EraseSessionTask; now: number }) {
  const barPercent = getBarPercent(t, now)

  return (
    <li className="px-3 py-2 border border-[color:var(--donor-ink-mute)]/30 d-mono text-[11px] space-y-1">
      <div className="flex items-center gap-3">
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: STATUS_COLOR[t.status] }}
        />
        <span className="truncate flex-1 text-[color:var(--donor-ink)]">
          {t.filename}
        </span>
        <span
          className="text-[10px] tracking-widest uppercase flex-shrink-0"
          style={{ color: STATUS_COLOR[t.status] }}
        >
          {STATUS_LABEL[t.status]}
          {t.status === 'uploading' && t.uploadProgress != null
            ? ` ${t.uploadProgress}%`
            : ''}
          {t.status === 'processing' && barPercent > 0
            ? ` ${barPercent}%`
            : ''}
        </span>
        {t.status !== 'failed' && t.status !== 'cancelled' && (
          <button
            type="button"
            onClick={() => void api?.smartEraseCancel?.(t.id)}
            className="text-[10px] text-[color:var(--donor-ink-dim)] hover:text-[color:var(--donor-red)] tracking-widest"
            title="取消任务"
          >
            [×]
          </button>
        )}
      </div>
      {barPercent > 0 && (
        <div className="h-1 bg-[color:var(--donor-ink-mute)]/20 overflow-hidden">
          <div
            className="h-full transition-all duration-1000 ease-out"
            style={{
              width: `${barPercent}%`,
              backgroundColor:
                t.status === 'failed' ? 'var(--donor-red)' : STATUS_COLOR[t.status],
            }}
          />
        </div>
      )}
    </li>
  )
}

function getBarPercent(t: EraseSessionTask, now: number): number {
  if (t.status === 'uploading') return t.uploadProgress ?? 0
  if (t.status === 'processing') {
    return computeProcessingProgress({
      startedAt: t.processingStartedAt ?? 0,
      durationSeconds: t.durationSeconds,
      status: t.status,
      now,
    })
  }
  return 0
}

function Counter({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <span className="px-2 py-0.5 border" style={{ borderColor: color, color }}>
      {label} {value}
    </span>
  )
}

function countByPhase(tasks: EraseTask[]) {
  let queued = 0, uploading = 0, processing = 0, failed = 0
  for (const t of tasks) {
    switch (t.status) {
      case 'queued-upload': case 'queued-process': queued++; break
      case 'uploading': uploading++; break
      case 'submitting': case 'processing': processing++; break
      case 'failed': failed++; break
    }
  }
  return { queued, uploading, processing, failed }
}
```

- [ ] **Step 3: Run typecheck + tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/pages-react/smart-erase/useTicker.ts src/renderer/src/pages-react/smart-erase/EraseQueue.tsx
git commit -m "feat(smart-erase): progress bar in EraseQueue with useTicker + asymptotic curve"
```

---

### Task 5: Exponential backoff polling in `runner.ts`

**Files:**
- Modify: `src/main/services/smartErase/runner.ts`
- Modify: `src/main/services/smartErase/__tests__/runner.test.ts`

- [ ] **Step 1: Replace polling constants + function in `runner.ts`**

Delete these lines (12–18):

```typescript
const POLL_INTERVAL_FAST_MS = 5_000
const POLL_INTERVAL_MED_MS = 10_000
const POLL_INTERVAL_SLOW_MS = 15_000

const FAST_THRESHOLD = 6
const MED_THRESHOLD = 36
```

Replace the `pollIntervalMs` function (lines 97–101) with:

```typescript
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

Note: export it so the test can import directly.

- [ ] **Step 2: Add polling tests to `runner.test.ts`**

Add a new `describe` block at the end of the file, before the final closing `})`:

```typescript
describe('pollIntervalMs (exponential backoff)', () => {
  it('attempt 1 → 5000ms', async () => {
    const { pollIntervalMs } = await import('../runner')
    expect(pollIntervalMs(1)).toBe(5000)
  })

  it('attempt 2 → 7000ms', async () => {
    const { pollIntervalMs } = await import('../runner')
    expect(pollIntervalMs(2)).toBe(7000)
  })

  it('attempt 3 → 9800ms', async () => {
    const { pollIntervalMs } = await import('../runner')
    expect(pollIntervalMs(3)).toBe(9800)
  })

  it('attempt 5 → 19208ms', async () => {
    const { pollIntervalMs } = await import('../runner')
    expect(pollIntervalMs(5)).toBe(19208)
  })

  it('attempt 10 → 60000ms (cap)', async () => {
    const { pollIntervalMs } = await import('../runner')
    expect(pollIntervalMs(10)).toBe(60000)
  })

  it('attempt 20 → still 60000ms (cap holds)', async () => {
    const { pollIntervalMs } = await import('../runner')
    expect(pollIntervalMs(20)).toBe(60000)
  })
})
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/main/services/smartErase/__tests__/runner.test.ts`
Expected: all tests pass (existing 17 + new 6 = 23)

- [ ] **Step 4: Commit**

```bash
git add src/main/services/smartErase/runner.ts src/main/services/smartErase/__tests__/runner.test.ts
git commit -m "perf(smart-erase): exponential backoff polling (5s×1.4^n cap 60s, ~74% fewer calls)"
```

---

### Task 6: `EraseResultCard` + test

**Files:**
- Create: `src/renderer/src/pages-react/smart-erase/EraseResultCard.tsx`
- Create: `src/renderer/src/pages-react/smart-erase/EraseResultCard.test.tsx`

- [ ] **Step 1: Create `EraseResultCard.tsx`**

```tsx
import type { EraseHistoryItem } from '../../../../types/smartErase'
import { useEraseSessionStore } from '../../stores/useEraseSessionStore'

export function EraseResultCard({
  item,
  highlight,
}: {
  item: EraseHistoryItem
  highlight?: boolean
}) {
  const setModalItemId = useEraseSessionStore((s) => s.setModalItemId)

  const expired = item.videoExpiresAt > 0 && item.videoExpiresAt < Date.now()
  const expiryMs = item.videoExpiresAt - Date.now()
  const expiryBadge = expired
    ? { text: '已过期', color: 'var(--donor-red)' }
    : expiryMs < 24 * 60 * 60 * 1000
      ? { text: `${Math.ceil(expiryMs / 3_600_000)}h`, color: 'var(--donor-yellow)' }
      : { text: `${Math.ceil(expiryMs / 86_400_000)}d`, color: 'var(--donor-ink-mute)' }

  const ts = item.finishedAt ?? item.createdAt
  const dateStr = new Date(ts).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
  const timeStr = new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

  return (
    <button
      type="button"
      onClick={() => setModalItemId(item.id)}
      aria-label={`查看 ${item.filename} 处理结果`}
      className={`
        w-[180px] h-[160px] flex-shrink-0 flex flex-col
        border border-[color:var(--donor-ink-mute)]/40 cursor-pointer
        hover:ring-1 hover:ring-[color:var(--donor-cyan)]
        transition-shadow duration-200
        ${highlight ? 'ring-2 ring-[color:var(--donor-green)] ring-offset-2 ring-offset-[color:var(--donor-bg-0)]' : ''}
      `}
    >
      <div className="flex items-center justify-between px-2 py-1">
        <span className="d-mono text-[9px] tracking-widest px-1.5 py-0.5 border border-[color:var(--donor-green)]/60 text-[color:var(--donor-green)]">
          DONE
        </span>
        <span
          className="d-mono text-[9px] tracking-widest px-1.5 py-0.5 border"
          style={{ borderColor: expiryBadge.color, color: expiryBadge.color }}
        >
          {expiryBadge.text}
        </span>
      </div>

      <div className="flex-1 bg-black overflow-hidden">
        {item.posterDataUrl ? (
          <img src={item.posterDataUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="d-mono text-[color:var(--donor-ink-mute)] text-lg">▶</span>
          </div>
        )}
      </div>

      <div className="px-2 py-1 space-y-0.5">
        <div className="d-mono text-[11px] truncate text-[color:var(--donor-ink)] text-left">
          {item.filename}
        </div>
        <div className="d-mono text-[10px] text-[color:var(--donor-ink-mute)] text-left truncate">
          {dateStr} {timeStr}
          ·{formatDuration(item.durationSeconds)}
          ·{formatBytes(item.fileSize)}
          {item.mpsTaskId ? `·#${item.mpsTaskId.slice(-6)}` : ''}
        </div>
      </div>
    </button>
  )
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`
}
```

- [ ] **Step 2: Create `EraseResultCard.test.tsx`**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EraseResultCard } from './EraseResultCard'
import type { EraseHistoryItem } from '../../../../types/smartErase'

vi.mock('../../stores/useEraseSessionStore', () => {
  const setModalItemId = vi.fn()
  return {
    useEraseSessionStore: (selector: any) => selector({ setModalItemId }),
    __setModalItemId: setModalItemId,
  }
})

function makeItem(overrides: Partial<EraseHistoryItem> = {}): EraseHistoryItem {
  return {
    id: 'item-1',
    filename: 'test.mp4',
    fileSize: 8_000_000,
    durationSeconds: 15,
    videoUrl: 'https://cos.example.com/output.mp4',
    videoExpiresAt: Date.now() + 6 * 86_400_000,
    posterDataUrl: '',
    outputCosKey: 'out/key',
    inputCosKey: 'in/key',
    originalFilePath: '/local/test.mp4',
    createdAt: Date.now() - 60_000,
    ...overrides,
  }
}

describe('EraseResultCard', () => {
  it('renders DONE badge', () => {
    render(<EraseResultCard item={makeItem()} />)
    expect(screen.getByText('DONE')).toBeTruthy()
  })

  it('shows expiry days badge when > 1 day', () => {
    render(<EraseResultCard item={makeItem({ videoExpiresAt: Date.now() + 6 * 86_400_000 })} />)
    expect(screen.getByText('6d')).toBeTruthy()
  })

  it('shows expiry hours badge when < 24h', () => {
    render(<EraseResultCard item={makeItem({ videoExpiresAt: Date.now() + 4 * 3_600_000 })} />)
    expect(screen.getByText('4h')).toBeTruthy()
  })

  it('shows 已过期 badge when expired', () => {
    render(<EraseResultCard item={makeItem({ videoExpiresAt: Date.now() - 1000 })} />)
    expect(screen.getByText('已过期')).toBeTruthy()
  })

  it('shows truncated filename', () => {
    render(<EraseResultCard item={makeItem({ filename: 'my_long_video_name.mp4' })} />)
    expect(screen.getByText('my_long_video_name.mp4')).toBeTruthy()
  })

  it('calls setModalItemId on click', async () => {
    const mod = await import('../../stores/useEraseSessionStore')
    const mockFn = (mod as any).__setModalItemId
    mockFn.mockClear()

    render(<EraseResultCard item={makeItem()} />)
    screen.getByRole('button').click()
    expect(mockFn).toHaveBeenCalledWith('item-1')
  })
})
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/renderer/src/pages-react/smart-erase/EraseResultCard.test.tsx`
Expected: all 6 tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/pages-react/smart-erase/EraseResultCard.tsx src/renderer/src/pages-react/smart-erase/EraseResultCard.test.tsx
git commit -m "feat(smart-erase): EraseResultCard with badges, metadata, a11y button"
```

---

### Task 7: `EraseResultGrid` + `EraseResultModal` + modal test

**Files:**
- Create: `src/renderer/src/pages-react/smart-erase/EraseResultGrid.tsx`
- Create: `src/renderer/src/pages-react/smart-erase/EraseResultModal.tsx`
- Create: `src/renderer/src/pages-react/smart-erase/EraseResultModal.test.tsx`

- [ ] **Step 1: Create `EraseResultGrid.tsx`**

```tsx
import { useErasePersistStore } from '../../stores/useErasePersistStore'
import { useEraseSessionStore } from '../../stores/useEraseSessionStore'
import { EraseResultCard } from './EraseResultCard'

const MAX_GRID_ITEMS = 12

export function EraseResultGrid() {
  const history = useErasePersistStore((s) => s.history)
  const hydrated = useErasePersistStore((s) => s._hasHydrated)
  const recentlyFinished = useEraseSessionStore((s) => s.recentlyFinished)

  if (!hydrated || history.length === 0) return null

  const items = history.slice(0, MAX_GRID_ITEMS)

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {items.map((item) => (
        <EraseResultCard
          key={item.id}
          item={item}
          highlight={item.id === recentlyFinished}
        />
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Create `EraseResultModal.tsx`**

```tsx
import { useRef, useEffect, useState, useMemo } from 'react'
import { useEraseSessionStore } from '../../stores/useEraseSessionStore'
import { useErasePersistStore } from '../../stores/useErasePersistStore'
import { useToastStore } from '../../stores'

const api = (window as any).electronAPI

export function EraseResultModal() {
  const modalItemId = useEraseSessionStore((s) => s.modalItemId)
  const setModalItemId = useEraseSessionStore((s) => s.setModalItemId)
  const history = useErasePersistStore((s) => s.history)
  const removeHistory = useErasePersistStore((s) => s.removeHistory)
  const addToast = useToastStore((s) => s.addToast)

  const dialogRef = useRef<HTMLDialogElement>(null)
  const [compareOpen, setCompareOpen] = useState(false)
  const [originalErrored, setOriginalErrored] = useState(false)

  const item = useMemo(
    () => history.find((h) => h.id === modalItemId),
    [history, modalItemId],
  )

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (item) {
      if (!dialog.open) dialog.showModal()
    } else {
      if (dialog.open) dialog.close()
    }
  }, [item])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const onClose = () => {
      setModalItemId(null)
      setCompareOpen(false)
      setOriginalErrored(false)
    }
    dialog.addEventListener('close', onClose)
    return () => dialog.removeEventListener('close', onClose)
  }, [setModalItemId])

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) dialogRef.current?.close()
  }

  if (!item) return <dialog ref={dialogRef} className="hidden" />

  const expired = item.videoExpiresAt > 0 && item.videoExpiresAt < Date.now()
  const canCompare = !!item.originalFilePath && !originalErrored

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(item.videoUrl)
      addToast({ message: 'URL 已复制', type: 'success' })
    } catch {
      addToast({ message: '复制失败', type: 'error' })
    }
  }

  const handleDownload = () => {
    if (expired) { addToast({ message: 'URL 已过期', type: 'error' }); return }
    const downloadName = item.filename.replace(/\.[^.]+$/, '') + '_erased.mp4'
    const sep = item.videoUrl.includes('?') ? '&' : '?'
    const downloadUrl =
      item.videoUrl + sep +
      'response-content-disposition=' +
      encodeURIComponent(`attachment; filename="${downloadName}"`)
    const a = document.createElement('a')
    a.href = downloadUrl
    a.download = downloadName
    a.target = '_blank'
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const handleRemove = () => {
    const cosKeys = [item.outputCosKey, item.inputCosKey].filter(Boolean) as string[]
    if (cosKeys.length > 0) {
      api?.smartEraseDeleteRemote?.(cosKeys)?.catch((err: unknown) => {
        console.warn('[smart-erase] remote delete failed:', err)
      })
    }
    removeHistory(item.id)
    dialogRef.current?.close()
  }

  return (
    <dialog
      ref={dialogRef}
      onClick={handleBackdropClick}
      className="backdrop:bg-black/85 backdrop:backdrop-blur-sm bg-transparent p-0 max-w-[1000px] w-full mx-auto border-0"
    >
      <div
        className="bg-[color:var(--donor-bg-0)] border border-[color:var(--donor-cyan)]/40 p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="d-mono text-[12px] tracking-widest text-[color:var(--donor-cyan)]">
            ⊳ {item.filename}
          </span>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className="d-mono text-xs text-[color:var(--donor-ink-dim)] hover:text-[color:var(--donor-red)]"
          >
            [×]
          </button>
        </div>

        <div className={`grid gap-3 ${compareOpen && canCompare ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {compareOpen && canCompare && (
            <div className="space-y-1">
              <div className="d-mono text-[10px] tracking-widest text-[color:var(--donor-ink-mute)]">
                // ORIGINAL
              </div>
              <video
                key={`orig-${item.id}`}
                src={`file:///${item.originalFilePath.replace(/\\/g, '/')}`}
                controls
                className="w-full max-h-[60vh] object-contain mx-auto bg-black"
                onError={() => setOriginalErrored(true)}
              />
            </div>
          )}
          <div className="space-y-1">
            {compareOpen && canCompare && (
              <div className="d-mono text-[10px] tracking-widest text-[color:var(--donor-green)]">
                // ERASED
              </div>
            )}
            <video
              key={`out-${item.id}`}
              src={item.videoUrl}
              poster={item.posterDataUrl || undefined}
              controls
              className="w-full max-h-[60vh] object-contain mx-auto bg-black"
            />
          </div>
        </div>

        <div className="flex gap-2 flex-wrap">
          {canCompare && (
            <button
              type="button"
              onClick={() => setCompareOpen((v) => !v)}
              className="d-mono text-[10px] tracking-widest px-3 py-1.5 border border-[color:var(--donor-cyan)] text-[color:var(--donor-cyan)] hover:bg-[color:var(--donor-cyan)]/10"
            >
              {compareOpen ? '[ 关闭对比 ]' : '[ 对比原视频 ]'}
            </button>
          )}
          <button
            type="button"
            onClick={handleDownload}
            disabled={expired}
            className="d-mono text-[10px] tracking-widest px-3 py-1.5 border border-[color:var(--donor-green)] text-[color:var(--donor-green)] hover:bg-[color:var(--donor-green)]/10 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            [ 下载 ]
          </button>
          <button
            type="button"
            onClick={handleCopyUrl}
            disabled={expired}
            className="d-mono text-[10px] tracking-widest px-3 py-1.5 border border-[color:var(--donor-ink)] text-[color:var(--donor-ink)] hover:bg-[color:var(--donor-ink)]/10 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            [ 复制 URL ]
          </button>
          <button
            type="button"
            onClick={handleRemove}
            className="d-mono text-[10px] tracking-widest px-3 py-1.5 border border-[color:var(--donor-red)]/60 text-[color:var(--donor-red)]/80 hover:bg-[color:var(--donor-red)]/10 ml-auto"
          >
            [ 移除历史 ]
          </button>
        </div>
      </div>
    </dialog>
  )
}
```

- [ ] **Step 3: Create `EraseResultModal.test.tsx`**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { EraseResultModal } from './EraseResultModal'

const setModalItemId = vi.fn()

vi.mock('../../stores/useEraseSessionStore', () => ({
  useEraseSessionStore: (sel: any) => sel({
    modalItemId: 'item-1',
    setModalItemId,
  }),
}))

vi.mock('../../stores/useErasePersistStore', () => ({
  useErasePersistStore: (sel: any) => sel({
    history: [{
      id: 'item-1',
      filename: 'test.mp4',
      fileSize: 5_000_000,
      durationSeconds: 10,
      videoUrl: 'https://cos.example.com/out.mp4',
      videoExpiresAt: Date.now() + 86_400_000,
      posterDataUrl: '',
      outputCosKey: 'out/k',
      inputCosKey: 'in/k',
      originalFilePath: '/local/test.mp4',
      createdAt: Date.now(),
    }],
    removeHistory: vi.fn(),
    _hasHydrated: true,
  }),
}))

vi.mock('../../stores', () => ({
  useToastStore: (sel: any) => sel({ addToast: vi.fn() }),
}))

describe('EraseResultModal', () => {
  beforeEach(() => {
    setModalItemId.mockClear()
  })

  it('opens dialog when modalItemId matches a history item', () => {
    render(<EraseResultModal />)
    const dialog = document.querySelector('dialog')
    expect(dialog?.open).toBe(true)
  })

  it('calls setModalItemId(null) when dialog close event fires', () => {
    render(<EraseResultModal />)
    const dialog = document.querySelector('dialog')
    act(() => { dialog?.close() })
    expect(setModalItemId).toHaveBeenCalledWith(null)
  })

  it('displays filename in modal header', () => {
    render(<EraseResultModal />)
    expect(screen.getByText(/test\.mp4/)).toBeTruthy()
  })
})
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/renderer/src/pages-react/smart-erase/EraseResultModal.test.tsx`
Expected: all 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/pages-react/smart-erase/EraseResultGrid.tsx src/renderer/src/pages-react/smart-erase/EraseResultModal.tsx src/renderer/src/pages-react/smart-erase/EraseResultModal.test.tsx
git commit -m "feat(smart-erase): EraseResultGrid + EraseResultModal with dialog close contract"
```

---

### Task 8: Wire new components + rewire drawer

**Files:**
- Modify: `src/renderer/src/pages-react/smart-erase/EraseHistoryDrawer.tsx`
- Modify: `src/renderer/src/pages-react/SmartErasePage.tsx`

- [ ] **Step 1: Rewire `EraseHistoryDrawer.tsx`**

Replace lines 20-21 (the `selectedId` / `setSelectedHistoryId` imports):

```typescript
  const selectedId = useEraseSessionStore((s) => s.selectedHistoryId)
  const setModalItemId = useEraseSessionStore((s) => s.setModalItemId)
```

Replace lines 96-99 (the `onSelect` handler in `HistoryRow` mapping):

```typescript
                      onSelect={() => {
                        setModalItemId(h.id)
                        toggle()
                      }}
```

Remove the now-unused `setSelectedHistoryId` import (the `selectedId` variable is still used for highlighting).

- [ ] **Step 2: Update `SmartErasePage.tsx`**

Replace the import of `EraseResultPanel`:

```typescript
// DELETE: import { EraseResultPanel } from './smart-erase/EraseResultPanel'
import { EraseResultGrid } from './smart-erase/EraseResultGrid'
import { EraseResultModal } from './smart-erase/EraseResultModal'
```

Replace `<EraseResultPanel />` (line 95) with:

```tsx
        <EraseResultGrid />
        <EraseResultModal />
```

- [ ] **Step 3: Run typecheck + build**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS. There may be a warning about unused `EraseResultPanel.tsx` — that's fine; we delete it in Task 9.

- [ ] **Step 4: Manual smoke test**

Run: `npm run dev`
1. Upload a short video → verify progress bar animates during upload + processing
2. Wait for completion → verify card appears in the grid
3. Click a card → verify modal opens with video
4. Press ESC → verify modal closes
5. Click "历史" → verify drawer opens, click an item → modal opens + drawer closes
6. Verify no console errors

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/pages-react/smart-erase/EraseHistoryDrawer.tsx src/renderer/src/pages-react/SmartErasePage.tsx
git commit -m "feat(smart-erase): wire Grid+Modal into page, rewire drawer to setModalItemId"
```

---

### Task 9: Cleanup — delete `EraseResultPanel.tsx`

**Files:**
- Delete: `src/renderer/src/pages-react/smart-erase/EraseResultPanel.tsx`

- [ ] **Step 1: Delete the file**

```bash
rm src/renderer/src/pages-react/smart-erase/EraseResultPanel.tsx
```

- [ ] **Step 2: Verify no remaining imports**

Run: `npx tsc --noEmit`
Expected: PASS (0 errors — all imports were removed in Task 8)

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass

- [ ] **Step 4: Run vite build**

Run: `npm run build:vite`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(smart-erase): delete EraseResultPanel.tsx (replaced by Grid+Modal)"
```

---

## Post-Implementation Verification

After all 9 tasks are committed:

```bash
npx tsc --noEmit && npx vitest run && npm run build:vite
```

All three must pass. Then manual smoke:

1. Upload a 5s clip → progress bar reaches ~60% by 15s elapsed, then jumps to 100% on finish
2. Upload a 30s clip → progress bar is noticeably slower (τ=60s, not 15s)
3. Grid shows the most recent 12 items with thumbnails
4. Click a card → full-screen modal with video + compare + download + copy URL + remove
5. Drawer still works: click item → modal opens, drawer closes
6. ESC / backdrop click / [×] all close the modal cleanly
7. Re-click same card after closing → modal re-opens (close contract working)

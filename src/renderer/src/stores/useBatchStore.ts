import { create } from 'zustand'
import type { ApiActions } from '../hooks/useService'
import { useTemplateStore } from '../react-app/stores/useTemplateStore'
import { composePromptWithTemplate } from '../react-app/constants/templates'

export type BatchMode = 'card' | 'multi'

export interface BatchItem {
  id: string
  prompt: string
  status: 'pending' | 'generating' | 'done' | 'error'
  resultUrl?: string
  error?: string
}

export interface BatchRefImage {
  id: string
  base64: string         // dataURL or pure base64 (传给 generateImage)
  fileName: string
  fileSize: number
  width?: number
  height?: number
}

export interface BatchRunOpts {
  ratio?: string
  resolution?: string
  referenceImages?: string[]      // base64 数组(去掉 dataURL prefix 的纯 base64)
  perPromptCount?: number          // 每条 prompt 跑几次(扩张到 items)
  concurrency?: number             // 并发数, 默认 3
  /**
   * Worker idle-exit grace period (ms). When a worker finds no pending item
   * it polls every ~80ms; if the queue stays empty for this long, the
   * worker exits. Larger value = more responsive to mid-run `addItem` calls
   * (worker stays warm a bit longer), smaller value = batch wraps up faster
   * after the last item completes. Tests pass 0 to make `runBatch` resolve
   * immediately. @default 300
   */
  idleExitMs?: number
}

export interface BatchState {
  // ---- 队列(原有) ----
  items: BatchItem[]
  running: boolean
  _abortController: AbortController | null
  /**
   * Closure exposed by an in-flight `runBatch` so external actions (mostly
   * `addItem`) can spawn one more live worker on demand. Lives only for the
   * lifetime of a single `runBatch`; cleared in its `finally`. The closure
   * itself enforces the `HARD_MAX_WORKERS` ceiling internally — callers
   * can call it freely without thinking about the cap.
   */
  _spawnWorker: (() => void) | null

  // ---- 新增 UI 配置 ----
  mode: BatchMode
  cardPrompt: string
  cardCount: number          // 抽卡数量 2-10
  multiText: string          // 多提示词模式 textarea 缓冲
  ratio: string              // auto / 1:1 / 2:3 / 3:2
  resolution: string         // 0.5K / 1K / 2K / 4K
  perPromptCount: number     // 多提示词模式下每条出几张 (1-2)
  concurrency: number        // 1-6
  refImages: BatchRefImage[]

  // ---- actions: 队列 ----
  addItem: (prompt: string) => void
  removeItem: (id: string) => void
  clearAll: () => void
  runBatch: (api: ApiActions, modelKey: string, opts?: BatchRunOpts) => Promise<void>
  cancelBatch: () => void

  // ---- actions: 配置 ----
  setMode: (mode: BatchMode) => void
  setCardPrompt: (s: string) => void
  setCardCount: (n: number) => void
  setMultiText: (s: string) => void
  setRatio: (r: string) => void
  setResolution: (r: string) => void
  setPerPromptCount: (n: number) => void
  setConcurrency: (n: number) => void
  addRefImage: (img: BatchRefImage) => void
  removeRefImage: (id: string) => void
  clearRefImages: () => void
}

export const initialState = {
  items: [] as BatchItem[],
  running: false,
  _abortController: null as AbortController | null,
  _spawnWorker: null as (() => void) | null,
  mode: 'card' as BatchMode,
  cardPrompt: '',
  cardCount: 5,
  multiText: '',
  ratio: 'auto',
  resolution: '2K',
  perPromptCount: 1,
  concurrency: 3,
  refImages: [] as BatchRefImage[],
}

/**
 * Hard ceiling on simultaneously live workers, independent of the user's
 * `concurrency` slider value. Mirrors the slider's upper bound (1–6) so a
 * user with CONC=3 who clicks "加入队列 × 3" mid-run can momentarily burst
 * to 6 workers — but never to 7+, which would just hammer the upstream API.
 *
 * The slider sets the *initial* pool size; addItem-triggered spawns can
 * grow the pool up to this cap.
 */
const HARD_MAX_WORKERS = 6

/** 把 dataURL 切掉头, 只返回 base64 主体; 已经是纯 base64 则原样返回 */
function stripDataUrl(s: string): string {
  const idx = s.indexOf(',')
  return idx >= 0 && s.startsWith('data:') ? s.slice(idx + 1) : s
}

export const useBatchStore = create<BatchState>((set, get) => ({
  ...initialState,

  addItem: (prompt) => {
    set((s) => ({
      items: [...s.items, { id: crypto.randomUUID(), prompt, status: 'pending' }],
    }))
    // If a batch is in flight, kick a brand-new worker so this freshly
    // added item starts running immediately instead of waiting for one
    // of the in-flight API calls to drain a slot. The closure internally
    // honors `HARD_MAX_WORKERS`, so a user spamming addItem cannot
    // overflow the API.
    //
    // Why this matters (regression report 2026-05-15): with the old
    // fixed-pool design, CONC=3 meant "exactly 3 workers ever". Clicking
    // `加入队列 × 3` mid-run just queued items behind the in-flight 3 —
    // so the user reported "二次任务我发上去了 第二次 第一个 任务不会
    // 开始" because they had to wait for batch 1 to resolve a slot.
    // Now each addItem during a run can grow the pool up to HARD_MAX.
    const spawn = get()._spawnWorker
    if (spawn && get().running) spawn()
  },

  removeItem: (id) => {
    set((s) => ({
      items: s.items.filter((i) => i.id !== id),
    }))
    if (get().running) {
      const { items, _abortController: ac } = get()
      const hasWork = items.some((i) => i.status === 'pending' || i.status === 'generating')
      if (!hasWork) {
        if (ac) ac.abort()
        set({ running: false, _abortController: null, _spawnWorker: null })
      }
    }
  },

  clearAll: () => set({ items: [] }),

  cancelBatch: () => {
    if (!get().running) return
    const ac = get()._abortController
    if (ac) ac.abort()
    set((state) => ({
      running: false,
      _abortController: null,
      _spawnWorker: null,
      items: state.items.map((i) =>
        i.status === 'generating' || i.status === 'pending'
          ? { ...i, status: 'error' as const, error: '已取消' }
          : i
      ),
    }))
  },

  runBatch: async (api, modelKey, opts) => {
    // Single-flight guard. A second `runBatch` while one is in flight is a
    // no-op — but that's NOT the same as "second click is ignored": the
    // BatchPage's `handleGenerate` first appends new items via `addItem`,
    // which then wakes a fresh worker through the `_spawnWorker` closure
    // we publish below. So clicking "+ 加入队列 × 3" mid-run results in
    // (up to) 3 new live workers without ever re-entering `runBatch`.
    if (get().running) return

    const pending = get().items.filter((i) => i.status === 'pending')
    if (pending.length === 0) return

    const ac = new AbortController()

    const ratio = opts?.ratio ?? get().ratio
    const resolution = opts?.resolution ?? get().resolution
    const refRaw = opts?.referenceImages ?? get().refImages.map((r) => r.base64)
    const referenceImages = refRaw.map(stripDataUrl).filter(Boolean)
    const concurrency = Math.max(1, Math.min(HARD_MAX_WORKERS, opts?.concurrency ?? get().concurrency))
    const idleExitMs = Math.max(0, opts?.idleExitMs ?? 300)
    const POLL_IDLE_MS = 80

    /**
     * Atomically claim the first pending item. The whole read-and-flip
     * happens inside a single `set` callback so two workers racing on the
     * same item don't both pick it up — the second worker's `set` runs
     * after the first's update is committed, sees `generating`, and
     * returns null.
     */
    const claimNextPending = (): BatchItem | null => {
      let claimed: BatchItem | null = null
      set((state) => {
        const next = state.items.find((i) => i.status === 'pending')
        if (!next) return state
        claimed = { ...next, status: 'generating' as const }
        return {
          items: state.items.map((i) =>
            i.id === next.id ? { ...i, status: 'generating' as const } : i
          ),
        }
      })
      return claimed
    }

    // ─── Worker pool bookkeeping ────────────────────────────────────────
    // `activeCount` is the # of currently-live `runOne` invocations. The
    // pool is dynamic: it starts at `concurrency`, and `addItem` can grow
    // it via `spawnWorker` up to `HARD_MAX_WORKERS`. `workerTasks` is the
    // promise array we drain — the drain loop below re-checks it after
    // each `Promise.all` because mid-run spawns push new entries.
    let activeCount = 0
    const workerTasks: Promise<void>[] = []

    const runOne = async () => {
      activeCount++
      try {
        let idleSince: number | null = null
        while (true) {
          if (ac.signal.aborted) break

          const item = claimNextPending()
          if (!item) {
            // No pending right now. Poll for a brief grace period so a
            // sibling `addItem(...)` from the UI (user typing more prompts
            // while the batch is running) can still wake this worker.
            // Exits only after `idleExitMs` of continuous emptiness.
            //
            // Note: `addItem` now also calls `spawnWorker()` directly,
            // so newly-added items get a fresh worker even if all
            // existing workers are mid-API. This grace period is still
            // useful for the case where a worker just finished and a
            // sibling addItem is about to happen.
            if (idleSince === null) idleSince = Date.now()
            if (Date.now() - idleSince >= idleExitMs) break
            await new Promise((r) => setTimeout(r, POLL_IDLE_MS))
            continue
          }
          idleSince = null

          try {
            const templateKey = useTemplateStore.getState().getSelection('batch')
            const finalPrompt = composePromptWithTemplate(templateKey, item.prompt)
            const result = await api.generateImage({
              prompt: finalPrompt,
              model: modelKey,
              ratio: ratio !== 'auto' ? ratio : undefined,
              resolution,
              referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
              signal: ac.signal,
            })

            if (ac.signal.aborted) break

            if (!result.success) {
              set((state) => ({
                items: state.items.map((i) =>
                  i.id === item.id
                    ? { ...i, status: 'error' as const, error: result.error || '生成失败，请检查网络或更换模型' }
                    : i
                ),
              }))
              continue
            }

            const url = result.urls?.[0] ?? result.images?.[0]
            if (!url) {
              set((state) => ({
                items: state.items.map((i) =>
                  i.id === item.id
                    ? { ...i, status: 'error' as const, error: '接口未返回图片地址' }
                    : i
                ),
              }))
              continue
            }

            set((state) => ({
              items: state.items.map((i) =>
                i.id === item.id ? { ...i, status: 'done' as const, resultUrl: url } : i
              ),
            }))
          } catch (err) {
            if (ac.signal.aborted) break
            set((state) => ({
              items: state.items.map((i) =>
                i.id === item.id
                  ? {
                      ...i,
                      status: 'error' as const,
                      error: err instanceof Error ? err.message : String(err),
                    }
                  : i
              ),
            }))
          }
        }
      } finally {
        activeCount--
      }
    }

    /**
     * Spawn one more worker if we're below `HARD_MAX_WORKERS`. Called
     * (a) from `runBatch` itself to fill the initial pool, and
     * (b) from `addItem` whenever the user appends to the queue during
     *     a running batch (so the new item starts immediately instead
     *     of waiting for an in-flight slot to free up).
     *
     * The cap is on **active** workers, not total spawned over the
     * batch's lifetime — workers that have idle-exited don't count, so
     * the user can keep enqueueing in waves indefinitely.
     */
    const spawnWorker = () => {
      if (ac.signal.aborted) return
      if (activeCount >= HARD_MAX_WORKERS) return
      workerTasks.push(runOne())
    }

    // Publish the spawn closure + flip `running` atomically so that an
    // `addItem` racing this `set` sees a consistent (running=true,
    // spawn ready) snapshot.
    set({ running: true, _abortController: ac, _spawnWorker: spawnWorker })

    // Initial pool from CONC slider.
    for (let i = 0; i < concurrency; i++) spawnWorker()

    try {
      // Drain loop. Each iteration takes the current snapshot of
      // worker promises and awaits them. While we're awaiting, an
      // `addItem` call from the UI may have pushed brand-new workers
      // into `workerTasks` — next iteration picks them up. We exit
      // only when (a) no more workers are running and (b) no pending
      // items have appeared since.
      while (true) {
        const snapshot = workerTasks.splice(0)
        if (snapshot.length === 0) {
          // No workers in flight. Check if there's straggler pending
          // work (e.g., addItem hit just after the last worker exited
          // but before our finally clause). If yes, spawn one more
          // worker and continue draining; if no, we're done.
          const hasPending = get().items.some((i) => i.status === 'pending')
          if (!hasPending || ac.signal.aborted) break
          spawnWorker()
          continue
        }
        await Promise.all(snapshot)
      }

      if (!ac.signal.aborted) {
        try {
          const historyService = (window as any).historyDataServiceTS
          if (historyService?.addToHistory) {
            const doneItems = get().items.filter((i) => i.status === 'done' && i.resultUrl)
            for (const item of doneItems) {
              if (ac.signal.aborted) break
              await historyService.addToHistory(
                refRaw.length > 0 ? 'batch-with-reference' : 'batch',
                item.prompt,
                [item.resultUrl!],
                ratio,
                modelKey,
              ).catch((e: unknown) => console.warn('[Batch] history save failed:', e))
            }
          }
        } catch (e) {
          console.warn('[Batch] history service unavailable:', e)
        }
      }
    } finally {
      // Always clear `_spawnWorker` so no zombie addItem can spawn after
      // the batch settles. `running` / `_abortController` are reset only
      // if we weren't manually cancelled (cancelBatch handles those).
      if (!ac.signal.aborted) {
        set({ running: false, _abortController: null, _spawnWorker: null })
      } else {
        set({ _spawnWorker: null })
      }
    }
  },

  setMode: (mode) => set({ mode }),
  setCardPrompt: (s) => set({ cardPrompt: s }),
  setCardCount: (n) => set({ cardCount: Math.max(2, Math.min(10, n)) }),
  setMultiText: (s) => set({ multiText: s }),
  setRatio: (r) => set({ ratio: r }),
  setResolution: (r) => set({ resolution: r }),
  setPerPromptCount: (n) => set({ perPromptCount: Math.max(1, Math.min(2, n)) }),
  setConcurrency: (n) => set({ concurrency: Math.max(1, Math.min(6, n)) }),
  addRefImage: (img) =>
    set((s) =>
      s.refImages.length >= 8 ? s : { refImages: [...s.refImages, img] }
    ),
  removeRefImage: (id) =>
    set((s) => ({ refImages: s.refImages.filter((r) => r.id !== id) })),
  clearRefImages: () => set({ refImages: [] }),
}))

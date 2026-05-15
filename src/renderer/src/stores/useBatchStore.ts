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

/** 把 dataURL 切掉头, 只返回 base64 主体; 已经是纯 base64 则原样返回 */
function stripDataUrl(s: string): string {
  const idx = s.indexOf(',')
  return idx >= 0 && s.startsWith('data:') ? s.slice(idx + 1) : s
}

export const useBatchStore = create<BatchState>((set, get) => ({
  ...initialState,

  addItem: (prompt) =>
    set((s) => ({
      items: [...s.items, { id: crypto.randomUUID(), prompt, status: 'pending' }],
    })),

  removeItem: (id) => {
    set((s) => ({
      items: s.items.filter((i) => i.id !== id),
    }))
    if (get().running) {
      const { items, _abortController: ac } = get()
      const hasWork = items.some((i) => i.status === 'pending' || i.status === 'generating')
      if (!hasWork) {
        if (ac) ac.abort()
        set({ running: false, _abortController: null })
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
      items: state.items.map((i) =>
        i.status === 'generating' || i.status === 'pending'
          ? { ...i, status: 'error' as const, error: '已取消' }
          : i
      ),
    }))
  },

  runBatch: async (api, modelKey, opts) => {
    // Single-flight: if a batch is already running, the in-flight workers
    // will pick up any newly-pending items live (see `claimNextPending`
    // below). Spawning a second worker pool would just duplicate state
    // races against the existing pool — they all read from the same
    // `items[]` array, so the first set is enough.
    //
    // This is the user-visible "fix the second-task blocking" bug: before
    // this rewrite, the queue was a `[...pending]` snapshot taken at entry,
    // so anything added mid-run was stranded as `pending` until the user
    // manually clicked "继续排队" again. Now `handleGenerate` can call
    // `runBatch` unconditionally and the already-running workers pick up
    // the new items within one poll cycle.
    if (get().running) return

    const pending = get().items.filter((i) => i.status === 'pending')
    if (pending.length === 0) return

    const ac = new AbortController()
    set({ running: true, _abortController: ac })

    const ratio = opts?.ratio ?? get().ratio
    const resolution = opts?.resolution ?? get().resolution
    const refRaw = opts?.referenceImages ?? get().refImages.map((r) => r.base64)
    const referenceImages = refRaw.map(stripDataUrl).filter(Boolean)
    const concurrency = Math.max(1, Math.min(6, opts?.concurrency ?? get().concurrency))
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

    const runOne = async () => {
      let idleSince: number | null = null
      while (true) {
        if (ac.signal.aborted) break

        const item = claimNextPending()
        if (!item) {
          // No pending right now. Poll for a brief grace period so a
          // sibling `addItem(...)` from the UI (user typing more prompts
          // while the batch is running) can still wake this worker.
          // Exits only after `idleExitMs` of continuous emptiness.
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
    }

    const workers = Array.from({ length: concurrency }, () => runOne())
    try {
      await Promise.all(workers)

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
      if (!ac.signal.aborted) {
        set({ running: false, _abortController: null })
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

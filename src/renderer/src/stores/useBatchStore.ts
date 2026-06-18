import { create } from 'zustand'
import type { ApiActions } from '../hooks/useService'
import { useTemplateStore } from '../react-app/stores/useTemplateStore'
import { composePromptWithTemplate } from '../react-app/constants/templates'
import { enqueueCosUpload, registerCosUploadHandler } from '../utils/cosUploadDispatcher'

export type BatchMode = 'card' | 'multi'

/**
 * 异步存储上传状态。
 * - `uploading`: 已经拿到模型直出 URL,正在往 COS 推
 * - `uploaded`:  COS URL 已经回来,UI 应该热切到 cosUrl
 * - `failed`:    COS 出错,UI 永远 fallback 到 resultUrl(模型直出)
 * - 字段缺省 = 还没开始 / 老历史数据
 */
export type BatchUploadStatus = 'uploading' | 'uploaded' | 'failed'

/**
 * 生成时表单参数快照, 给结果卡上的"↺ 重编辑"按钮用。
 *
 * 和 useGenerateStore.ResultUploadMeta.snapshot 对称设计:
 * 即便用户后续改了 cardPrompt / refs / ratio, 这里依然记得这张图
 * 是怎么来的。同一次 runBatch 内的所有 item 共享同一个 snapshot 对象
 * (浅引用), 因为整批共享 ratio/refs/model, 只有 prompt 各自不同。
 */
export interface BatchItemSnapshot {
  prompt: string
  ratio: string
  referenceImages: string[]
  modelKey: string
}

export interface BatchItem {
  id: string
  prompt: string
  status: 'pending' | 'generating' | 'done' | 'error'
  /** 模型直出 URL — 上传未完成时作为 fallback 显示 */
  resultUrl?: string
  /** COS 持久化 URL — 一旦有值就优先显示 */
  cosUrl?: string
  uploadStatus?: BatchUploadStatus
  uploadError?: string
  error?: string
  /**
   * 入队时锁定的参考图(base64 带 data: 前缀)。如果用户在 batch 运行中
   * 改了参考图又点"加入队列", 新 item 携带的是修改后的 refs, 不会被
   * 首次 runBatch 的闭包覆盖。
   */
  referenceImages?: string[]
  /** 入队时锁定的比例, 同上原因。 */
  ratio?: string
  /**
   * 在 worker 把 item flip 为 `generating` 时挂上 —— 之前(pending)
   * 阶段为 undefined。重编辑时:
   *   - 有 snapshot 就用 snapshot.{prompt, ratio, referenceImages, modelKey}
   *   - 没 snapshot(还在 pending) 就 fallback 到当前 store 状态 + item.prompt
   */
  snapshot?: BatchItemSnapshot
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
  quality?: string
  referenceImages?: string[]      // base64 数组(去掉 dataURL prefix 的纯 base64)
  perPromptCount?: number          // 每条 prompt 跑几次(扩张到 items)
  count?: number                   // 单次请求组图张数(wan2.7 系列), 默认取 store.count
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
  quality: string            // auto / low / medium / high (仅 gpt-image-2)
  perPromptCount: number     // 多提示词模式下每条出几张 (1-2)
  /**
   * 组图张数(单次请求出 N 张系列图)。与 perPromptCount 正交:
   * perPromptCount 把一条 prompt 扩成 N 个独立 item(N 次请求);
   * count 是每次请求里走 wan2.7 enable_sequential 一次返回 N 张连贯系列图,
   * 多出来的图会以"兄弟卡"形式插入原 item 之后。仅 multipleImages 模型有效。
   */
  count: number              // 1..maxOutputs
  concurrency: number        // 1-6
  refImages: BatchRefImage[]

  // ---- actions: 队列 ----
  addItem: (prompt: string, opts?: { referenceImages?: string[]; ratio?: string }) => void
  removeItem: (id: string) => void
  clearAll: () => void
  runBatch: (api: ApiActions, modelKey: string, opts?: BatchRunOpts) => Promise<void>
  cancelBatch: () => void
  /**
   * 把一份"批量配置快照"灌回当前 store 表单, 不触发生成。
   *
   * 与 useGenerateStore.restoreForEdit 的对称设计:
   * - 历史"batch"条目走这条路径 (HistoryPage.handleEdit 按 type 分流)
   * - 批量结果卡上的 ↺ 重编辑也走这条 — 只是只覆盖 cardPrompt, 不动 refs/ratio
   *
   * partial 字段缺省时保留 store 现状, 不误清表单。
   */
  restoreForEdit: (snapshot: {
    prompt?: string
    ratio?: string
    referenceImages?: string[]
    mode?: BatchMode
  }) => void

  // ---- actions: 配置 ----
  setMode: (mode: BatchMode) => void
  setCardPrompt: (s: string) => void
  setCardCount: (n: number) => void
  setMultiText: (s: string) => void
  setRatio: (r: string) => void
  setResolution: (r: string) => void
  setQuality: (q: string) => void
  setPerPromptCount: (n: number) => void
  setCount: (n: number) => void
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
  quality: 'auto',
  perPromptCount: 1,
  count: 1,
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

/**
 * 单次会话保留的最大批量项数。防止长时间生图无界堆积; 超过此值后
 * 在 addItem 时从最老的已完成项(done / error)开始 FIFO 丢弃, 永不丢弃
 * 仍在 pending / generating 状态的项 — 这是关键约束: 在跑的活儿不能掉。
 */
const MAX_ITEMS = 200

/**
 * 把 items 数组裁到不超过 MAX_ITEMS 条: 从前往后扫, 只丢已结束(done/error)
 * 的, 直到满足上限或者无可丢为止。pending / generating 任意位置都跳过。
 */
function trimItems(items: BatchItem[]): BatchItem[] {
  if (items.length <= MAX_ITEMS) return items
  const toDrop = items.length - MAX_ITEMS
  let dropped = 0
  const kept: BatchItem[] = []
  for (const item of items) {
    if (dropped < toDrop && (item.status === 'done' || item.status === 'error')) {
      dropped++
      continue
    }
    kept.push(item)
  }
  return kept
}

/** 把 dataURL 切掉头, 只返回 base64 主体; 已经是纯 base64 则原样返回 */
function stripDataUrl(s: string): string {
  const idx = s.indexOf(',')
  return idx >= 0 && s.startsWith('data:') ? s.slice(idx + 1) : s
}

export const useBatchStore = create<BatchState>((set, get) => ({
  ...initialState,

  addItem: (prompt, opts) => {
    set((s) => ({
      // 追加新项之后用 trimItems 限制总长 — 只丢已结束的, 跑的活儿不动。
      items: trimItems([
        ...s.items,
        {
          id: crypto.randomUUID(),
          prompt,
          status: 'pending',
          referenceImages: opts?.referenceImages,
          ratio: opts?.ratio,
        },
      ]),
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
    // 清掉 pending history context: 旧版 finally 写 history 时会过滤
    // 已被 removeItem 的 item, 新版必须显式 delete 才能保持"删除后不进
    // history"的语义。COS 上传仍在主进程跑(已 enqueue), 但回来时找不到
    // ctx 就 noop, 不会落盘 history。
    pendingBatchHistoryContext.delete(id)
    if (get().running) {
      const { items, _abortController: ac } = get()
      const hasWork = items.some((i) => i.status === 'pending' || i.status === 'generating')
      if (!hasWork) {
        if (ac) ac.abort()
        set({ running: false, _abortController: null, _spawnWorker: null })
      }
    }
  },

  clearAll: () => {
    pendingBatchHistoryContext.clear()
    set({ items: [] })
  },

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
    const quality = opts?.quality ?? get().quality
    const refRaw = opts?.referenceImages ?? get().refImages.map((r) => r.base64)
    const referenceImages = refRaw.map(stripDataUrl).filter(Boolean)
    const concurrency = Math.max(1, Math.min(HARD_MAX_WORKERS, opts?.concurrency ?? get().concurrency))
    // 组图张数: 每次 generateImage 请求出 N 张系列图(wan2.7 enable_sequential)。
    // ApiService.buildOpenAIPayload 会按模型 maxOutputs 收敛 + 决定是否带 enable_sequential。
    const count = Math.max(1, Math.floor(opts?.count ?? get().count))
    const idleExitMs = Math.max(0, opts?.idleExitMs ?? 300)
    const POLL_IDLE_MS = 80

    // 整批共享的回灌快照。注意 ratio 这里用 opts 里的原值(可能含 'auto'),
    // 而不是已经被 API 过滤过的 undefined —— restoreForEdit 注入的是表单
    // 值, 让用户在生图页看到一致的 UI 状态。referenceImages 用 refRaw
    // (data URL 完整形式), 因为重编辑要回灌到 refImages, 后者也是 data URL。
    const runSnapshotBase: Omit<BatchItemSnapshot, 'prompt'> = {
      ratio,
      referenceImages: refRaw,
      modelKey,
    }

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
        // Snapshot 在 claim 时挂上 —— 此时 prompt/ratio/refs/model 都已确定,
        // 重编辑按钮(在 done 之后才显示)就能拿到完整回灌参数。
        // item 自身可能带独立 ratio/referenceImages (mid-run 追加的), 优先用。
        const snapshot: BatchItemSnapshot = {
          ...runSnapshotBase,
          prompt: next.prompt,
          ratio: next.ratio ?? runSnapshotBase.ratio,
          referenceImages: next.referenceImages ?? runSnapshotBase.referenceImages,
        }
        claimed = { ...next, status: 'generating' as const, snapshot }
        return {
          items: state.items.map((i) =>
            i.id === next.id
              ? { ...i, status: 'generating' as const, snapshot }
              : i
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
            // item 自身可能携带入队时锁定的 refs/ratio (用户 mid-run 修改后
            // 追加的新 item), 优先取自身值, 否则 fallback 到 runBatch 闭包快照。
            const itemRatio = item.ratio ?? ratio
            const itemRefs = item.referenceImages
              ? item.referenceImages.map(stripDataUrl).filter(Boolean)
              : referenceImages
            const result = await api.generateImage({
              prompt: finalPrompt,
              model: modelKey,
              ratio: itemRatio !== 'auto' ? itemRatio : undefined,
              resolution,
              quality,
              count,
              referenceImages: itemRefs.length > 0 ? itemRefs : undefined,
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

            // 组图: 一次请求可能返回多张(wan2.7 系列)。第 0 张回填原 item,
            // 其余作为"兄弟卡"紧跟其后插入, 各自独立走 COS 上传 + history。
            const urls = result.urls ?? result.images ?? []
            const url = urls[0]
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

            // 为多出来的系列图(urls[1..])建兄弟卡, 复用原 item 的 prompt/ratio/refs/snapshot。
            const siblings: BatchItem[] = urls.slice(1).map((u) => ({
              ...item,
              id: crypto.randomUUID(),
              status: 'done' as const,
              resultUrl: u,
              uploadStatus: 'uploading' as const,
            }))

            set((state) => {
              const mapped = state.items.map((i) =>
                i.id === item.id
                  ? { ...i, status: 'done' as const, resultUrl: url, uploadStatus: 'uploading' as const }
                  : i
              )
              if (siblings.length === 0) return { items: mapped }
              // 把兄弟卡插到原 item 之后, 保持系列相邻; 再过一遍 trimItems 控总长。
              const idx = mapped.findIndex((i) => i.id === item.id)
              const next = idx >= 0
                ? [...mapped.slice(0, idx + 1), ...siblings, ...mapped.slice(idx + 1)]
                : [...mapped, ...siblings]
              return { items: trimItems(next) }
            })

            // 真 fire-and-forget: 入队后立即返回, 完全不持有 promise。
            // 主进程上传完成后通过 'cos:upload-result' 事件把结果推回,
            // 全局监听器(模块底部 registerCosUploadHandler 一次性注册)
            // 按 requestId 找 item 并 set 回去, 同时写入 history。
            //
            // 关键: 在 enqueue 前把写 history 所需的上下文 stash 到
            // pendingBatchHistoryContext, 让 event handler 能拿到
            // prompt/ratio/refRaw/modelUrl 等(refRaw 共享浅引用即可)。
            const enqueueOne = (id: string, modelUrl: string) => {
              pendingBatchHistoryContext.set(id, {
                modelUrl,
                prompt: item.prompt,
                ratio: item.ratio ?? ratio,
                modelKey,
                refRaw: item.referenceImages ?? refRaw,
              })
              enqueueCosUpload(id, modelUrl, {
                source: 'batch',
                prompt: item.prompt,
                model: modelKey,
              })
            }
            enqueueOne(item.id, url)
            for (const sib of siblings) enqueueOne(sib.id, sib.resultUrl!)
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

      // History 写入已下放到 'batch:' COS event handler(模块底部)。
      // 那里每张图上传完成时各自异步写一条 history, 不再阻塞 batch finally。
      //
      // 原本这里是串行 `await historyService.addToHistory(...)` × N, 5 张图
      // = 5 次 IPC + 5 次 fs.writeFile, 总耗时 150-750ms, 期间 running=true
      // 不能切到 false, 用户感知为"任务完成那一瞬间的卡顿"。
      //
      // 现在的语义优于旧版: 旧版只能写 modelUrl (cosUrl 大概率还没回来),
      // modelUrl 几小时后过期 → history 失效; 新版 event handler 在上传
      // 成功后才写, 写的就是持久 cosUrl, 失败再 fallback modelUrl。
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

  restoreForEdit: (snapshot) => {
    // 把 dataURL 转成 BatchRefImage —— 历史里存的是 dataURL 数组, 但
    // useBatchStore.refImages 是带元数据 (id/fileName/fileSize) 的对象数组,
    // 所以这里要重构: 给每个 ref 生成一个稳定 id, fileName 用 'restored-N',
    // fileSize 从 dataURL 字节长度近似估算 (b64 长 × 0.75)。
    set((s) => {
      const refs = snapshot.referenceImages
      const nextRefs =
        refs !== undefined
          ? refs.map((base64, i): BatchRefImage => ({
              id: `restored-${Date.now()}-${i}`,
              base64,
              fileName: `restored-${i + 1}`,
              // 估算: data:image/png;base64,<...> 中 base64 部分长度 × 0.75 ≈ byte 数
              fileSize: Math.floor((base64.length - (base64.indexOf(',') + 1)) * 0.75),
            }))
          : s.refImages

      // mode 缺省时保持当前 mode 不变 —— 历史页会显式传 'card', 但
      // BatchPage 内部 ↺ EDIT 不传 mode, 用户在 multi 模式时不应被强切回 card,
      // 否则会丢掉 multiText 里其他几行的输入。
      const nextMode = snapshot.mode !== undefined ? snapshot.mode : s.mode
      const promptIsSet = snapshot.prompt !== undefined

      return {
        mode: nextMode,
        cardPrompt:
          nextMode === 'card' && promptIsSet ? snapshot.prompt! : s.cardPrompt,
        multiText:
          nextMode === 'multi' && promptIsSet ? snapshot.prompt! : s.multiText,
        ratio: snapshot.ratio !== undefined ? snapshot.ratio : s.ratio,
        refImages: nextRefs,
      }
    })
  },

  setMode: (mode) => set({ mode }),
  setCardPrompt: (s) => set({ cardPrompt: s }),
  setCardCount: (n) => set({ cardCount: Math.max(2, Math.min(10, n)) }),
  setMultiText: (s) => set({ multiText: s }),
  setRatio: (r) => set({ ratio: r }),
  setResolution: (r) => set({ resolution: r }),
  setQuality: (q) => set({ quality: q }),
  setPerPromptCount: (n) => set({ perPromptCount: Math.max(1, Math.min(2, n)) }),
  setCount: (n) => set({ count: Math.max(1, Math.floor(n)) }),
  setConcurrency: (n) => set({ concurrency: Math.max(1, Math.min(6, n)) }),
  addRefImage: (img) =>
    set((s) =>
      // 上限对齐 gpt-image 单请求最多 16 张参考图
      s.refImages.length >= 16 ? s : { refImages: [...s.refImages, img] }
    ),
  removeRefImage: (id) =>
    set((s) => ({ refImages: s.refImages.filter((r) => r.id !== id) })),
  clearRefImages: () => set({ refImages: [] }),
}))

// ============== 异步 COS 上传结果路由 + history 写入 ==============
//
// runOne 入队后立即 return, 完全不持有 promise。主进程上传完成后通过
// 'cos:upload-result' 事件回推, 这里按 'batch:' 前缀路由接收, 执行:
//   ① 把 cosUrl 回填到 item(供 UI 切徽章 + 持久化层用)
//   ② 写一条 history(失败也写, url 用 modelUrl fallback)
//
// pendingBatchHistoryContext 暂存 runBatch 闭包里的整批共享变量 (prompt/
// ratio/refRaw/modelKey/modelUrl)。runOne 在 enqueue 前 set, handler 消费
// 后 delete 防泄漏。refRaw 同一批 N 张图共享浅引用即可。

interface PendingBatchHistoryCtx {
  modelUrl: string
  prompt: string
  ratio: string
  modelKey: string
  refRaw: string[]
}

const pendingBatchHistoryContext = new Map<string, PendingBatchHistoryCtx>()

interface HistoryServiceBridge {
  addToHistory?: (
    type: string,
    prompt: string,
    urls: string[],
    ratio?: string,
    model?: string,
    extras?: { referenceImages?: string[] },
  ) => Promise<unknown>
}

registerCosUploadHandler('batch:', (result) => {
  const itemId = result.requestId.slice('batch:'.length)

  useBatchStore.setState((state) => ({
    items: state.items.map((i) =>
      i.id === itemId
        ? result.success
          ? { ...i, cosUrl: result.url, uploadStatus: 'uploaded' as const, uploadError: undefined }
          : { ...i, uploadStatus: 'failed' as const, uploadError: result.error }
        : i,
    ),
  }))

  // 写 history. 容忍 context 已被清(removeItem / cancelBatch 之类):
  // 没 ctx 就直接 return, 不影响 UI 状态切换。
  const ctx = pendingBatchHistoryContext.get(itemId)
  if (!ctx) return
  pendingBatchHistoryContext.delete(itemId)

  const historyService = (window as unknown as {
    historyDataServiceTS?: HistoryServiceBridge
  }).historyDataServiceTS
  if (!historyService?.addToHistory) return

  const persistUrl = result.success ? result.url : ctx.modelUrl
  const hasRefs = ctx.refRaw.length > 0
  void historyService
    .addToHistory(
      hasRefs ? 'batch-with-reference' : 'batch',
      ctx.prompt,
      [persistUrl],
      ctx.ratio,
      ctx.modelKey,
      { referenceImages: hasRefs ? ctx.refRaw : undefined },
    )
    .catch((e: unknown) => console.warn('[Batch] history save failed:', e))
})

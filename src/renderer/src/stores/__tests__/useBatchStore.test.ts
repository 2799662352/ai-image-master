import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { useBatchStore, initialState } from '../useBatchStore'
import type { ApiActions } from '../../hooks/useService'

function createMockApi(overrides: Partial<ApiActions> = {}): ApiActions {
  return {
    generateImage: vi.fn().mockResolvedValue({ success: true, urls: ['http://result.jpg'] }),
    understandImage: vi.fn().mockResolvedValue({ success: true, content: 'analysis result' }),
    testConnection: vi.fn(),
    saveApiKey: vi.fn(),
    saveVisionApiKey: vi.fn(),
    getAllSites: vi.fn().mockReturnValue({}),
    setSite: vi.fn(),
    getStoredApiKey: vi.fn().mockReturnValue(null),
    getStoredVisionApiKey: vi.fn().mockReturnValue(null),
    getCurrentSite: vi.fn(),
    getSiteConfig: vi.fn(),
    currentSiteKey: '',
    ...overrides,
  }
}

let uuidCounter = 0
const originalRandomUUID = crypto.randomUUID.bind(crypto)

describe('useBatchStore', () => {
  beforeEach(() => {
    useBatchStore.setState({ ...initialState })
    uuidCounter = 0
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `uuid-${++uuidCounter}`)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('has correct initial state', () => {
    const state = useBatchStore.getState()
    expect(state.items).toEqual([])
    expect(state.running).toBe(false)
  })

  it('addItem appends a pending item', () => {
    useBatchStore.getState().addItem('draw a cat')

    const items = useBatchStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]).toEqual({
      id: 'uuid-1',
      prompt: 'draw a cat',
      status: 'pending',
    })
  })

  it('removeItem removes by id', () => {
    useBatchStore.getState().addItem('a')
    useBatchStore.getState().addItem('b')

    useBatchStore.getState().removeItem('uuid-1')

    const items = useBatchStore.getState().items
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('uuid-2')
  })

  it('clearAll removes all items', () => {
    useBatchStore.getState().addItem('a')
    useBatchStore.getState().addItem('b')
    useBatchStore.getState().clearAll()

    expect(useBatchStore.getState().items).toEqual([])
  })

  describe('runBatch', () => {
    // Tests pass `concurrency: 1, idleExitMs: 0` so:
    //   1. ordering is deterministic (one worker, one item at a time)
    //   2. the workers exit immediately when the queue drains — without
    //      this, every runBatch test would pay the 300ms idle grace period
    //      that exists in production to let live `addItem` calls reach
    //      still-warm workers.
    const TEST_OPTS = { concurrency: 1, idleExitMs: 0 } as const

    it('processes items sequentially', async () => {
      useBatchStore.getState().addItem('prompt1')
      useBatchStore.getState().addItem('prompt2')

      const callOrder: string[] = []
      const api = createMockApi({
        generateImage: vi.fn().mockImplementation(async ({ prompt }) => {
          callOrder.push(prompt)
          return { success: true, urls: [`http://${prompt}.jpg`] }
        }),
      })

      await useBatchStore.getState().runBatch(api, 'model-x', TEST_OPTS)

      expect(callOrder).toEqual(['prompt1', 'prompt2'])
      const items = useBatchStore.getState().items
      expect(items[0].status).toBe('done')
      expect(items[0].resultUrl).toBe('http://prompt1.jpg')
      expect(items[1].status).toBe('done')
      expect(items[1].resultUrl).toBe('http://prompt2.jpg')
      expect(useBatchStore.getState().running).toBe(false)
    })

    it('continues after a failure', async () => {
      useBatchStore.getState().addItem('good')
      useBatchStore.getState().addItem('bad')
      useBatchStore.getState().addItem('also-good')

      let callCount = 0
      const api = createMockApi({
        generateImage: vi.fn().mockImplementation(async () => {
          callCount++
          if (callCount === 2) throw new Error('api down')
          return { success: true, urls: ['http://ok.jpg'] }
        }),
      })

      await useBatchStore.getState().runBatch(api, 'model', TEST_OPTS)

      const items = useBatchStore.getState().items
      expect(items[0].status).toBe('done')
      expect(items[1].status).toBe('error')
      expect(items[1].error).toBe('api down')
      expect(items[2].status).toBe('done')
    })

    it('skips non-pending items', async () => {
      useBatchStore.setState({
        items: [
          { id: 'done-1', prompt: 'already done', status: 'done', resultUrl: 'http://x.jpg' },
          { id: 'pending-1', prompt: 'needs work', status: 'pending' },
        ],
      })

      const api = createMockApi()
      await useBatchStore.getState().runBatch(api, 'model', TEST_OPTS)

      expect(api.generateImage).toHaveBeenCalledTimes(1)
      expect(api.generateImage).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'needs work' })
      )
    })

    it('does nothing when no pending items', async () => {
      useBatchStore.setState({
        items: [{ id: '1', prompt: 'done', status: 'done', resultUrl: 'http://x.jpg' }],
      })

      const api = createMockApi()
      await useBatchStore.getState().runBatch(api, 'model', TEST_OPTS)

      expect(api.generateImage).not.toHaveBeenCalled()
      expect(useBatchStore.getState().running).toBe(false)
    })

    it('marks items as error when result.success is false', async () => {
      useBatchStore.getState().addItem('will-fail')
      useBatchStore.getState().addItem('will-succeed')

      let callCount = 0
      const api = createMockApi({
        generateImage: vi.fn().mockImplementation(async () => {
          callCount++
          if (callCount === 1) return { success: false, error: 'rate limited' }
          return { success: true, urls: ['http://ok.jpg'] }
        }),
      })

      await useBatchStore.getState().runBatch(api, 'model', TEST_OPTS)

      const items = useBatchStore.getState().items
      expect(items[0].status).toBe('error')
      expect(items[0].error).toBe('rate limited')
      expect(items[1].status).toBe('done')
      expect(items[1].resultUrl).toBe('http://ok.jpg')
    })

    it('extracts URL from result.images when urls is absent', async () => {
      useBatchStore.getState().addItem('img-fallback')

      const api = createMockApi({
        generateImage: vi.fn().mockResolvedValue({ success: true, images: ['http://via-images.jpg'] }),
      })

      await useBatchStore.getState().runBatch(api, 'model', TEST_OPTS)

      const items = useBatchStore.getState().items
      expect(items[0].status).toBe('done')
      expect(items[0].resultUrl).toBe('http://via-images.jpg')
    })

    it('marks items as error when result has no url', async () => {
      useBatchStore.getState().addItem('no-url')

      const api = createMockApi({
        generateImage: vi.fn().mockResolvedValue({ success: true }),
      })

      await useBatchStore.getState().runBatch(api, 'model', TEST_OPTS)

      const items = useBatchStore.getState().items
      expect(items[0].status).toBe('error')
      expect(items[0].error).toBe('接口未返回图片地址')
    })

    // The exact regression the user reported on 2026-05-14:
    //   "发送一个生成 任务 必须完成 才能生成 第二个 不应该是这样"
    //
    // Pre-fix: runBatch captured `const queue = [...pending]` at entry, so
    // items added via addItem() mid-run stayed `pending` forever. The user
    // had to wait for the running batch to drain, see "继续排队", then click
    // again.
    //
    // Post-fix (2026-05-15 follow-up): addItem during a running batch ALSO
    // spawns a brand-new worker (capped at HARD_MAX_WORKERS=6) so the new
    // item starts immediately instead of queueing behind the in-flight
    // worker — this is the "没跑完也应该启动" fix. The original concurrency=1
    // case below still works because spawn brings the pool from 1 → 2.
    it('picks up items added during a running batch (live queue)', async () => {
      useBatchStore.getState().addItem('first')

      const resolvers: Array<(v: unknown) => void> = []
      const api = createMockApi({
        generateImage: vi.fn().mockImplementation(
          () => new Promise((resolve) => {
            resolvers.push(resolve)
          })
        ),
      })

      // concurrency=1 starts with 1 worker; the burst-spawn fix lets a
      // mid-run addItem add a second worker (up to HARD_MAX=6).
      const batchPromise = useBatchStore.getState().runBatch(api, 'model', {
        concurrency: 1,
        idleExitMs: 300,
      })

      // Worker 1 should claim 'first' immediately and call generateImage.
      await vi.waitFor(() => {
        expect(resolvers.length).toBe(1)
        expect(useBatchStore.getState().items[0]?.status).toBe('generating')
      })

      // User types another prompt and clicks "+ 加入队列" while the batch
      // is still running — addItem appends + spawns a new worker.
      useBatchStore.getState().addItem('second')
      await vi.waitFor(() => {
        expect(resolvers.length).toBe(2)
        expect(useBatchStore.getState().items[1]?.status).toBe('generating')
      })

      // Resolve both in any order — runBatch should settle cleanly.
      resolvers[0]({ success: true, urls: ['http://first.jpg'] })
      resolvers[1]({ success: true, urls: ['http://second.jpg'] })
      await batchPromise

      const items = useBatchStore.getState().items
      expect(items[0].status).toBe('done')
      expect(items[0].resultUrl).toBe('http://first.jpg')
      expect(items[1].status).toBe('done')
      expect(items[1].resultUrl).toBe('http://second.jpg')
      expect(useBatchStore.getState().running).toBe(false)
    })

    // Regression (2026-06-25): mid-run model switch on the batch page.
    // While a 'gpt-image-2' batch is in flight, the user switches the
    // top-bar model to 'nano-banana' and clicks 加入队列. The freshly
    // enqueued item MUST be generated with the model that was active when
    // it was enqueued (nano-banana) — NOT the original batch's captured
    // modelKey. Before the fix, model was a per-runBatch closure param, so
    // the addItem-spawned worker sent the new item as 'gpt-image-2' with
    // nano's inline-base64 refs → upstream rejected it → the user saw the
    // nano task "发送不出去".
    it('locks model per-item so a mid-run model switch uses the new model', async () => {
      useBatchStore.getState().addItem('gpt-prompt', { model: 'gpt-image-2' })

      const calls: Array<{ prompt: string; model: string }> = []
      const resolvers: Array<(v: unknown) => void> = []
      const api = createMockApi({
        generateImage: vi.fn().mockImplementation(
          (args: { prompt: string; model: string }) =>
            new Promise((resolve) => {
              calls.push({ prompt: args.prompt, model: args.model })
              resolvers.push(resolve)
            }),
        ),
      })

      const batchPromise = useBatchStore.getState().runBatch(api, 'gpt-image-2', {
        concurrency: 1,
        idleExitMs: 300,
      })

      await vi.waitFor(() => {
        expect(calls.length).toBe(1)
        expect(calls[0]).toMatchObject({ prompt: 'gpt-prompt', model: 'gpt-image-2' })
      })

      // Mid-run: user switched the top bar to nano and enqueued a nano item.
      useBatchStore.getState().addItem('nano-prompt', { model: 'nano-banana' })
      await vi.waitFor(() => {
        expect(calls.length).toBe(2)
      })

      // The nano item must be sent as nano-banana, not the batch's gpt model.
      const nanoCall = calls.find((c) => c.prompt === 'nano-prompt')
      expect(nanoCall?.model).toBe('nano-banana')

      resolvers.forEach((r) => r({ success: true, urls: ['http://x.jpg'] }))
      await batchPromise
      expect(useBatchStore.getState().running).toBe(false)
    })

    // Single-flight invariant: calling runBatch a second time while one
    // is already running must be a no-op (no duplicate worker pool, no
    // re-flip of `running`). This protects against the BatchPage handler
    // accidentally calling runBatch on top of itself.
    it('is single-flight while running (no-op on re-entry)', async () => {
      useBatchStore.getState().addItem('a')

      let resolveFirst: ((v: unknown) => void) | undefined
      const api = createMockApi({
        generateImage: vi.fn().mockImplementation(
          () => new Promise((r) => { resolveFirst = r })
        ),
      })

      const first = useBatchStore.getState().runBatch(api, 'model', {
        concurrency: 2,
        idleExitMs: 0,
      })

      await vi.waitFor(() => {
        expect(useBatchStore.getState().running).toBe(true)
      })

      // Second runBatch call: should resolve immediately without flipping
      // anything (the existing pool already owns the items[] pool).
      const second = useBatchStore.getState().runBatch(api, 'model', TEST_OPTS)
      await second
      expect(api.generateImage).toHaveBeenCalledTimes(1)
      expect(useBatchStore.getState().running).toBe(true)

      resolveFirst?.({ success: true, urls: ['http://a.jpg'] })
      await first
      expect(useBatchStore.getState().running).toBe(false)
    })
  })

  describe('cancelBatch', () => {
    it('cancels running batch and marks items', async () => {
      useBatchStore.getState().addItem('a')
      useBatchStore.getState().addItem('b')

      let resolveFirst: ((v: any) => void) | undefined
      let callCount = 0
      const api = createMockApi({
        generateImage: vi.fn().mockImplementation(() => {
          callCount++
          if (callCount === 1) {
            return new Promise((resolve) => { resolveFirst = resolve })
          }
          return Promise.resolve({ success: true, urls: ['http://ok.jpg'] })
        }),
      })

      const batchPromise = useBatchStore.getState().runBatch(api, 'model', {
        concurrency: 1,
        idleExitMs: 0,
      })

      await vi.waitFor(() => {
        expect(useBatchStore.getState().running).toBe(true)
      })

      useBatchStore.getState().cancelBatch()

      expect(useBatchStore.getState().running).toBe(false)
      const items = useBatchStore.getState().items
      const errorItems = items.filter((i) => i.status === 'error')
      expect(errorItems.length).toBeGreaterThan(0)
      expect(errorItems[0].error).toBe('已取消')

      resolveFirst?.({ success: true, urls: ['http://too-late.jpg'] })
      await batchPromise
    })
  })

  describe('removeItem during running', () => {
    it('auto-cancels batch when all items are removed', async () => {
      useBatchStore.getState().addItem('only-one')

      let resolveApi: ((v: any) => void) | undefined
      const api = createMockApi({
        generateImage: vi.fn().mockImplementation(() => {
          return new Promise((resolve) => { resolveApi = resolve })
        }),
      })

      const batchPromise = useBatchStore.getState().runBatch(api, 'model', {
        concurrency: 1,
        idleExitMs: 0,
      })

      await vi.waitFor(() => {
        expect(useBatchStore.getState().running).toBe(true)
      })

      useBatchStore.getState().removeItem('uuid-1')

      expect(useBatchStore.getState().running).toBe(false)
      expect(useBatchStore.getState().items).toHaveLength(0)

      resolveApi?.({ success: true, urls: ['http://too-late.jpg'] })
      await batchPromise
    })

    it('keeps running when a done item is removed while others generate', async () => {
      useBatchStore.getState().addItem('fast')
      useBatchStore.getState().addItem('slow')

      let resolveSlow: ((v: any) => void) | undefined
      let callCount = 0
      const api = createMockApi({
        generateImage: vi.fn().mockImplementation(() => {
          callCount++
          if (callCount === 1) return Promise.resolve({ success: true, urls: ['http://fast.jpg'] })
          return new Promise((resolve) => { resolveSlow = resolve })
        }),
      })

      const batchPromise = useBatchStore.getState().runBatch(api, 'model', {
        concurrency: 2,
        idleExitMs: 0,
      })
      await vi.waitFor(() => {
        expect(useBatchStore.getState().items[0]?.status).toBe('done')
      })

      useBatchStore.getState().removeItem('uuid-1')
      expect(useBatchStore.getState().running).toBe(true)

      resolveSlow?.({ success: true, urls: ['http://slow.jpg'] })
      await batchPromise
      expect(useBatchStore.getState().running).toBe(false)
    })

    it('keeps running when other items still generating', async () => {
      useBatchStore.getState().addItem('a')
      useBatchStore.getState().addItem('b')

      const resolvers: Array<(v: any) => void> = []
      const api = createMockApi({
        generateImage: vi.fn().mockImplementation(() => {
          return new Promise((resolve) => { resolvers.push(resolve) })
        }),
      })

      const batchPromise = useBatchStore.getState().runBatch(api, 'model', {
        concurrency: 2,
        idleExitMs: 0,
      })

      await vi.waitFor(() => {
        expect(resolvers.length).toBe(2)
      })

      useBatchStore.getState().removeItem('uuid-1')

      expect(useBatchStore.getState().running).toBe(true)

      resolvers.forEach((r) => r({ success: true, urls: ['http://ok.jpg'] }))
      await batchPromise

      expect(useBatchStore.getState().running).toBe(false)
    })
  })

  // The exact regression the user reported on 2026-05-15:
  //   "比如选三 的二次任务我发上去了 第二次 第一个 任务不会开始"
  //   "没跑完也应该启动"
  //
  // Setup: user has CONC=3, clicks GENERATE×3 (3 items running in parallel),
  // then clicks +3 mid-run. Expectation: the 3 new items start IMMEDIATELY
  // in parallel with the first 3 — they should NOT wait for batch 1 to drain
  // a worker slot.
  //
  // Pre-fix: the worker pool was fixed at concurrency=3 at runBatch entry.
  // The 3 new items sat as `pending` until one of the first 3 finished,
  // and only then trickled in one-by-one — so the user perceived "task
  // didn't start" for many seconds. This test fails on that behavior:
  // generateImage gets called only 3 times before all 6 finish.
  //
  // Post-fix: addItem during a running batch spawns a new worker (capped
  // at HARD_MAX=6, the same as the CONC slider's upper bound), so all 6
  // items are calling generateImage concurrently.
  describe('burst enqueue during running batch', () => {
    it('spawns additional workers up to HARD_MAX when items added mid-run', async () => {
      // Initial 3 items, concurrency=3 → 3 workers
      useBatchStore.getState().addItem('A')
      useBatchStore.getState().addItem('B')
      useBatchStore.getState().addItem('C')

      const resolvers: Array<(v: unknown) => void> = []
      const promptOrder: string[] = []
      const api = createMockApi({
        generateImage: vi.fn().mockImplementation(
          ({ prompt }: { prompt: string }) =>
            new Promise((resolve) => {
              promptOrder.push(prompt)
              resolvers.push(resolve)
            })
        ),
      })

      const batchPromise = useBatchStore.getState().runBatch(api, 'model', {
        concurrency: 3,
        idleExitMs: 300,
      })

      // Wait for the first 3 workers to claim and call generateImage.
      await vi.waitFor(() => {
        expect(resolvers.length).toBe(3)
      })
      // All 3 initial items are now generating; nothing has finished yet.
      const midState = useBatchStore.getState()
      expect(midState.items.filter((i) => i.status === 'generating')).toHaveLength(3)

      // Simulate a second user click during the run: +3 more prompts.
      useBatchStore.getState().addItem('D')
      useBatchStore.getState().addItem('E')
      useBatchStore.getState().addItem('F')

      // ─────────────────────────────────────────────────────────────────────
      // KEY ASSERTION: the 3 new items must ALSO start generating immediately,
      // without waiting for any of the first 3 to resolve. The worker pool
      // should expand from 3 → 6 (capped at HARD_MAX = slider max).
      // ─────────────────────────────────────────────────────────────────────
      await vi.waitFor(() => {
        expect(resolvers.length).toBe(6)
      })
      expect(promptOrder).toEqual(['A', 'B', 'C', 'D', 'E', 'F'])
      const burstState = useBatchStore.getState()
      expect(burstState.items.filter((i) => i.status === 'generating')).toHaveLength(6)

      // Resolve all 6 in order so the batch can finish cleanly.
      resolvers.forEach((r, i) =>
        r({ success: true, urls: [`http://${promptOrder[i]}.jpg`] })
      )
      await batchPromise

      const final = useBatchStore.getState()
      expect(final.items.every((i) => i.status === 'done')).toBe(true)
      expect(final.running).toBe(false)
    })

    it('caps additional spawned workers at HARD_MAX=6 (no API blowup)', async () => {
      // Start with 6 items + concurrency=6 → 6 workers claim immediately
      for (let i = 1; i <= 6; i++) useBatchStore.getState().addItem(`P${i}`)

      const resolvers: Array<(v: unknown) => void> = []
      const api = createMockApi({
        generateImage: vi.fn().mockImplementation(
          () => new Promise((resolve) => { resolvers.push(resolve) })
        ),
      })

      const batchPromise = useBatchStore.getState().runBatch(api, 'model', {
        concurrency: 6,
        idleExitMs: 300,
      })

      await vi.waitFor(() => {
        expect(resolvers.length).toBe(6)
      })

      // Try to add 3 more — pool is already at HARD_MAX=6, so they
      // should be queued (NOT picked up by a 7th/8th/9th worker).
      useBatchStore.getState().addItem('extra-1')
      useBatchStore.getState().addItem('extra-2')
      useBatchStore.getState().addItem('extra-3')

      // Give the event loop a tick — if the cap is broken, we'd see
      // 7/8/9 calls here. The cap holds.
      await new Promise((r) => setTimeout(r, 50))
      expect(resolvers.length).toBe(6)
      expect(
        useBatchStore.getState().items.filter((i) => i.status === 'pending')
      ).toHaveLength(3)

      // Resolve first 3 — freed slots should pick up the extras.
      resolvers.slice(0, 3).forEach((r) =>
        r({ success: true, urls: ['http://done.jpg'] })
      )
      await vi.waitFor(() => {
        expect(resolvers.length).toBe(9)
      })
      // Resolve everything remaining.
      resolvers.slice(3).forEach((r) =>
        r({ success: true, urls: ['http://done.jpg'] })
      )
      await batchPromise
      expect(useBatchStore.getState().running).toBe(false)
    })
  })

  describe('restoreForEdit', () => {
    it('writes cardPrompt when mode is card', () => {
      useBatchStore.setState({ mode: 'card', cardPrompt: 'old', multiText: 'multi-untouched' })

      useBatchStore.getState().restoreForEdit({
        prompt: 'restored prompt',
        mode: 'card',
      })

      const s = useBatchStore.getState()
      expect(s.mode).toBe('card')
      expect(s.cardPrompt).toBe('restored prompt')
      expect(s.multiText).toBe('multi-untouched')
    })

    it('writes multiText when mode is multi', () => {
      useBatchStore.setState({ mode: 'card', cardPrompt: 'card-untouched', multiText: 'old' })

      useBatchStore.getState().restoreForEdit({
        prompt: 'multi restored',
        mode: 'multi',
      })

      const s = useBatchStore.getState()
      expect(s.mode).toBe('multi')
      expect(s.multiText).toBe('multi restored')
      expect(s.cardPrompt).toBe('card-untouched')
    })

    it('preserves prompts when snapshot.prompt is undefined', () => {
      useBatchStore.setState({ mode: 'card', cardPrompt: 'keep', multiText: 'keep-multi' })

      useBatchStore.getState().restoreForEdit({ mode: 'card' })

      const s = useBatchStore.getState()
      expect(s.cardPrompt).toBe('keep')
      expect(s.multiText).toBe('keep-multi')
    })

    it('syncRefImagesForModel(true): 删远端 URL,保留本地 base64', () => {
      useBatchStore.setState({
        refImages: [
          { id: '1', base64: 'https://cos.example.com/a.png', fileName: 'a', fileSize: 0 },
          { id: '2', base64: 'data:image/png;base64,XXX', fileName: 'b', fileSize: 0 },
        ],
      })
      const removed = useBatchStore.getState().syncRefImagesForModel(true)
      expect(removed).toBe(1)
      expect(useBatchStore.getState().refImages.map((r) => r.id)).toEqual(['2'])
    })

    it('syncRefImagesForModel(false): 删本地 base64,保留远端 URL', () => {
      useBatchStore.setState({
        refImages: [
          { id: '1', base64: 'https://cos.example.com/a.png', fileName: 'a', fileSize: 0 },
          { id: '2', base64: 'data:image/png;base64,XXX', fileName: 'b', fileSize: 0 },
        ],
      })
      const removed = useBatchStore.getState().syncRefImagesForModel(false)
      expect(removed).toBe(1)
      expect(useBatchStore.getState().refImages.map((r) => r.id)).toEqual(['1'])
    })

    it('rebuilds referenceImages as BatchRefImage[] from raw base64 array', () => {
      useBatchStore.setState({ refImages: [] })

      useBatchStore.getState().restoreForEdit({
        referenceImages: ['data:image/png;base64,AAAA', 'data:image/jpeg;base64,BBBB'],
      })

      const refs = useBatchStore.getState().refImages
      expect(refs).toHaveLength(2)
      expect(refs[0].base64).toBe('data:image/png;base64,AAAA')
      expect(refs[0].fileName).toBe('restored-1')
      expect(refs[0].id).toMatch(/^restored-/)
      expect(refs[1].fileName).toBe('restored-2')
    })

    it('preserves existing refImages when snapshot.referenceImages is undefined', () => {
      const existing = {
        id: 'keep-me',
        base64: 'data:image/png;base64,KEEP',
        fileName: 'orig.png',
        fileSize: 100,
      }
      useBatchStore.setState({ refImages: [existing] })

      useBatchStore.getState().restoreForEdit({ prompt: 'p', mode: 'card' })

      expect(useBatchStore.getState().refImages).toEqual([existing])
    })

    it('updates ratio when provided, preserves when omitted', () => {
      useBatchStore.setState({ ratio: '1:1' })

      useBatchStore.getState().restoreForEdit({ ratio: '16:9' })
      expect(useBatchStore.getState().ratio).toBe('16:9')

      useBatchStore.getState().restoreForEdit({ prompt: 'p' })
      expect(useBatchStore.getState().ratio).toBe('16:9')
    })

    it('preserves current mode when snapshot.mode is omitted (BatchPage 内部 ↺ EDIT 不能强切回 card)', () => {
      // 用户当前在 multi 模式编排一堆 prompt, 中间点了某条结果的 ↺ EDIT。
      // 老行为是强切回 'card', 会丢掉 multiText 里其他几行。新契约: 保持 s.mode。
      useBatchStore.setState({ mode: 'multi', multiText: 'a\nb\nc' })

      useBatchStore.getState().restoreForEdit({ prompt: 'hi' })

      expect(useBatchStore.getState().mode).toBe('multi')
      // multi 模式下 prompt 会盖到 multiText (HistoryPage 的传统语义),
      // 但 mode 本身没切, 用户可以手动切回 card 或继续在 multi 里编辑。
      expect(useBatchStore.getState().multiText).toBe('hi')
    })

    it('honors explicit snapshot.mode (HistoryPage 显式传 card)', () => {
      // HistoryPage.handleEdit 会显式传 mode='card', 这条路径必须不变。
      useBatchStore.setState({ mode: 'multi', multiText: 'old' })

      useBatchStore.getState().restoreForEdit({ prompt: 'hi', mode: 'card' })

      expect(useBatchStore.getState().mode).toBe('card')
      expect(useBatchStore.getState().cardPrompt).toBe('hi')
    })
  })

  describe('runBatch / snapshot 挂载', () => {
    it('在 worker 把 item flip 为 generating 时, 给 item 挂上 snapshot', async () => {
      const ratio = '16:9'
      const refRaw = ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB']
      const modelKey = 'test-model'

      // 用一个会"挂起"的 API, 让我们能在 generating 状态下检查 item.snapshot
      let resolveGen!: (v: any) => void
      const api = {
        generateImage: vi.fn(() => new Promise((resolve) => { resolveGen = resolve })),
      } as any

      useBatchStore.getState().addItem('test prompt')
      const itemId = useBatchStore.getState().items[0].id

      const runPromise = useBatchStore.getState().runBatch(api, modelKey, {
        ratio,
        referenceImages: refRaw,
        concurrency: 1,
        idleExitMs: 50,
      })

      // 等到 item 翻成 generating
      await vi.waitFor(() => {
        const it = useBatchStore.getState().items.find((i) => i.id === itemId)
        expect(it?.status).toBe('generating')
      })

      const item = useBatchStore.getState().items.find((i) => i.id === itemId)!
      expect(item.snapshot).toBeDefined()
      expect(item.snapshot!.prompt).toBe('test prompt')
      expect(item.snapshot!.ratio).toBe(ratio)
      expect(item.snapshot!.referenceImages).toEqual(refRaw)
      expect(item.snapshot!.modelKey).toBe(modelKey)

      // 解锁让 runBatch 完成 —— 用 success:false 让 worker 走 error 分支,
      // 这样不会触发 uploadImageUrlToCos 真实网络调用 (fire-and-forget 在
      // 测试环境会变成 unhandled rejection)。我们只关心 snapshot 是否写入。
      resolveGen({ success: false, error: 'test-end' })
      await runPromise
    })
  })
})

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

      await useBatchStore.getState().runBatch(api, 'model-x')

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

      await useBatchStore.getState().runBatch(api, 'model')

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
      await useBatchStore.getState().runBatch(api, 'model')

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
      await useBatchStore.getState().runBatch(api, 'model')

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

      await useBatchStore.getState().runBatch(api, 'model')

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

      await useBatchStore.getState().runBatch(api, 'model')

      const items = useBatchStore.getState().items
      expect(items[0].status).toBe('done')
      expect(items[0].resultUrl).toBe('http://via-images.jpg')
    })

    it('marks items as error when result has no url', async () => {
      useBatchStore.getState().addItem('no-url')

      const api = createMockApi({
        generateImage: vi.fn().mockResolvedValue({ success: true }),
      })

      await useBatchStore.getState().runBatch(api, 'model')

      const items = useBatchStore.getState().items
      expect(items[0].status).toBe('error')
      expect(items[0].error).toBe('接口未返回图片地址')
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

      const batchPromise = useBatchStore.getState().runBatch(api, 'model')

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

      const batchPromise = useBatchStore.getState().runBatch(api, 'model')

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

      const batchPromise = useBatchStore.getState().runBatch(api, 'model')
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

      const batchPromise = useBatchStore.getState().runBatch(api, 'model')

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
})

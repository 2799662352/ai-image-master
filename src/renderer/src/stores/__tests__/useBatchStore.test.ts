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
    useBatchStore.setState({ ...initialState, items: [] })
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

  it('bulkAdd splits text by newlines', () => {
    useBatchStore.getState().bulkAdd('cat\ndog\n\nhorse')

    const items = useBatchStore.getState().items
    expect(items).toHaveLength(3)
    expect(items.map((i) => i.prompt)).toEqual(['cat', 'dog', 'horse'])
    expect(items.every((i) => i.status === 'pending')).toBe(true)
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
  })
})

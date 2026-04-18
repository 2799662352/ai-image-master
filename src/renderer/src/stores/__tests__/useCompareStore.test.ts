import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCompareStore, initialState } from '../useCompareStore'
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

describe('useCompareStore', () => {
  beforeEach(() => {
    useCompareStore.setState({ ...initialState })
  })

  it('has correct initial state', () => {
    const state = useCompareStore.getState()
    expect(state.leftModelKey).toBeNull()
    expect(state.rightModelKey).toBeNull()
    expect(state.prompt).toBe('')
    expect(state.comparing).toBe(false)
    expect(state.leftResult).toBeNull()
    expect(state.rightResult).toBeNull()
    expect(state.error).toBeNull()
  })

  it('setLeftModel updates leftModelKey', () => {
    useCompareStore.getState().setLeftModel('flux')
    expect(useCompareStore.getState().leftModelKey).toBe('flux')
  })

  it('setRightModel updates rightModelKey', () => {
    useCompareStore.getState().setRightModel('dall-e')
    expect(useCompareStore.getState().rightModelKey).toBe('dall-e')
  })

  it('setPrompt updates prompt', () => {
    useCompareStore.getState().setPrompt('a sunset')
    expect(useCompareStore.getState().prompt).toBe('a sunset')
  })

  describe('compare', () => {
    it('resolves both sides on success', async () => {
      useCompareStore.setState({
        leftModelKey: 'flux',
        rightModelKey: 'dall-e',
        prompt: 'mountains',
      })

      const api = createMockApi({
        generateImage: vi
          .fn()
          .mockResolvedValueOnce({ success: true, urls: ['http://left.jpg'] })
          .mockResolvedValueOnce({ success: true, urls: ['http://right.jpg'] }),
      })

      await useCompareStore.getState().compare(api)

      const state = useCompareStore.getState()
      expect(state.leftResult).toBe('http://left.jpg')
      expect(state.rightResult).toBe('http://right.jpg')
      expect(state.comparing).toBe(false)
    })

    it('handles partial failure (left ok, right fails)', async () => {
      useCompareStore.setState({
        leftModelKey: 'flux',
        rightModelKey: 'dall-e',
        prompt: 'test',
      })

      const api = createMockApi({
        generateImage: vi
          .fn()
          .mockResolvedValueOnce({ success: true, urls: ['http://left.jpg'] })
          .mockRejectedValueOnce(new Error('right failed')),
      })

      await useCompareStore.getState().compare(api)

      const state = useCompareStore.getState()
      expect(state.leftResult).toBe('http://left.jpg')
      expect(state.rightResult).toBeNull()
      expect(state.comparing).toBe(false)
    })

    it('handles both failing', async () => {
      useCompareStore.setState({
        leftModelKey: 'a',
        rightModelKey: 'b',
        prompt: 'test',
      })

      const api = createMockApi({
        generateImage: vi.fn().mockRejectedValue(new Error('down')),
      })

      await useCompareStore.getState().compare(api)

      const state = useCompareStore.getState()
      expect(state.leftResult).toBeNull()
      expect(state.rightResult).toBeNull()
      expect(state.comparing).toBe(false)
    })

    it('falls back to images field', async () => {
      useCompareStore.setState({
        leftModelKey: 'a',
        rightModelKey: 'b',
        prompt: 'test',
      })

      const api = createMockApi({
        generateImage: vi
          .fn()
          .mockResolvedValueOnce({ success: true, images: ['http://left-img.jpg'] })
          .mockResolvedValueOnce({ success: true, images: ['http://right-img.jpg'] }),
      })

      await useCompareStore.getState().compare(api)

      const state = useCompareStore.getState()
      expect(state.leftResult).toBe('http://left-img.jpg')
      expect(state.rightResult).toBe('http://right-img.jpg')
    })
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useGenerateStore, initialState } from '../useGenerateStore'
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

describe('useGenerateStore', () => {
  beforeEach(() => {
    useGenerateStore.setState({ ...initialState })
  })

  it('has correct initial state', () => {
    const state = useGenerateStore.getState()
    expect(state.prompt).toBe('')
    expect(state.ratio).toBe('1:1')
    expect(state.generating).toBe(false)
    expect(state.resultUrls).toEqual([])
    expect(state.referenceImages).toEqual([])
    expect(state.error).toBeNull()
  })

  it('setPrompt updates prompt', () => {
    useGenerateStore.getState().setPrompt('a cat')
    expect(useGenerateStore.getState().prompt).toBe('a cat')
  })

  it('setRatio updates ratio', () => {
    useGenerateStore.getState().setRatio('16:9')
    expect(useGenerateStore.getState().ratio).toBe('16:9')
  })

  it('addReferenceImage appends to array', () => {
    useGenerateStore.getState().addReferenceImage('data:img1')
    useGenerateStore.getState().addReferenceImage('data:img2')
    expect(useGenerateStore.getState().referenceImages).toEqual(['data:img1', 'data:img2'])
  })

  it('removeReferenceImage removes by index', () => {
    useGenerateStore.setState({ referenceImages: ['a', 'b', 'c'] })
    useGenerateStore.getState().removeReferenceImage(1)
    expect(useGenerateStore.getState().referenceImages).toEqual(['a', 'c'])
  })

  it('clearResults resets resultUrls and error', () => {
    useGenerateStore.setState({ resultUrls: ['http://x.jpg'], error: 'old error' })
    useGenerateStore.getState().clearResults()
    const state = useGenerateStore.getState()
    expect(state.resultUrls).toEqual([])
    expect(state.error).toBeNull()
  })

  describe('generate', () => {
    it('happy path with urls', async () => {
      useGenerateStore.setState({ prompt: 'sunset', ratio: '1:1' })
      const api = createMockApi({
        generateImage: vi.fn().mockResolvedValue({
          success: true,
          urls: ['http://a.jpg', 'http://b.jpg'],
        }),
      })

      await useGenerateStore.getState().generate(api, 'flux')

      const state = useGenerateStore.getState()
      expect(state.resultUrls).toEqual(['http://a.jpg', 'http://b.jpg'])
      expect(state.generating).toBe(false)
      expect(state.error).toBeNull()
      expect(api.generateImage).toHaveBeenCalledWith({
        prompt: 'sunset',
        ratio: '1:1',
        model: 'flux',
        referenceImages: undefined,
      })
    })

    it('falls back to images when urls is absent', async () => {
      useGenerateStore.setState({ prompt: 'cat', ratio: '1:1' })
      const api = createMockApi({
        generateImage: vi.fn().mockResolvedValue({
          success: true,
          images: ['http://img1.jpg'],
        }),
      })

      await useGenerateStore.getState().generate(api, 'dall-e')

      expect(useGenerateStore.getState().resultUrls).toEqual(['http://img1.jpg'])
    })

    it('passes referenceImages when present', async () => {
      useGenerateStore.setState({
        prompt: 'edit',
        ratio: '1:1',
        referenceImages: ['data:ref1'],
      })
      const api = createMockApi()

      await useGenerateStore.getState().generate(api, 'model')

      expect(api.generateImage).toHaveBeenCalledWith(
        expect.objectContaining({ referenceImages: ['data:ref1'] })
      )
    })

    it('sets error on rejection', async () => {
      useGenerateStore.setState({ prompt: 'x', ratio: '1:1' })
      const api = createMockApi({
        generateImage: vi.fn().mockRejectedValue(new Error('rate limit')),
      })

      await useGenerateStore.getState().generate(api, 'model')

      const state = useGenerateStore.getState()
      expect(state.error).toBe('rate limit')
      expect(state.generating).toBe(false)
      expect(state.resultUrls).toEqual([])
    })

    it('handles non-Error exceptions', async () => {
      useGenerateStore.setState({ prompt: 'x', ratio: '1:1' })
      const api = createMockApi({
        generateImage: vi.fn().mockRejectedValue('string error'),
      })

      await useGenerateStore.getState().generate(api, 'model')

      expect(useGenerateStore.getState().error).toBe('string error')
    })
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useUnderstandStore, initialState } from '../useUnderstandStore'
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

describe('useUnderstandStore', () => {
  beforeEach(() => {
    useUnderstandStore.setState({ ...initialState })
  })

  it('has correct initial state', () => {
    const state = useUnderstandStore.getState()
    expect(state.imageUrl).toBeNull()
    expect(state.question).toBe('')
    expect(state.analysisResult).toBe('')
    expect(state.analyzing).toBe(false)
    expect(state.error).toBeNull()
  })

  it('setImageUrl updates imageUrl', () => {
    useUnderstandStore.getState().setImageUrl('http://img.jpg')
    expect(useUnderstandStore.getState().imageUrl).toBe('http://img.jpg')
  })

  it('setQuestion updates question', () => {
    useUnderstandStore.getState().setQuestion('what is this?')
    expect(useUnderstandStore.getState().question).toBe('what is this?')
  })

  describe('analyze', () => {
    it('happy path reads result.content', async () => {
      useUnderstandStore.setState({ imageUrl: 'http://photo.jpg', question: 'describe this' })
      const api = createMockApi({
        understandImage: vi.fn().mockResolvedValue({
          success: true,
          content: 'A beautiful landscape with mountains.',
        }),
      })

      await useUnderstandStore.getState().analyze(api)

      const state = useUnderstandStore.getState()
      expect(state.analysisResult).toBe('A beautiful landscape with mountains.')
      expect(state.analyzing).toBe(false)
      expect(state.error).toBeNull()
      expect(api.understandImage).toHaveBeenCalledWith({
        images: ['http://photo.jpg'],
        prompt: 'describe this',
      })
    })

    it('handles missing content gracefully', async () => {
      useUnderstandStore.setState({ imageUrl: 'http://photo.jpg', question: '' })
      const api = createMockApi({
        understandImage: vi.fn().mockResolvedValue({ success: true }),
      })

      await useUnderstandStore.getState().analyze(api)

      expect(useUnderstandStore.getState().analysisResult).toBe('')
      expect(api.understandImage).toHaveBeenCalledWith({
        images: ['http://photo.jpg'],
        prompt: undefined,
      })
    })

    it('sets error on rejection', async () => {
      useUnderstandStore.setState({ imageUrl: 'http://photo.jpg', question: '' })
      const api = createMockApi({
        understandImage: vi.fn().mockRejectedValue(new Error('vision quota exceeded')),
      })

      await useUnderstandStore.getState().analyze(api)

      const state = useUnderstandStore.getState()
      expect(state.error).toBe('vision quota exceeded')
      expect(state.analyzing).toBe(false)
      expect(state.analysisResult).toBe('')
    })

    it('handles non-Error exceptions', async () => {
      useUnderstandStore.setState({ imageUrl: 'http://photo.jpg', question: '' })
      const api = createMockApi({
        understandImage: vi.fn().mockRejectedValue(42),
      })

      await useUnderstandStore.getState().analyze(api)

      expect(useUnderstandStore.getState().error).toBe('42')
    })
  })
})

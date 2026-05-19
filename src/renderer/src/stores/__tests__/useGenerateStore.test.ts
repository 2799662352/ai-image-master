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
    expect(state.inFlightCount).toBe(0)
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

    // Regression: previously the page gated the button on `generating=true`
    // and `handleGenerate` cleared results before firing, so users had to
    // wait for one image to finish before submitting another. The store now
    // tracks `inFlightCount` and appends results so multiple generations
    // can run concurrently and stream in.
    it('supports concurrent fires — appends results from both', async () => {
      useGenerateStore.setState({ prompt: 'p', ratio: '1:1' })

      // Two resolvable promises we control manually to interleave timing.
      let resolveA: (v: any) => void = () => {}
      let resolveB: (v: any) => void = () => {}
      const pA = new Promise((res) => { resolveA = res })
      const pB = new Promise((res) => { resolveB = res })

      const api = createMockApi({
        generateImage: vi
          .fn()
          .mockImplementationOnce(() => pA)
          .mockImplementationOnce(() => pB),
      })

      const fA = useGenerateStore.getState().generate(api, 'm')
      // mid-flight check: in-flight count = 1, generating = true
      expect(useGenerateStore.getState().inFlightCount).toBe(1)
      expect(useGenerateStore.getState().generating).toBe(true)

      const fB = useGenerateStore.getState().generate(api, 'm')
      // both in flight
      expect(useGenerateStore.getState().inFlightCount).toBe(2)
      expect(useGenerateStore.getState().generating).toBe(true)

      // resolve B first, then A — order shouldn't matter, both append
      resolveB({ urls: ['b1.jpg'] })
      await fB
      expect(useGenerateStore.getState().inFlightCount).toBe(1)
      expect(useGenerateStore.getState().generating).toBe(true)
      expect(useGenerateStore.getState().resultUrls).toEqual(['b1.jpg'])

      resolveA({ urls: ['a1.jpg', 'a2.jpg'] })
      await fA
      const final = useGenerateStore.getState()
      expect(final.inFlightCount).toBe(0)
      expect(final.generating).toBe(false)
      // append-order: B finished first, then A
      expect(final.resultUrls).toEqual(['b1.jpg', 'a1.jpg', 'a2.jpg'])
    })

    it('decrements inFlightCount cleanly on mixed success/failure', async () => {
      useGenerateStore.setState({ prompt: 'p', ratio: '1:1' })

      let resolveA: (v: any) => void = () => {}
      let rejectB: (e: any) => void = () => {}
      const pA = new Promise((res) => { resolveA = res })
      const pB = new Promise((_, rej) => { rejectB = rej })

      const api = createMockApi({
        generateImage: vi
          .fn()
          .mockImplementationOnce(() => pA)
          .mockImplementationOnce(() => pB),
      })

      const fA = useGenerateStore.getState().generate(api, 'm')
      const fB = useGenerateStore.getState().generate(api, 'm')
      expect(useGenerateStore.getState().inFlightCount).toBe(2)

      rejectB(new Error('quota'))
      await fB
      expect(useGenerateStore.getState().error).toBe('quota')
      expect(useGenerateStore.getState().inFlightCount).toBe(1)
      expect(useGenerateStore.getState().generating).toBe(true)

      resolveA({ urls: ['ok.jpg'] })
      await fA
      const final = useGenerateStore.getState()
      expect(final.inFlightCount).toBe(0)
      expect(final.generating).toBe(false)
      expect(final.resultUrls).toEqual(['ok.jpg'])
    })

    it('snapshots referenceImages at submit time so subsequent edits do not affect in-flight call', async () => {
      useGenerateStore.setState({
        prompt: 'p',
        ratio: '1:1',
        referenceImages: ['ref1'],
      })

      let resolve: (v: any) => void = () => {}
      const p = new Promise((r) => { resolve = r })
      const api = createMockApi({ generateImage: vi.fn().mockReturnValueOnce(p) })

      const f = useGenerateStore.getState().generate(api, 'm')

      // Mid-flight: user edits refs (e.g. removes one, adds another).
      useGenerateStore.setState({ referenceImages: ['ref2'] })

      resolve({ urls: ['out.jpg'] })
      await f

      expect(api.generateImage).toHaveBeenCalledWith(
        expect.objectContaining({ referenceImages: ['ref1'] })
      )
    })
  })

  describe('restoreForEdit', () => {
    it('writes prompt / ratio / referenceImages back into the form', () => {
      useGenerateStore.setState({
        prompt: 'old',
        ratio: '1:1',
        referenceImages: ['existing'],
      })

      useGenerateStore.getState().restoreForEdit({
        prompt: 'restored',
        ratio: '16:9',
        referenceImages: ['ref-a', 'ref-b'],
      })

      const state = useGenerateStore.getState()
      expect(state.prompt).toBe('restored')
      expect(state.ratio).toBe('16:9')
      expect(state.referenceImages).toEqual(['ref-a', 'ref-b'])
      expect(state.error).toBeNull()
    })

    it('preserves current refs when snapshot omits referenceImages', () => {
      useGenerateStore.setState({
        prompt: 'old',
        ratio: '1:1',
        referenceImages: ['keep-me'],
      })

      useGenerateStore.getState().restoreForEdit({ prompt: 'new prompt' })

      const state = useGenerateStore.getState()
      expect(state.prompt).toBe('new prompt')
      expect(state.referenceImages).toEqual(['keep-me'])
    })

    it('clones referenceImages so later mutations do not leak back', () => {
      const incoming = ['a', 'b']
      useGenerateStore.getState().restoreForEdit({ referenceImages: incoming })
      incoming.push('c')
      expect(useGenerateStore.getState().referenceImages).toEqual(['a', 'b'])
    })

    it('clears error on restore (so stale error toast does not flash again)', () => {
      useGenerateStore.setState({ error: 'previous failure' })
      useGenerateStore.getState().restoreForEdit({ prompt: 'x' })
      expect(useGenerateStore.getState().error).toBeNull()
    })
  })

  describe('generate snapshot attachment', () => {
    it('attaches a snapshot (prompt / ratio / refs / modelKey) to each new meta', async () => {
      useGenerateStore.setState({
        prompt: 'a cat',
        ratio: '16:9',
        referenceImages: ['data:image/png;base64,XXX'],
      })

      const api = createMockApi({
        generateImage: vi.fn().mockResolvedValueOnce({ urls: ['out1.jpg', 'out2.jpg'] }),
      })
      await useGenerateStore.getState().generate(api, 'flux')

      const meta = useGenerateStore.getState().resultMeta
      expect(meta).toHaveLength(2)
      // 同一批的多张图共享 snapshot — 浅引用即可
      expect(meta[0].snapshot).toBeDefined()
      expect(meta[0].snapshot).toBe(meta[1].snapshot)
      expect(meta[0].snapshot).toEqual({
        prompt: 'a cat',
        ratio: '16:9',
        referenceImages: ['data:image/png;base64,XXX'],
        modelKey: 'flux',
      })
    })

    it('snapshot captures empty refs as [] (not undefined) for type stability', async () => {
      useGenerateStore.setState({ prompt: 'no refs', ratio: '1:1', referenceImages: [] })
      const api = createMockApi({
        generateImage: vi.fn().mockResolvedValueOnce({ urls: ['x.jpg'] }),
      })
      await useGenerateStore.getState().generate(api, 'flux')
      expect(useGenerateStore.getState().resultMeta[0].snapshot?.referenceImages).toEqual([])
    })
  })
})

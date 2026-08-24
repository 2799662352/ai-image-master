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

  it('clearReferenceImages empties the array', () => {
    useGenerateStore.setState({ referenceImages: ['a', 'b', 'c'] })
    useGenerateStore.getState().clearReferenceImages()
    expect(useGenerateStore.getState().referenceImages).toEqual([])
  })

  describe('syncReferenceImagesForModel — 双向清洗', () => {
    it('切到 base64 内联模型(true):删远端 URL,保留本地 base64', () => {
      useGenerateStore.setState({
        referenceImages: ['https://cos.example.com/a.png', 'data:image/png;base64,XXX'],
      })
      const removed = useGenerateStore.getState().syncReferenceImagesForModel(true)
      expect(removed).toBe(1)
      expect(useGenerateStore.getState().referenceImages).toEqual(['data:image/png;base64,XXX'])
    })

    it('切到 URL 模型(false):删本地 base64,保留远端 URL', () => {
      useGenerateStore.setState({
        referenceImages: ['https://cos.example.com/a.png', 'data:image/png;base64,XXX'],
      })
      const removed = useGenerateStore.getState().syncReferenceImagesForModel(false)
      expect(removed).toBe(1)
      expect(useGenerateStore.getState().referenceImages).toEqual(['https://cos.example.com/a.png'])
    })

    it('没有不兼容项时返回 0 且不改数组引用语义', () => {
      useGenerateStore.setState({ referenceImages: ['data:image/png;base64,A'] })
      expect(useGenerateStore.getState().syncReferenceImagesForModel(true)).toBe(0)
      expect(useGenerateStore.getState().referenceImages).toEqual(['data:image/png;base64,A'])
    })
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
        resolution: '2K',
        quality: 'auto',
        count: 1,
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
      resolveB({ success: true, urls: ['b1.jpg'] })
      await fB
      expect(useGenerateStore.getState().inFlightCount).toBe(1)
      expect(useGenerateStore.getState().generating).toBe(true)
      expect(useGenerateStore.getState().resultUrls).toEqual(['b1.jpg'])

      resolveA({ success: true, urls: ['a1.jpg', 'a2.jpg'] })
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

      resolveA({ success: true, urls: ['ok.jpg'] })
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

      resolve({ success: true, urls: ['out.jpg'] })
      await f

      expect(api.generateImage).toHaveBeenCalledWith(
        expect.objectContaining({ referenceImages: ['ref1'] })
      )
    })
  })

  describe('generate — 图层分离', () => {
    it('表单里没有 layerDecomposition 这个字段 —— 拆分只能从 overrides 进来', () => {
      // 它曾经是表单状态 + 参数区一个开关，勾上就改掉「生成」按钮的语义。
      // 现在拆分是自己的动作，出图表单不知道有这回事。这条守住它别回来。
      expect(useGenerateStore.getState()).not.toHaveProperty('layerDecomposition')
      expect(useGenerateStore.getState()).not.toHaveProperty('setLayerDecomposition')
    })

    it('普通出图不发 layerDecomposition 字段(请求形状不变)', async () => {
      useGenerateStore.setState({ prompt: 'a cat', ratio: '1:1' })
      const api = createMockApi()

      await useGenerateStore.getState().generate(api, 'flux')

      expect(api.generateImage).toHaveBeenCalledWith(
        expect.not.objectContaining({ layerDecomposition: expect.anything() }),
      )
    })

    it('走 overrides 时把 layerDecomposition 发给 ApiService', async () => {
      useGenerateStore.setState({ prompt: '用户正在写的下一条' })
      const api = createMockApi()

      await useGenerateStore.getState().generate(api, 'doubao-seedream-5-0-pro-260628', {
        prompt: '只拆出前景人物',
        referenceImages: ['https://cos.example.com/scene.png'],
        layerDecomposition: true,
      })

      expect(api.generateImage).toHaveBeenCalledWith(
        expect.objectContaining({
          layerDecomposition: true,
          prompt: '只拆出前景人物',
          referenceImages: ['https://cos.example.com/scene.png'],
        }),
      )
    })

    it('空 prompt 原样发出 —— 那是「自动全拆」，不是待补全的输入', async () => {
      useGenerateStore.setState({ prompt: '用户正在写的下一条' })
      const api = createMockApi()

      await useGenerateStore.getState().generate(api, 'doubao-seedream-5-0-pro-260628', {
        prompt: '',
        referenceImages: ['https://cos.example.com/scene.png'],
        layerDecomposition: true,
      })

      expect(api.generateImage).toHaveBeenCalledWith(expect.objectContaining({ prompt: '' }))
    })
  })

  describe('generate — 图层元数据落进 resultMeta', () => {
    const LAYER_RESULT = {
      success: true,
      urls: ['base.png', 'mid.png', 'top.png'],
      layers: [
        { url: 'base.png', mimeType: 'image/png', zIndex: 0 },
        { url: 'mid.png', mimeType: 'image/png', zIndex: 1, name: '前景人物', description: '站立的女性' },
        {
          url: 'top.png',
          mimeType: 'image/png',
          zIndex: 2,
          name: '标题文字',
          boundingBox: { normalized: [100, 200, 900, 400] },
        },
      ],
    }

    it('同批共享一个 layerGroupId，逐张带自己的 zIndex / name', async () => {
      useGenerateStore.setState({ prompt: '' })
      const api = createMockApi({ generateImage: vi.fn().mockResolvedValue(LAYER_RESULT) })

      await useGenerateStore.getState().generate(api, 'doubao-seedream-5-0-pro-260628', { layerDecomposition: true })

      const meta = useGenerateStore.getState().resultMeta
      expect(meta).toHaveLength(3)
      const gid = meta[0].layerGroupId
      expect(gid).toBeTruthy()
      expect(meta.every((m) => m.layerGroupId === gid)).toBe(true)
      expect(meta.map((m) => m.layer?.zIndex)).toEqual([0, 1, 2])
      expect(meta.map((m) => m.layer?.name)).toEqual([undefined, '前景人物', '标题文字'])
    })

    it('layer 里不存 url —— 上传热切后自带的那份就是过期链接', async () => {
      useGenerateStore.setState({ prompt: '' })
      const api = createMockApi({ generateImage: vi.fn().mockResolvedValue(LAYER_RESULT) })

      await useGenerateStore.getState().generate(api, 'doubao-seedream-5-0-pro-260628', { layerDecomposition: true })

      for (const m of useGenerateStore.getState().resultMeta) {
        expect(m.layer).not.toHaveProperty('url')
      }
    })

    it('带上 boundingBox / description，不在 store 层丢信息', async () => {
      useGenerateStore.setState({ prompt: '' })
      const api = createMockApi({ generateImage: vi.fn().mockResolvedValue(LAYER_RESULT) })

      await useGenerateStore.getState().generate(api, 'doubao-seedream-5-0-pro-260628', { layerDecomposition: true })

      const meta = useGenerateStore.getState().resultMeta
      expect(meta[1].layer?.description).toBe('站立的女性')
      expect(meta[2].layer?.boundingBox).toEqual({ normalized: [100, 200, 900, 400] })
    })

    it('普通出图不带 layerGroupId（不分组，网格行为不变）', async () => {
      useGenerateStore.setState({ prompt: 'a cat' })
      const api = createMockApi({
        generateImage: vi.fn().mockResolvedValue({ success: true, urls: ['a.jpg', 'b.jpg'] }),
      })

      await useGenerateStore.getState().generate(api, 'flux')

      for (const m of useGenerateStore.getState().resultMeta) {
        expect(m.layerGroupId).toBeUndefined()
        expect(m.layer).toBeUndefined()
      }
    })

    it('layers 与图片数量不一致时整批不认 —— 宁可退化平铺，也不要把图层名错配到别的图上', async () => {
      useGenerateStore.setState({ prompt: '' })
      const api = createMockApi({
        generateImage: vi.fn().mockResolvedValue({
          success: true,
          urls: ['a.png', 'b.png', 'c.png'],
          layers: [{ url: 'a.png', mimeType: 'image/png', zIndex: 0 }],
        }),
      })

      await useGenerateStore.getState().generate(api, 'doubao-seedream-5-0-pro-260628', { layerDecomposition: true })

      const meta = useGenerateStore.getState().resultMeta
      expect(meta).toHaveLength(3)
      expect(meta.every((m) => m.layerGroupId === undefined)).toBe(true)
    })
  })

  describe('generate overrides — 对已有图一键拆分', () => {
    it('用 overrides 发请求，且一个字都不动表单', async () => {
      // 用户正写着下一条 prompt、挂着别的参考图 —— 点某张结果图拆层不该洗掉它们
      useGenerateStore.setState({
        prompt: '用户正在写的下一条',
        referenceImages: ['data:ref-user'],
      })
      const api = createMockApi()

      await useGenerateStore.getState().generate(api, 'doubao-seedream-5-0-pro-260628', {
        prompt: '',
        referenceImages: ['https://x/target.png'],
        layerDecomposition: true,
      })

      expect(api.generateImage).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: '',
          referenceImages: ['https://x/target.png'],
          layerDecomposition: true,
          model: 'doubao-seedream-5-0-pro-260628',
        }),
      )
      const after = useGenerateStore.getState()
      expect(after.prompt).toBe('用户正在写的下一条')
      expect(after.referenceImages).toEqual(['data:ref-user'])
    })

    it('不给 overrides 时照旧读表单（原行为不变）', async () => {
      useGenerateStore.setState({ prompt: 'a cat', referenceImages: ['data:ref1'] })
      const api = createMockApi()

      await useGenerateStore.getState().generate(api, 'flux')

      expect(api.generateImage).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'a cat', referenceImages: ['data:ref1'] }),
      )
    })

    it('overrides 的产出照常进结果区并归组', async () => {
      useGenerateStore.setState({ prompt: '别动我' })
      const api = createMockApi({
        generateImage: vi.fn().mockResolvedValue({
          success: true,
          urls: ['base.png', 'l1.png'],
          layers: [
            { url: 'base.png', mimeType: 'image/png', zIndex: 0 },
            { url: 'l1.png', mimeType: 'image/png', zIndex: 1, name: '前景' },
          ],
        }),
      })

      const { added } = await useGenerateStore
        .getState()
        .generate(api, 'doubao-seedream-5-0-pro-260628', {
          prompt: '',
          referenceImages: ['https://x/target.png'],
          layerDecomposition: true,
        })

      expect(added).toBe(2)
      const meta = useGenerateStore.getState().resultMeta
      expect(meta).toHaveLength(2)
      expect(meta[0].layerGroupId).toBeTruthy()
      expect(meta[0].layerGroupId).toBe(meta[1].layerGroupId)
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
        generateImage: vi.fn().mockResolvedValueOnce({ success: true, urls: ['out1.jpg', 'out2.jpg'] }),
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
        generateImage: vi.fn().mockResolvedValueOnce({ success: true, urls: ['x.jpg'] }),
      })
      await useGenerateStore.getState().generate(api, 'flux')
      expect(useGenerateStore.getState().resultMeta[0].snapshot?.referenceImages).toEqual([])
    })
  })
})

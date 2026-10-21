import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initialState, useGenerateStore } from '../useGenerateStore'
import type { ApiActions } from '../../hooks/useService'

/**
 * 模型专属参数(悠船:原生 2K / 混沌 / 风格化 / 风格参考……)在生成页 store 里的语义:
 *
 *  - `modelParams` 只存用户**显式设置**的键;清空 / 改回默认 = 删键,「全部恢复自动」= 清空对象;
 *  - 没设置任何东西时,`generateImage` 的入参里**根本没有** `modelParams`(别的渠道的请求形状不变);
 *  - 失败卡的「重试」用的是原来那一次的参数,不是表单当前值(悠船按次计费,重试要和原请求一致)。
 */

function createMockApi(overrides: Partial<ApiActions> = {}): ApiActions {
  return {
    generateImage: vi.fn().mockResolvedValue({ success: true, urls: ['http://result.jpg'] }),
    understandImage: vi.fn(),
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
  } as ApiActions
}

describe('useGenerateStore — modelParams', () => {
  beforeEach(() => {
    useGenerateStore.setState({ ...initialState, prompt: '霓虹街道', ratio: '16:9' })
  })

  it('默认是空对象 —— 一切由模型自动决定', () => {
    expect(useGenerateStore.getState().modelParams).toEqual({})
  })

  it('setModelParam 只记用户显式设置的键', () => {
    const { setModelParam } = useGenerateStore.getState()
    setModelParam('chaos', 30)
    setModelParam('raw', true)
    setModelParam('sref', ['https://e.com/a.png'])
    expect(useGenerateStore.getState().modelParams).toEqual({
      chaos: 30,
      raw: true,
      sref: ['https://e.com/a.png'],
    })
  })

  it('清空(undefined / 空串 / 空数组)就是删键,不是存一个空值', () => {
    const { setModelParam } = useGenerateStore.getState()
    setModelParam('chaos', 30)
    setModelParam('no', 'watermark')
    setModelParam('sref', ['https://e.com/a.png'])

    setModelParam('chaos', undefined)
    setModelParam('no', '   ')
    setModelParam('sref', [])
    expect(useGenerateStore.getState().modelParams).toEqual({})
  })

  it('改回产品默认也是删键(原生 2K 默认开)—— 「已修改」不会被一个等于默认的残留值骗到', () => {
    const { setModelParam } = useGenerateStore.getState()
    setModelParam('hd', false, true)
    expect(useGenerateStore.getState().modelParams).toEqual({ hd: false })
    setModelParam('hd', true, true)
    expect(useGenerateStore.getState().modelParams).toEqual({})
  })

  it('resetModelParams = 「全部恢复自动」', () => {
    const { setModelParam, resetModelParams } = useGenerateStore.getState()
    setModelParam('hd', false, true)
    setModelParam('stylize', 800)
    resetModelParams()
    expect(useGenerateStore.getState().modelParams).toEqual({})
  })

  it('没设置时 generateImage 入参里没有 modelParams —— 别的渠道的请求形状不变', async () => {
    const generateImage = vi.fn().mockResolvedValue({ success: true, urls: ['http://a.jpg'] })
    await useGenerateStore.getState().generate(createMockApi({ generateImage }), 'gpt-image-2.5-flare')
    expect(generateImage.mock.calls[0][0]).not.toHaveProperty('modelParams')
  })

  it('设置了就原样带给 generateImage', async () => {
    const generateImage = vi.fn().mockResolvedValue({ success: true, urls: ['http://a.jpg'] })
    useGenerateStore.getState().setModelParam('hd', false, true)
    useGenerateStore.getState().setModelParam('chaos', 30)

    await useGenerateStore.getState().generate(createMockApi({ generateImage }), 'youchuan-v8.2')

    expect(generateImage.mock.calls[0][0]).toMatchObject({
      model: 'youchuan-v8.2',
      modelParams: { hd: false, chaos: 30 },
    })
  })

  it('发出去之后改表单不影响已发的那一份(传的是拷贝)', async () => {
    let seen: Record<string, unknown> | undefined
    const generateImage = vi.fn().mockImplementation(async (p: { modelParams?: Record<string, unknown> }) => {
      seen = p.modelParams
      return { success: true, urls: ['http://a.jpg'] }
    })
    useGenerateStore.getState().setModelParam('chaos', 30)
    await useGenerateStore.getState().generate(createMockApi({ generateImage }), 'youchuan-v8.2')

    useGenerateStore.getState().setModelParam('chaos', 90)
    expect(seen).toEqual({ chaos: 30 })
  })

  it('失败卡重试用原来那一次的参数,而不是表单当前值', async () => {
    const generateImage = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'HTTP 502' })
      .mockResolvedValueOnce({ success: true, urls: ['http://ok.jpg'] })
    const api = createMockApi({ generateImage })

    useGenerateStore.getState().setModelParam('stylize', 500)
    await useGenerateStore.getState().generate(api, 'youchuan-v8.2')
    const failed = useGenerateStore.getState().runs[0]

    // 用户接着调了别的参数
    useGenerateStore.getState().setModelParam('stylize', 50)
    useGenerateStore.getState().setModelParam('raw', true)

    await useGenerateStore.getState().retryRun(api, failed.id)

    expect(generateImage.mock.calls[1][0]).toMatchObject({
      model: 'youchuan-v8.2',
      modelParams: { stylize: 500 },
    })
    expect(generateImage.mock.calls[1][0].modelParams).not.toHaveProperty('raw')
    // 表单本身不被重试改动
    expect(useGenerateStore.getState().modelParams).toEqual({ stylize: 50, raw: true })
  })
})

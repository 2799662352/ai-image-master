import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initialState, useGenerateStore } from '../useGenerateStore'
import type { ApiActions } from '../../hooks/useService'

/**
 * 生成失败必须说出来。
 *
 * `ApiService.generateImage` 从不抛异常 —— 网络断连、上游 4xx/5xx、重试耗尽、
 * 33 分钟超时,一律折成返回值 `{ success: false, error }`。store 此前只读
 * `result.urls`,于是失败路径表现为「零张图、零提示」:按钮从"生成中"变回
 * "开始生成",什么都没发生,用户只能去 devtools 里才看得到原因。
 *
 * 结果同时回给调用方,而不是只写进 store —— 生成页允许并发点,靠"全局张数差"
 * 反推这一次成没成,在并发下会把别人的图算成自己的。
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

describe('useGenerateStore — 生成失败', () => {
  beforeEach(() => {
    useGenerateStore.setState({ ...initialState })
  })

  it('上游返回 success:false 时把原因写进 error,并如实回给调用方', async () => {
    const api = createMockApi({
      generateImage: vi.fn().mockResolvedValue({
        success: false,
        error: '未能从响应中提取图片，响应片段：{...}',
      }),
    })

    const outcome = await useGenerateStore.getState().generate(api, 'nano-banana')

    expect(outcome).toEqual({ added: 0, error: '未能从响应中提取图片，响应片段：{...}' })
    expect(useGenerateStore.getState().error).toBe('未能从响应中提取图片，响应片段：{...}')
  })

  it('失败后不留下"生成中"状态', async () => {
    const api = createMockApi({
      generateImage: vi.fn().mockResolvedValue({ success: false, error: '网络连接失败' }),
    })

    await useGenerateStore.getState().generate(api, 'm')

    const state = useGenerateStore.getState()
    expect(state.generating).toBe(false)
    expect(state.inFlightCount).toBe(0)
    expect(state.resultUrls).toEqual([])
    expect(state.resultMeta).toEqual([])
  })

  it('上游说成功却一张图都没给,同样算失败', async () => {
    // 正常不会发生(parseResponse 空图时就报 success:false),但这一步是最后
    // 一道闸:放行的话又会回到"零张图、零提示"。
    const api = createMockApi({
      generateImage: vi.fn().mockResolvedValue({ success: true, urls: [] }),
    })

    const outcome = await useGenerateStore.getState().generate(api, 'm')

    expect(outcome.added).toBe(0)
    expect(outcome.error).toBeTruthy()
    expect(useGenerateStore.getState().error).toBeTruthy()
  })

  it('抛异常的实现也走同一条汇报路径', async () => {
    const api = createMockApi({
      generateImage: vi.fn().mockRejectedValue(new Error('boom')),
    })

    const outcome = await useGenerateStore.getState().generate(api, 'm')

    expect(outcome).toEqual({ added: 0, error: 'boom' })
    expect(useGenerateStore.getState().generating).toBe(false)
  })

  it('成功时回报本次真正新增的张数', async () => {
    const api = createMockApi({
      generateImage: vi.fn().mockResolvedValue({ success: true, urls: ['a.jpg', 'b.jpg'] }),
    })

    const outcome = await useGenerateStore.getState().generate(api, 'm')

    expect(outcome).toEqual({ added: 2 })
  })

  it('并发时各自回报自己的结果,不被对方的图干扰', async () => {
    // 失败的那次不能因为另一次成功入了两张图,就以为自己也成了。
    const api = createMockApi({
      generateImage: vi.fn()
        .mockResolvedValueOnce({ success: false, error: '账户余额不足' })
        .mockResolvedValueOnce({ success: true, urls: ['a.jpg', 'b.jpg'] }),
    })

    const [failed, ok] = await Promise.all([
      useGenerateStore.getState().generate(api, 'm'),
      useGenerateStore.getState().generate(api, 'm'),
    ])

    expect(failed).toEqual({ added: 0, error: '账户余额不足' })
    expect(ok).toEqual({ added: 2 })
    expect(useGenerateStore.getState().generating).toBe(false)
  })
})

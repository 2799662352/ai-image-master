import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useGenerateStore, initialState, LAYER_SPLIT_MODEL } from '../useGenerateStore'
import type { ApiActions } from '../../hooks/useService'

function createMockApi(over?: Partial<ApiActions>): ApiActions {
  return {
    generateImage: vi.fn().mockResolvedValue({ success: true, urls: ['base.png'] }),
    ...over,
  } as unknown as ApiActions
}

beforeEach(() => {
  // 不加 replace:那会连 actions 一起擦掉。
  useGenerateStore.setState({ ...initialState })
})

/**
 * 「拆图状态」= 点了图层分离之后、真正开跑之前的中间态。
 *
 * 存在的理由是钱:拆分按张计费,一张复杂图能出 1 底图 + 16 层。点一下直接扣费
 * 没有反悔余地,所以给一个能改档位、能取消的状态,主按钮改名后点它才跑。
 */
describe('拆图状态', () => {
  it('进入状态不发任何请求 —— 这正是它存在的意义', () => {
    const api = createMockApi()
    useGenerateStore.getState().enterSplitMode('https://x/a.png')

    expect(useGenerateStore.getState().splitDraft).toEqual({
      imageUrl: 'https://x/a.png',
      resolution: 'auto',
    })
    expect(api.generateImage).not.toHaveBeenCalled()
  })

  it('默认档位跟随原图 —— 拆的就是眼前这张，底图不该被重出成别的尺寸', () => {
    useGenerateStore.getState().enterSplitMode('https://x/a.png')
    expect(useGenerateStore.getState().splitDraft?.resolution).toBe('auto')
  })

  it('状态里换图保留已调的档位（刚选完 1K 又换张图，不该被洗回 auto）', () => {
    const s = useGenerateStore.getState()
    s.enterSplitMode('https://x/a.png')
    s.updateSplitDraft({ resolution: '1K' })
    s.enterSplitMode('https://x/b.png')

    expect(useGenerateStore.getState().splitDraft).toEqual({
      imageUrl: 'https://x/b.png',
      resolution: '1K',
    })
  })

  it('不在状态里时 updateSplitDraft 是 no-op（不会凭空造出一个状态）', () => {
    useGenerateStore.getState().updateSplitDraft({ resolution: '2K' })
    expect(useGenerateStore.getState().splitDraft).toBeNull()
  })

  it('进出状态都不碰出图表单 —— 用户正在写的下一条 prompt 必须还在', () => {
    useGenerateStore.setState({ prompt: '用户正在写的下一条', ratio: '16:9', count: 3 })
    const s = useGenerateStore.getState()
    s.enterSplitMode('https://x/a.png')
    s.exitSplitMode()

    const after = useGenerateStore.getState()
    expect(after.splitDraft).toBeNull()
    expect(after.prompt).toBe('用户正在写的下一条')
    expect(after.ratio).toBe('16:9')
    expect(after.count).toBe(3)
  })

  it('runSplit 钉死 SD5 Pro，不看用户当前选的模型', async () => {
    const api = createMockApi()
    useGenerateStore.getState().enterSplitMode('https://x/a.png')

    await useGenerateStore.getState().runSplit(api)

    expect(api.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ model: LAYER_SPLIT_MODEL, layerDecomposition: true }),
    )
  })

  it('把出图框里那句当 prompt 发出去 —— 上游用它指定「要拆出什么」', async () => {
    const api = createMockApi()
    useGenerateStore.setState({ prompt: '女人抠出来', resolution: '4K' })
    const s = useGenerateStore.getState()
    s.enterSplitMode('https://x/a.png')
    s.updateSplitDraft({ resolution: '1.5K' })

    await useGenerateStore.getState().runSplit(api)

    expect(api.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: '女人抠出来',
        // 档位取状态里的，不是表单的 4K
        resolution: '1.5K',
        referenceImages: ['https://x/a.png'],
      }),
    )
  })

  it('提示词为空时发空串 —— 那是「自动全拆」，不是缺输入', async () => {
    const api = createMockApi()
    useGenerateStore.setState({ prompt: '' })
    useGenerateStore.getState().enterSplitMode('https://x/a.png')

    await useGenerateStore.getState().runSplit(api)

    expect(api.generateImage).toHaveBeenCalledWith(expect.objectContaining({ prompt: '' }))
  })

  it('跑完状态不掉 —— 同一张图常要换几种说法试，每次重选图没法比', async () => {
    const api = createMockApi()
    useGenerateStore.getState().enterSplitMode('https://x/a.png')

    await useGenerateStore.getState().runSplit(api)

    expect(useGenerateStore.getState().splitDraft).toEqual({
      imageUrl: 'https://x/a.png',
      resolution: 'auto',
    })
  })

  it('换句话再点一次：拆的还是同一张，prompt 跟着变', async () => {
    const api = createMockApi()
    useGenerateStore.setState({ prompt: '只要人' })
    useGenerateStore.getState().enterSplitMode('https://x/a.png')
    await useGenerateStore.getState().runSplit(api)

    useGenerateStore.setState({ prompt: '把文字也拆出来' })
    await useGenerateStore.getState().runSplit(api)

    const calls = (api.generateImage as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0][0].prompt).toBe('只要人')
    expect(calls[1][0].prompt).toBe('把文字也拆出来')
    expect(calls[1][0].referenceImages).toEqual(['https://x/a.png'])
  })

  it('失败也不掉状态，直接能重试', async () => {
    const api = createMockApi({
      generateImage: vi.fn().mockResolvedValue({ success: false, error: '上游 500' }),
    })
    const s = useGenerateStore.getState()
    s.enterSplitMode('https://x/a.png')
    s.updateSplitDraft({ resolution: '2K' })

    const outcome = await useGenerateStore.getState().runSplit(api)

    expect(outcome.error).toBe('上游 500')
    expect(useGenerateStore.getState().splitDraft).toEqual({
      imageUrl: 'https://x/a.png',
      resolution: '2K',
    })
  })

  it('不在状态里调 runSplit 什么都不发（主按钮在普通出图下不该误触这条路）', async () => {
    const api = createMockApi()
    const outcome = await useGenerateStore.getState().runSplit(api)

    expect(outcome).toEqual({ added: 0 })
    expect(api.generateImage).not.toHaveBeenCalled()
  })

  it('普通出图路径不受影响：不带 layerDecomposition，也不读 splitDraft', async () => {
    const api = createMockApi()
    useGenerateStore.setState({ prompt: 'a cat' })
    useGenerateStore.getState().enterSplitMode('https://x/a.png')

    await useGenerateStore.getState().generate(api, 'flux')

    expect(api.generateImage).toHaveBeenCalledWith(
      expect.not.objectContaining({ layerDecomposition: expect.anything() }),
    )
    expect(api.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'a cat', model: 'flux' }),
    )
  })
})

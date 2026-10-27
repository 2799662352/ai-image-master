import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { useBatchStore, initialState } from '../useBatchStore'
import type { ApiActions } from '../../hooks/useService'

// 上传是 fire-and-forget 的主进程 IPC,这里只关心「参数有没有带到 generateImage」。
vi.mock('../../utils/cosUploadDispatcher', () => ({
  enqueueCosUpload: vi.fn(),
  enqueueCosUploadBlob: vi.fn(),
  registerCosUploadHandler: vi.fn(),
}))

const TEST_OPTS = { concurrency: 1, idleExitMs: 0 } as const

function createApi(urls: string[] = ['http://result.jpg']) {
  const generateImage = vi.fn().mockResolvedValue({ success: true, urls })
  return { api: { generateImage } as unknown as ApiActions, generateImage }
}

const lastCall = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)![0] as Record<string, unknown>

describe('useBatchStore 模型专属参数(悠船原生 2K / 混沌……)', () => {
  beforeEach(() => {
    useBatchStore.setState({ ...initialState })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('面板状态', () => {
    it('默认全空 = 全部自动', () => {
      expect(useBatchStore.getState().modelParams).toEqual({})
    })

    it('设置 / 覆盖 / 清空(空串、空数组、undefined)都落在 store 里', () => {
      const s = useBatchStore.getState()
      s.setModelParam('chaos', 30)
      s.setModelParam('no', 'watermark')
      s.setModelParam('sref', ['https://x/a.png'])
      expect(useBatchStore.getState().modelParams).toEqual({ chaos: 30, no: 'watermark', sref: ['https://x/a.png'] })

      s.setModelParam('chaos', 50)
      expect(useBatchStore.getState().modelParams.chaos).toBe(50)

      s.setModelParam('no', '   ')
      s.setModelParam('sref', [])
      s.setModelParam('chaos', undefined)
      expect(useBatchStore.getState().modelParams).toEqual({})
    })

    it('改回默认值 = 删键(「已修改」才不会被一个等于默认的残留值骗到)', () => {
      const s = useBatchStore.getState()
      s.setModelParam('hd', false)
      expect(useBatchStore.getState().modelParams).toEqual({ hd: false })
      s.setModelParam('hd', true, true)
      expect(useBatchStore.getState().modelParams).toEqual({})
    })

    it('resetModelParams 一键恢复自动', () => {
      const s = useBatchStore.getState()
      s.setModelParam('chaos', 30)
      s.setModelParam('hd', false)
      s.resetModelParams()
      expect(useBatchStore.getState().modelParams).toEqual({})
    })
  })

  describe('随请求外发', () => {
    it('面板没动过 → generateImage 入参里一个 modelParams 键都没有(其它渠道不受影响)', async () => {
      const { api, generateImage } = createApi()
      useBatchStore.getState().addItem('a cat')
      await useBatchStore.getState().runBatch(api, 'youchuan-v8.2', TEST_OPTS)
      expect(lastCall(generateImage)).not.toHaveProperty('modelParams')
    })

    it('整批默认:runBatch 起跑时取 store 当前值', async () => {
      const { api, generateImage } = createApi()
      useBatchStore.getState().setModelParam('hd', false)
      useBatchStore.getState().setModelParam('chaos', 40)
      useBatchStore.getState().addItem('a cat')
      await useBatchStore.getState().runBatch(api, 'youchuan-v8.2', TEST_OPTS)
      expect(lastCall(generateImage).modelParams).toEqual({ hd: false, chaos: 40 })
    })

    it('入队时锁定:之后改面板,已排队的项仍按入队时的值发', async () => {
      const { api, generateImage } = createApi()
      useBatchStore.getState().addItem('first', { modelParams: { chaos: 10 } })
      useBatchStore.getState().setModelParam('chaos', 99) // 入队后才改
      await useBatchStore.getState().runBatch(api, 'youchuan-v8.2', TEST_OPTS)
      expect(lastCall(generateImage).modelParams).toEqual({ chaos: 10 })
    })

    it('入队的是拷贝:调用方之后改传进去的对象,不会改到队列里的项', async () => {
      const { api, generateImage } = createApi()
      const params = { chaos: 10 }
      useBatchStore.getState().addItem('first', { modelParams: params })
      params.chaos = 77
      await useBatchStore.getState().runBatch(api, 'youchuan-v8.2', TEST_OPTS)
      expect(lastCall(generateImage).modelParams).toEqual({ chaos: 10 })
    })

    it('一批里各项各带各的参数,互不串', async () => {
      const { api, generateImage } = createApi()
      useBatchStore.getState().addItem('a', { modelParams: { chaos: 10 } })
      useBatchStore.getState().addItem('b', { modelParams: { stylize: 500, hd: false } })
      await useBatchStore.getState().runBatch(api, 'youchuan-v8.2', TEST_OPTS)
      const byPrompt = new Map(generateImage.mock.calls.map(([p]) => [p.prompt, p.modelParams]))
      expect(byPrompt.get('a')).toEqual({ chaos: 10 })
      expect(byPrompt.get('b')).toEqual({ stylize: 500, hd: false })
    })

    it('item 自带的空对象 = 明确「全部自动」,不回落到整批默认', async () => {
      const { api, generateImage } = createApi()
      useBatchStore.getState().addItem('auto', { modelParams: {} })
      await useBatchStore.getState().runBatch(api, 'youchuan-v8.2', {
        ...TEST_OPTS,
        modelParams: { chaos: 80 }, // 整批默认带了混沌,但这一项入队时面板是空的
      })
      expect(lastCall(generateImage)).not.toHaveProperty('modelParams')
    })

    it('item 没带 → 回落整批默认(runBatch opts 优先于 store)', async () => {
      const { api, generateImage } = createApi()
      useBatchStore.getState().setModelParam('chaos', 5) // store 里的值会被 opts 顶掉
      useBatchStore.getState().addItem('plain')
      await useBatchStore.getState().runBatch(api, 'youchuan-v8.2', {
        ...TEST_OPTS,
        modelParams: { stylize: 300 },
      })
      expect(lastCall(generateImage).modelParams).toEqual({ stylize: 300 })
    })

    it('发出去的是拷贝:下游改它不会反改队列里的项', async () => {
      const generateImage = vi.fn().mockImplementation(async (p: { modelParams?: Record<string, unknown> }) => {
        if (p.modelParams) p.modelParams.chaos = 999 // 模拟下游就地改
        return { success: true, urls: ['http://result.jpg'] }
      })
      useBatchStore.getState().addItem('a', { modelParams: { chaos: 10 } })
      await useBatchStore.getState().runBatch({ generateImage } as unknown as ApiActions, 'youchuan-v8.2', TEST_OPTS)
      expect(useBatchStore.getState().items[0].modelParams).toEqual({ chaos: 10 })
    })

    it('图层分离项走固定渠道:不带模型专属参数', async () => {
      const { api, generateImage } = createApi()
      useBatchStore.getState().setModelParam('chaos', 40)
      useBatchStore.getState().addLayerSplitItem('https://x/a.png')
      await useBatchStore.getState().runBatch(api, 'youchuan-v8.2', TEST_OPTS)
      expect(lastCall(generateImage)).not.toHaveProperty('modelParams')
    })
  })

  describe('一次 4 张(悠船)', () => {
    it('一次返回 4 张 → 4 张完成卡,每张都带同一份参数快照', async () => {
      const { api, generateImage } = createApi([
        'http://r/1.jpg',
        'http://r/2.jpg',
        'http://r/3.jpg',
        'http://r/4.jpg',
      ])
      useBatchStore.getState().addItem('a cat', { modelParams: { hd: false, chaos: 20 } })
      await useBatchStore.getState().runBatch(api, 'youchuan-v8.2', TEST_OPTS)

      expect(generateImage).toHaveBeenCalledTimes(1) // 4 张只是一次请求
      const items = useBatchStore.getState().items
      expect(items).toHaveLength(4)
      expect(items.every((i) => i.status === 'done')).toBe(true)
      expect(items.every((i) => i.snapshot?.modelParams?.chaos === 20)).toBe(true)
    })
  })

  describe('快照 / 重编辑回灌', () => {
    it('生成时把参数写进快照;没动过参数面板的项快照里没有这个键', async () => {
      const { api } = createApi()
      useBatchStore.getState().addItem('with', { modelParams: { chaos: 20 } })
      useBatchStore.getState().addItem('without', { modelParams: {} })
      await useBatchStore.getState().runBatch(api, 'youchuan-v8.2', TEST_OPTS)
      const items = useBatchStore.getState().items
      expect(items.find((i) => i.prompt === 'with')!.snapshot!.modelParams).toEqual({ chaos: 20 })
      expect(items.find((i) => i.prompt === 'without')!.snapshot).not.toHaveProperty('modelParams')
    })

    it('快照里的参数是拷贝,面板之后再改不会回改历史项', async () => {
      const { api } = createApi()
      useBatchStore.getState().addItem('a', { modelParams: { chaos: 20 } })
      await useBatchStore.getState().runBatch(api, 'youchuan-v8.2', TEST_OPTS)
      useBatchStore.getState().setModelParam('chaos', 90)
      expect(useBatchStore.getState().items[0].snapshot!.modelParams).toEqual({ chaos: 20 })
    })

    it('restoreForEdit 带 modelParams → 面板整体换成那一份', () => {
      useBatchStore.getState().setModelParam('stylize', 700)
      useBatchStore.getState().restoreForEdit({ prompt: 'p', modelParams: { chaos: 20 } })
      expect(useBatchStore.getState().modelParams).toEqual({ chaos: 20 })
    })

    it('restoreForEdit 传空对象 → 回灌成「全部自动」', () => {
      useBatchStore.getState().setModelParam('stylize', 700)
      useBatchStore.getState().restoreForEdit({ prompt: 'p', modelParams: {} })
      expect(useBatchStore.getState().modelParams).toEqual({})
    })

    it('restoreForEdit 没提 modelParams(历史页老入口)→ 保留面板现状', () => {
      useBatchStore.getState().setModelParam('stylize', 700)
      useBatchStore.getState().restoreForEdit({ prompt: 'p' })
      expect(useBatchStore.getState().modelParams).toEqual({ stylize: 700 })
    })
  })
})

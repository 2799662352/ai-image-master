import { describe, it, expect, beforeEach } from 'vitest'
import { useBatchStore } from '../useBatchStore'
import { LAYER_SPLIT_MODEL } from '../useGenerateStore'

beforeEach(() => {
  useBatchStore.setState({ items: [], running: false })
})

const last = () => useBatchStore.getState().items.at(-1)!

describe('addLayerSplitItem', () => {
  it('钉死 SD5 Pro + 打上拆分标记 —— 不看用户当前选的模型', () => {
    useBatchStore.getState().addLayerSplitItem('https://x/a.png')
    expect(last().modelKey).toBe(LAYER_SPLIT_MODEL)
    expect(last().layerDecomposition).toBe(true)
    expect(last().referenceImages).toEqual(['https://x/a.png'])
  })

  it('带上用户的提示词 —— 上游用它指定「要拆出什么」', () => {
    useBatchStore.getState().addLayerSplitItem('https://x/a.png', { prompt: '女人抠出来' })
    expect(last().prompt).toBe('女人抠出来')
  })

  it('不给提示词就是空串 —— 自动全拆，是合法形态不是缺输入', () => {
    useBatchStore.getState().addLayerSplitItem('https://x/a.png')
    expect(last().prompt).toBe('')
  })

  it('档位默认跟随原图，也可以指定', () => {
    const s = useBatchStore.getState()
    s.addLayerSplitItem('https://x/a.png')
    expect(last().resolution).toBe('auto')
    s.addLayerSplitItem('https://x/b.png', { resolution: '1.5K' })
    expect(last().resolution).toBe('1.5K')
  })

  it('连着点几次就排几张，互不覆盖（主按钮在拆图状态下恒可点，就是为了这个）', () => {
    const s = useBatchStore.getState()
    s.addLayerSplitItem('https://x/a.png', { prompt: '只要人' })
    s.addLayerSplitItem('https://x/a.png', { prompt: '只要背景' })
    s.addLayerSplitItem('https://x/b.png')

    const items = useBatchStore.getState().items
    expect(items).toHaveLength(3)
    expect(items.map((i) => i.prompt)).toEqual(['只要人', '只要背景', ''])
    expect(items.every((i) => i.layerDecomposition)).toBe(true)
  })
})

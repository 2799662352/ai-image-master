import { describe, it, expect, vi } from 'vitest'
import {
  serializeFileDrag,
  parseFileDrop,
  serializeQuoteDrag,
  parseQuoteDrop,
  serializeWorkbenchCardDrag,
  parseWorkbenchCardDrop,
  dragCarriesDroppablePayload,
  dragCarriesWorkbenchCards,
} from '../dragHelpers'

const WORKBENCH_CARD_MIME = 'application/x-catimation-workbench-cards'

function makeDataTransfer(): DataTransfer {
  const data = new Map<string, string>()
  return {
    get types() {
      return [...data.keys()]
    },
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
  } as DataTransfer
}

describe('drag helpers', () => {
  it('round-trips a single file path through serialize/parse', () => {
    const dt = makeDataTransfer()
    serializeFileDrag(dt, ['D:\\foo\\bar.ts'])
    expect(parseFileDrop(dt)).toEqual(['D:\\foo\\bar.ts'])
  })

  it('round-trips multiple file paths in original order', () => {
    const dt = makeDataTransfer()
    const paths = ['D:\\a.ts', 'D:\\sub\\b.ts', 'D:\\c.png']
    serializeFileDrag(dt, paths)
    expect(parseFileDrop(dt)).toEqual(paths)
  })

  it('writes a newline-joined text/plain fallback', () => {
    const dt = makeDataTransfer()
    serializeFileDrag(dt, ['D:\\a.ts', 'D:\\b.ts'])
    expect(dt.getData('text/plain')).toBe('D:\\a.ts\nD:\\b.ts')
  })

  it('serializeFileDrag with empty array is a no-op', () => {
    const dt = makeDataTransfer()
    serializeFileDrag(dt, [])
    expect(parseFileDrop(dt)).toEqual([])
  })

  it('round-trips a quote block', () => {
    const dt = makeDataTransfer()
    const q = '```ts:1-3:foo.ts\nx\n```'
    serializeQuoteDrag(dt, q)
    expect(parseQuoteDrop(dt)).toBe(q)
  })

  it('parseFileDrop returns empty array when no path payload', () => {
    const dt = makeDataTransfer()
    expect(parseFileDrop(dt)).toEqual([])
  })

  it('parseQuoteDrop returns null when no quote payload', () => {
    const dt = makeDataTransfer()
    expect(parseQuoteDrop(dt)).toBeNull()
  })
})

describe('工作台卡片载荷', () => {
  it('整份往返:三级地址、状态与规格摘要都不丢', () => {
    const dt = makeDataTransfer()
    const items = [
      {
        cardId: 'c1',
        localPath: 'C:/u/agent/uploads/a.mp4',
        remoteUrl: 'https://cos.example.com/a.mp4',
        videoUrl: 'https://ark.example.com/tmp/a.mp4',
        status: 'succeeded',
        spec: {
          prompt: '雨夜霓虹',
          model: '2.0-pro',
          resolution: '1080p',
          ratio: '16:9',
          duration: -1,
          generateAudio: true,
          mode: 'multimodal_ref',
          webSearch: false,
          referenceBrief: { images: ['猫.png'], videos: [], audios: [] },
        },
      },
    ]
    serializeWorkbenchCardDrag(dt, items)
    expect(parseWorkbenchCardDrop(dt)).toEqual(items)
  })

  it('text/plain 兜底按 localPath → remoteUrl → videoUrl → cardId 逐级降级', () => {
    const dt = makeDataTransfer()
    serializeWorkbenchCardDrag(dt, [
      { cardId: 'c1', localPath: 'C:/u/a.mp4', remoteUrl: 'https://cos.example.com/a.mp4' },
      { cardId: 'c2', remoteUrl: 'https://cos.example.com/b.mp4' },
      { cardId: 'c3', videoUrl: 'https://ark.example.com/tmp/c.mp4' },
      { cardId: 'c4' },
    ])

    expect(dt.getData('text/plain')).toBe(
      ['C:/u/a.mp4', 'https://cos.example.com/b.mp4', 'https://ark.example.com/tmp/c.mp4', 'c4'].join('\n'),
    )
  })

  it('还没有产物的卡照样写载荷 —— 少了它聊天栏无从分辨「没做好」与「拖失败」', () => {
    const dt = makeDataTransfer()
    serializeWorkbenchCardDrag(dt, [{ cardId: 'c1', status: 'draft' }])
    expect(parseWorkbenchCardDrop(dt)).toEqual([{ cardId: 'c1', status: 'draft' }])
  })

  it('空数组是 no-op', () => {
    const dt = makeDataTransfer()
    serializeWorkbenchCardDrag(dt, [])
    expect(dt.types).toEqual([])
    expect(parseWorkbenchCardDrop(dt)).toEqual([])
  })

  it('损坏的载荷按「没有卡片」处理而不是抛 —— 外部页面也能写这个 MIME', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const notJson = makeDataTransfer()
    notJson.setData(WORKBENCH_CARD_MIME, '{ 半个 JSON')
    expect(parseWorkbenchCardDrop(notJson)).toEqual([])

    const wrongShape = makeDataTransfer()
    wrongShape.setData(WORKBENCH_CARD_MIME, JSON.stringify([{ nope: 1 }]))
    expect(parseWorkbenchCardDrop(wrongShape)).toEqual([])
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})

describe('谁该为哪种载荷亮起来', () => {
  it('dragCarriesWorkbenchCards 只认卡片 MIME', () => {
    const cards = makeDataTransfer()
    serializeWorkbenchCardDrag(cards, [{ cardId: 'c1' }])
    expect(dragCarriesWorkbenchCards(cards)).toBe(true)

    const files = makeDataTransfer()
    serializeFileDrag(files, ['D:/a.ts'])
    expect(dragCarriesWorkbenchCards(files)).toBe(false)
  })

  it('通用判据刻意不认卡片 —— 否则文件树也会亮,而拖上去松手会 fs.move 掉 mp4', () => {
    // 这条是设计意图的锚:卡片只有聊天栏接得住,所以由它显式认领,而不是把卡片
    // 混进「我们家的通用载荷」让所有投放目标一起亮。放松它等于发一张假许可。
    const cards = makeDataTransfer()
    serializeWorkbenchCardDrag(cards, [{ cardId: 'c1' }])
    expect(dragCarriesDroppablePayload(cards)).toBe(false)

    const files = makeDataTransfer()
    serializeFileDrag(files, ['D:/a.ts'])
    expect(dragCarriesDroppablePayload(files)).toBe(true)

    const quote = makeDataTransfer()
    serializeQuoteDrag(quote, '```ts\nx\n```')
    expect(dragCarriesDroppablePayload(quote)).toBe(true)
  })
})

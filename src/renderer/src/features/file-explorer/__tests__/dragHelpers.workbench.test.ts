// 工作台卡片拖拽载荷的往返。DataTransfer 在 jsdom 里不完整,用最小替身。

import { describe, expect, it } from 'vitest'
import {
  parseWorkbenchCardDrop,
  serializeWorkbenchCardDrag,
} from '../dragHelpers'
import type { VideoWorkbenchCardDragItem } from '../../../../../types/videoWorkbench'

function fakeDt(): DataTransfer {
  const store = new Map<string, string>()
  return {
    setData: (t: string, v: string) => void store.set(t, v),
    getData: (t: string) => store.get(t) ?? '',
    get types() {
      return [...store.keys()]
    },
  } as unknown as DataTransfer
}

const item: VideoWorkbenchCardDragItem = {
  cardId: 'c1',
  promptExcerpt: '一只猫跳上桌子',
  status: 'succeeded',
  localPath: 'C:/u/agent/uploads/a.mp4',
}

describe('工作台卡片拖拽载荷', () => {
  it('序列化后能无损解回', () => {
    const dt = fakeDt()
    serializeWorkbenchCardDrag(dt, [item, { ...item, cardId: 'c2', localPath: undefined }])
    const parsed = parseWorkbenchCardDrop(dt)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toEqual(item)
    expect(parsed[1].localPath).toBeUndefined()
  })

  it('顺带写 text/plain 兜底,外部目标也看得见', () => {
    const dt = fakeDt()
    serializeWorkbenchCardDrag(dt, [item])
    expect(dt.getData('text/plain')).toContain('一只猫跳上桌子')
  })

  it('空列表不写任何 MIME', () => {
    const dt = fakeDt()
    serializeWorkbenchCardDrag(dt, [])
    expect(dt.types).toEqual([])
  })

  it('非本词表的拖拽解出空数组', () => {
    expect(parseWorkbenchCardDrop(fakeDt())).toEqual([])
  })

  it('载荷损坏时解出空数组而不是抛错', () => {
    const dt = fakeDt()
    dt.setData('application/x-catimation-workbench-cards', '{ 不是 JSON')
    expect(parseWorkbenchCardDrop(dt)).toEqual([])
  })
})

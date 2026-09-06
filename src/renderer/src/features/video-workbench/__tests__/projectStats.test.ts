// 剧 / 分段统计的纯函数:分桶、时长、完成率、封面选择、时长格式。
// 这是剧栏、总览、MCP status 的唯一口径来源,所以在这里钉死。
import { describe, expect, it } from 'vitest'
import type { VideoWorkbenchBoard, VideoWorkbenchCard } from '../../../../types/videoWorkbench'
import { buildCard } from '../cardSpec'
import { formatDuration, pickCover, summarizeBoard, summarizeProject } from '../projectStats'

function card(boardId: string, patch: Partial<VideoWorkbenchCard>): VideoWorkbenchCard {
  return { ...buildCard({ prompt: 'p' }, 0, boardId), ...patch }
}
const board = (id: string, projectId: string, order: number): VideoWorkbenchBoard => ({
  id,
  projectId,
  name: id,
  order,
  createdAt: 1,
})

describe('summarizeBoard', () => {
  it('按状态分桶,时长只算已完成', () => {
    const s = summarizeBoard([
      card('b', { status: 'succeeded', duration: 10 }),
      card('b', { status: 'succeeded', duration: 5 }),
      card('b', { status: 'running', duration: 15 }),
      card('b', { status: 'failed', duration: 15 }),
      card('b', { status: 'draft', duration: 15 }),
    ])
    expect(s.total).toBe(5)
    expect(s.done).toBe(2)
    expect(s.active).toBe(1)
    expect(s.failed).toBe(1)
    expect(s.pending).toBe(1)
    expect(s.doneSeconds).toBe(15)
  })

  it('空分段全为零,lastActivityAt 为 null', () => {
    expect(summarizeBoard([])).toMatchObject({
      total: 0,
      done: 0,
      active: 0,
      failed: 0,
      pending: 0,
      doneSeconds: 0,
      lastActivityAt: null,
    })
  })

  it('lastActivityAt 取最大的 updatedAt', () => {
    const s = summarizeBoard([card('b', { updatedAt: 5 }), card('b', { updatedAt: 9 }), card('b', { updatedAt: 7 })])
    expect(s.lastActivityAt).toBe(9)
  })
})

describe('summarizeProject', () => {
  it('只累加属于该剧分段的卡,segments 按 order 排', () => {
    const boards = [board('b2', 'p1', 1), board('b1', 'p1', 0), board('x', 'p2', 0)]
    const cards = [
      card('b1', { status: 'succeeded', duration: 5 }),
      card('b2', { status: 'failed' }),
      card('x', { status: 'succeeded', duration: 99 }),
    ]
    const s = summarizeProject('p1', boards, cards)
    expect(s.segments.map((x) => x.board.id)).toEqual(['b1', 'b2'])
    expect(s.totals.total).toBe(2)
    expect(s.totals.done).toBe(1)
    expect(s.totals.failed).toBe(1)
    expect(s.totals.doneSeconds).toBe(5)
    expect(s.donePercent).toBe(50)
  })

  it('没有卡时完成率为 0 而不是 NaN', () => {
    expect(summarizeProject('p1', [board('b1', 'p1', 0)], []).donePercent).toBe(0)
  })
})

describe('pickCover', () => {
  it('优先最近完成卡的第一张参考图,其次任意卡的第一张参考图,否则 null', () => {
    const older = card('b', { status: 'succeeded', updatedAt: 1, referenceImages: [{ name: 'a', src: 'ref-old' }] })
    const newer = card('b', { status: 'succeeded', updatedAt: 2, referenceImages: [{ name: 'b', src: 'ref-new' }] })
    const draft = card('b', { status: 'draft', updatedAt: 9, referenceImages: [{ name: 'c', src: 'ref-draft' }] })
    expect(pickCover([older, draft, newer])).toBe('ref-new')
    expect(pickCover([draft])).toBe('ref-draft')
    expect(pickCover([card('b', {})])).toBeNull()
  })

  it('asset:// 素材用 previewUrl 展示', () => {
    const c = card('b', { referenceImages: [{ name: 'a', src: 'asset://1', previewUrl: 'https://cdn/x.jpg' }] })
    expect(pickCover([c])).toBe('https://cdn/x.jpg')
  })
})

describe('formatDuration', () => {
  it('m:ss', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(65)).toBe('1:05')
    expect(formatDuration(402)).toBe('6:42')
  })
})

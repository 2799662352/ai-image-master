// 剧 / 分段 的统计与封面 —— 纯函数,剧栏、总览、MCP status 都从这里取数,
// 保证口径唯一。花费复用 pricing.summarizeCostUsd(事后口径,非账单)。

import type { VideoWorkbenchBoard, VideoWorkbenchCard } from '../../../../types/videoWorkbench'
import { isActiveStatus } from './cardSpec'
import { summarizeCostUsd, type WorkbenchCostSummary } from './pricing'
import { cardHasVideoInput } from './store'

export interface SegmentStats {
  total: number
  done: number
  active: number
  failed: number
  pending: number
  /** 已完成卡片的规格时长之和(秒)。 */
  doneSeconds: number
  cost: WorkbenchCostSummary
  /** 卡片最近一次 updatedAt;没有卡时为 null。 */
  lastActivityAt: number | null
}

export interface SegmentWithStats {
  board: VideoWorkbenchBoard
  stats: SegmentStats
  cover: string | null
}

export interface ProjectStats {
  segments: SegmentWithStats[]
  totals: SegmentStats
  /** 0–100 的整数;没有卡时为 0。 */
  donePercent: number
  cover: string | null
}

export function summarizeBoard(cards: readonly VideoWorkbenchCard[]): SegmentStats {
  let done = 0
  let active = 0
  let failed = 0
  let pending = 0
  let doneSeconds = 0
  let lastActivityAt: number | null = null
  for (const c of cards) {
    if (c.status === 'succeeded') {
      done += 1
      doneSeconds += c.duration ?? 0
    } else if (isActiveStatus(c.status)) active += 1
    else if (c.status === 'failed') failed += 1
    else pending += 1
    if (lastActivityAt === null || c.updatedAt > lastActivityAt) lastActivityAt = c.updatedAt
  }
  return {
    total: cards.length,
    done,
    active,
    failed,
    pending,
    doneSeconds,
    cost: summarizeCostUsd(cards, cardHasVideoInput),
    lastActivityAt,
  }
}

function firstReferenceImage(card: VideoWorkbenchCard): string | null {
  const ref = card.referenceImages[0]
  return ref ? ref.previewUrl ?? ref.src : null
}

/**
 * 封面:最近完成的那张卡的第一张参考图,其次任意卡的第一张参考图。
 * 卡片没有成片海报字段,也刻意不做视频抽帧 —— 参考图就是这一镜的视觉锚点。
 */
export function pickCover(cards: readonly VideoWorkbenchCard[]): string | null {
  let best: VideoWorkbenchCard | null = null
  for (const c of cards) {
    if (c.status === 'succeeded' && firstReferenceImage(c) && (!best || c.updatedAt > best.updatedAt)) best = c
  }
  if (best) return firstReferenceImage(best)
  for (const c of cards) {
    const src = firstReferenceImage(c)
    if (src) return src
  }
  return null
}

export function summarizeProject(
  projectId: string,
  boards: readonly VideoWorkbenchBoard[],
  cards: readonly VideoWorkbenchCard[],
): ProjectStats {
  const own = boards.filter((b) => b.projectId === projectId).sort((a, b) => a.order - b.order)
  const segments = own.map((board) => {
    const bc = cards.filter((c) => c.boardId === board.id).sort((a, b) => a.order - b.order)
    return { board, stats: summarizeBoard(bc), cover: pickCover(bc) }
  })
  const ownBoardIds = new Set(own.map((b) => b.id))
  const ownCards = cards.filter((c) => c.boardId && ownBoardIds.has(c.boardId))
  const totals = summarizeBoard(ownCards)
  return {
    segments,
    totals,
    donePercent: totals.total === 0 ? 0 : Math.round((totals.done / totals.total) * 100),
    cover: pickCover(ownCards),
  }
}

/** 秒 → `m:ss`。 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

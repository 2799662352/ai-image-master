// 剧总览网格里的一张分段卡:封面 · 序号 · 时长 · 状态角标 · 名 · 镜/花费 · 三色条。
// 整张卡是一个按钮(点进分段页);可拖(拖到剧栏 = 移到别的剧,Task 7 接投放端)。

import type { DragEvent } from 'react'
import type { VideoWorkbenchBoard } from '../../../../types/videoWorkbench'
import { formatCostParts } from '../../features/video-workbench/pricing'
import { formatDuration, type SegmentStats } from '../../features/video-workbench/projectStats'
import { CoverImage } from './CoverImage'

export interface SegmentCardProps {
  board: VideoWorkbenchBoard
  stats: SegmentStats
  cover: string | null
  index: number
  onOpen: () => void
  onDragStart?: (e: DragEvent<HTMLButtonElement>) => void
}

export function SegmentCard({ board, stats, cover, index, onOpen, onDragStart }: SegmentCardProps) {
  const cost = formatCostParts(stats.cost.usd, stats.cost.cny)
  return (
    <button
      type="button"
      className="vw-seg"
      aria-label={`打开分段 ${board.name}`}
      onClick={onOpen}
      draggable={Boolean(onDragStart)}
      onDragStart={onDragStart}
    >
      <div className="vw-seg-cover">
        <CoverImage src={cover} fallback={<span className="vw-seg-play" aria-hidden="true">▷</span>} />
        <span className="vw-seg-badge vw-seg-badge-tl">{String(index + 1).padStart(2, '0')}</span>
        {stats.doneSeconds > 0 && (
          <span className="vw-seg-badge vw-seg-badge-br">{formatDuration(stats.doneSeconds)}</span>
        )}
        {stats.active > 0 && (
          <span className="vw-seg-badge vw-seg-badge-bl vw-dot vw-dot-yellow">{stats.active} 镜生成中</span>
        )}
        {stats.active === 0 && stats.failed > 0 && (
          <span className="vw-seg-badge vw-seg-badge-bl vw-dot vw-dot-red">{stats.failed} 镜失败</span>
        )}
      </div>
      <div className="vw-seg-body">
        <div className="vw-seg-name">{board.name}</div>
        <div className="vw-seg-sub">
          <span>{stats.total} 镜{cost ? ` · ${cost}` : ''}</span>
          {/* 显式的入口字样:整张卡可点,但没有这两个字用户看不出来它是门。 */}
          <span className="vw-seg-open" aria-hidden="true">打开 ›</span>
        </div>
        <div className="vw-strip" style={{ height: 3, marginTop: 8 }} aria-hidden="true">
          {stats.done > 0 && <div style={{ flex: stats.done, background: '#22c55e' }} />}
          {stats.active > 0 && <div style={{ flex: stats.active, background: '#FCE300' }} />}
          {stats.failed > 0 && <div style={{ flex: stats.failed, background: '#f87171' }} />}
          {stats.total === 0 && <div style={{ flex: 1, background: '#27272a' }} />}
        </div>
      </div>
    </button>
  )
}

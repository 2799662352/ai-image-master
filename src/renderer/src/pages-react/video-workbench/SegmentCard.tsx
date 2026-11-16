// 剧总览网格里的一张分段卡:封面 · 序号 · 时长 · 状态角标 · 名 · 镜/花费 · 三色条。
// 整张卡是一个按钮(点进分段页);可拖(拖到剧栏 = 移到别的剧;拖到别的卡上 = 调整顺序,投放端在 ProjectOverview)。
// 右键(或右上角悬停出现的「⋯」)弹出分段菜单:重命名 / 置顶 / Fork / 删除。
// 卡本体是 <button>,「⋯」不能嵌在里面(按钮里嵌按钮不合规范),所以与它并列、包在一个定位容器里。

import type { DragEvent, MouseEvent } from 'react'
import type { VideoWorkbenchBoard } from '../../../../types/videoWorkbench'
import { formatCostParts } from '../../features/video-workbench/pricing'
import { formatDuration, type SegmentStats } from '../../features/video-workbench/projectStats'
import { CoverImage } from './CoverImage'

export interface SegmentCardProps {
  board: VideoWorkbenchBoard
  stats: SegmentStats
  cover: string | null
  index: number
  pinned?: boolean
  onOpen: () => void
  onDragStart?: (e: DragEvent<HTMLButtonElement>) => void
  onDragEnd?: (e: DragEvent<HTMLButtonElement>) => void
  /** 别的分段卡正拖在这张卡上空 / 在这里放下(调整顺序;不传 = 不接收)。挂在外层容器上,卡内任何位置都算。 */
  onDragOver?: (e: DragEvent<HTMLDivElement>) => void
  onDrop?: (e: DragEvent<HTMLDivElement>) => void
  /** 这张卡正被拖着(变暗)。 */
  dragging?: boolean
  /** 插入线画在这张卡的左 / 右侧(2px 黄线,画在列间距里,不占布局)。 */
  dropMark?: 'before' | 'after' | null
  /** 右键卡片 / 点「⋯」:交给页面打开菜单(不传 = 没有菜单,卡片行为与以前完全一致)。 */
  onMenu?: (e: MouseEvent) => void
}

export function SegmentCard({
  board,
  stats,
  cover,
  index,
  pinned,
  onOpen,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  dragging,
  dropMark,
  onMenu,
}: SegmentCardProps) {
  const cost = formatCostParts(stats.cost.usd, stats.cost.cny)
  return (
    <div
      className={[
        'vw-seg-wrap',
        dragging && 'vw-seg-dragging',
        dropMark === 'before' && 'vw-seg-drop-before',
        dropMark === 'after' && 'vw-seg-drop-after',
      ]
        .filter(Boolean)
        .join(' ')}
      onContextMenu={onMenu}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <button
        type="button"
        className="vw-seg"
        aria-label={`打开分段 ${board.name}`}
        onClick={onOpen}
        draggable={Boolean(onDragStart)}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
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
      {pinned && (
        <span className="vw-pin vw-seg-pin" title="已置顶">
          PIN
        </span>
      )}
      {onMenu && (
        <button
          type="button"
          className="vw-seg-more"
          aria-label={`分段菜单 ${board.name}`}
          title="更多操作(也可以右键)"
          aria-haspopup="menu"
          onClick={onMenu}
        >
          ⋯
        </button>
      )}
    </div>
  )
}

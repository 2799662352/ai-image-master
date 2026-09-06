// 剧总览:面包屑 · 剧名(就地改名)· 汇总芯片 · 操作 · 分段网格。进入一部剧默认到这里。
// 数字全部来自 projectStats(与剧栏、MCP status 同一口径)。

import { useEffect, useRef, useState } from 'react'
import { formatCostParts } from '../../features/video-workbench/pricing'
import { formatDuration, summarizeProject } from '../../features/video-workbench/projectStats'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'
import { MigrationNotice } from './MigrationNotice'
import { SegmentCard } from './SegmentCard'

/** 分段卡拖拽的 dataTransfer 类型;剧栏按它认「这是一个分段」。 */
export const SEGMENT_DRAG_MIME = 'application/x-catimation-segment'

export function ProjectOverview() {
  const project = useVideoWorkbenchStore((s) => s.projects.find((p) => p.id === s.activeProjectId))
  const boards = useVideoWorkbenchStore((s) => s.boards)
  const cards = useVideoWorkbenchStore((s) => s.cards)
  const activeBoardId = useVideoWorkbenchStore((s) => s.activeBoardId)
  const openBoard = useVideoWorkbenchStore((s) => s.openBoard)
  const addBoard = useVideoWorkbenchStore((s) => s.addBoard)
  const renameProject = useVideoWorkbenchStore((s) => s.renameProject)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  if (!project) return null
  const stats = summarizeProject(project.id, boards, cards)
  const t = stats.totals
  const cost = formatCostParts(t.cost.usd, t.cost.cny)
  // 「进入分段」回到工作台:优先上次停留的那一段(openOverview 不动 activeBoardId),
  // 否则第一段。总览不能是死胡同 —— 只靠分段卡这一个入口,用户会以为回不去了。
  const resumeBoard =
    stats.segments.find(({ board }) => board.id === activeBoardId)?.board ?? stats.segments[0]?.board

  const beginRename = () => {
    setDraft(project.name)
    setEditing(true)
  }
  const commit = () => {
    renameProject(project.id, draft)
    setEditing(false)
  }

  return (
    <section className="space-y-4" aria-label="剧总览">
      <MigrationNotice project={project} segmentCount={stats.segments.length} onRename={beginRename} />
      <div className="text-[11px] text-[#71717a]">
        剧 › <span className="text-[#e4e4e7]">{project.name}</span> › <span className="text-[#e4e4e7]">总览</span>
      </div>
      <div className="flex items-start justify-between gap-4 border-b border-[#3F3F46] pb-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {editing ? (
              <input
                ref={inputRef}
                aria-label="剧名"
                className="vw-title-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit()
                  if (e.key === 'Escape') setEditing(false)
                }}
              />
            ) : (
              <h2 className="font-orb text-2xl font-bold text-white leading-none">{project.name}</h2>
            )}
            {project.legacy && <span className="vw-chip">旧数据</span>}
            <button type="button" className="vw-rail-iconbtn" aria-label="重命名剧" title="重命名" onClick={beginRename}>
              ✎
            </button>
          </div>
          {project.summary && (
            <p className="vw-project-summary" title="Agent 写的一行说明">{project.summary}</p>
          )}
          <div className="flex items-center gap-1.5 mt-3 flex-wrap" role="group" aria-label="剧汇总">
            <span className="vw-chip">{stats.segments.length} 段</span>
            <span className="vw-chip">总时长 {formatDuration(t.doneSeconds)}</span>
            <span className="vw-chip">{t.total} 镜</span>
            <span className="vw-chip vw-chip-ok">已完成 {stats.donePercent}%</span>
            {t.active > 0 && <span className="vw-chip vw-chip-warn">{t.active} 镜生成中</span>}
            {t.failed > 0 && <span className="vw-chip vw-chip-bad">{t.failed} 镜失败</span>}
            {cost && <span className="vw-chip">已花费 {cost}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-none pt-1">
          {resumeBoard && (
            <button
              type="button"
              className="vw-ghost"
              aria-label={`进入分段 ${resumeBoard.name}`}
              title="回到工作台,继续编辑这一段的镜头"
              onClick={() => openBoard(resumeBoard.id)}
            >
              进入「{resumeBoard.name}」 ›
            </button>
          )}
          <button type="button" className="vw-primary" aria-label="新建分段" onClick={() => addBoard()}>
            + 新建分段
          </button>
        </div>
      </div>
      <div className="text-[11px] text-[#71717a]">
        点分段卡进入编辑镜头;拖分段卡到左侧剧栏可移到别的剧;换剧点左侧剧栏。
      </div>
      <div className="vw-seg-grid">
        {stats.segments.map(({ board, stats: s, cover }, i) => (
          <SegmentCard
            key={board.id}
            board={board}
            stats={s}
            cover={cover}
            index={i}
            onOpen={() => openBoard(board.id)}
            onDragStart={(e) => {
              e.dataTransfer.setData(SEGMENT_DRAG_MIME, board.id)
              e.dataTransfer.effectAllowed = 'move'
            }}
          />
        ))}
        <button
          type="button"
          className="vw-seg vw-seg-new"
          onClick={() => addBoard()}
          aria-label="新建分段(网格)"
        >
          <span className="text-3xl">+</span>
          <span className="text-[12px] mt-2">新建分段</span>
          <span className="text-[10px] text-[#52525b] mt-1">或从其它剧「移动到…」</span>
        </button>
      </div>
    </section>
  )
}

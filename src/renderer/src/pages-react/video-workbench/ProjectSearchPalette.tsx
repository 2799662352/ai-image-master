// Ctrl+P:同时搜剧名与分段名,↑↓ 选、Enter 打开、Esc 关。
// 命中剧 → 切到该剧(落在它记住的视图);命中分段 → 直接打开那一段(连剧一起切)。

import { useEffect, useMemo, useRef, useState } from 'react'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'

interface Hit {
  kind: 'project' | 'board'
  id: string
  label: string
  sub: string
}

/** 没输入时的候选上限:全量列表没意义,只给最前面几条当"最近可去"的提示。 */
const IDLE_LIMIT = 12

export interface ProjectSearchPaletteProps {
  open: boolean
  onClose: () => void
}

export function ProjectSearchPalette({ open, onClose }: ProjectSearchPaletteProps) {
  const projects = useVideoWorkbenchStore((s) => s.projects)
  const boards = useVideoWorkbenchStore((s) => s.boards)
  const switchProject = useVideoWorkbenchStore((s) => s.switchProject)
  const openBoard = useVideoWorkbenchStore((s) => s.openBoard)
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (open) {
      setQ('')
      setIdx(0)
      inputRef.current?.focus()
    }
  }, [open])

  const hits = useMemo<Hit[]>(() => {
    const needle = q.trim().toLowerCase()
    const nameOf = new Map(projects.map((p) => [p.id, p.name]))
    const ps: Hit[] = projects
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((p) => ({ kind: 'project', id: p.id, label: p.name, sub: '剧' }))
    const bs: Hit[] = boards
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((b) => ({ kind: 'board', id: b.id, label: b.name, sub: nameOf.get(b.projectId) ?? '' }))
    const all = [...ps, ...bs]
    if (!needle) return all.slice(0, IDLE_LIMIT)
    return all.filter((h) => h.label.toLowerCase().includes(needle) || h.sub.toLowerCase().includes(needle))
  }, [q, projects, boards])

  if (!open) return null

  const choose = (h: Hit) => {
    if (h.kind === 'project') switchProject(h.id)
    else openBoard(h.id)
    onClose()
  }

  return (
    <div className="vw-palette-backdrop" onMouseDown={onClose}>
      <div
        className="vw-palette"
        role="dialog"
        aria-label="搜索剧与分段"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls="vw-palette-list"
          aria-autocomplete="list"
          className="vw-palette-input"
          placeholder="搜索剧 / 分段…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setIdx(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIdx((i) => Math.min(i + 1, Math.max(0, hits.length - 1)))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIdx((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              const hit = hits[idx]
              if (hit) choose(hit)
            } else if (e.key === 'Escape') {
              onClose()
            }
          }}
        />
        <ul id="vw-palette-list" role="listbox" className="vw-palette-list">
          {hits.map((h, i) => (
            <li
              key={`${h.kind}:${h.id}`}
              role="option"
              aria-selected={i === idx}
              className={`vw-palette-item ${i === idx ? 'vw-palette-item-active' : ''}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => choose(h)}
            >
              <span className="truncate">{h.label}</span>
              <span className="vw-palette-sub">{h.sub}</span>
            </li>
          ))}
          {hits.length === 0 && <li className="vw-palette-empty">没有匹配的剧或分段</li>}
        </ul>
      </div>
    </div>
  )
}

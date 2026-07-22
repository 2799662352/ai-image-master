// 「生成视频」工作台多「页」页签条:切换 / 新建(+) / 双击行内重命名(Enter
// 确认、Esc 取消)/ 两步确认删除(避开 window.confirm,jsdom 与桌面端一致)。
// 视觉遵循 DESIGN.md 赛博朋克 token:激活页 #FCE300 描边,未激活 #3F3F46。

import { useEffect, useRef, useState } from 'react'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'

export function BoardTabs() {
  const boards = useVideoWorkbenchStore((s) => s.boards)
  const activeBoardId = useVideoWorkbenchStore((s) => s.activeBoardId)
  const addBoard = useVideoWorkbenchStore((s) => s.addBoard)
  const switchBoard = useVideoWorkbenchStore((s) => s.switchBoard)
  const renameBoard = useVideoWorkbenchStore((s) => s.renameBoard)
  const removeBoard = useVideoWorkbenchStore((s) => s.removeBoard)

  /** 行内编辑中的页 id(同一时刻最多一个)。 */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  /** 两步删除确认中的页 id;3.5s 无操作自动复位。 */
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    }
  }, [])

  const armConfirm = (id: string) => {
    setConfirmingId(id)
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    confirmTimer.current = setTimeout(() => setConfirmingId(null), 3500)
  }

  const beginRename = (id: string, name: string) => {
    setEditingId(id)
    setDraftName(name)
  }

  const commitRename = () => {
    if (editingId) renameBoard(editingId, draftName)
    setEditingId(null)
  }

  return (
    <div role="tablist" aria-label="工作台页" className="flex items-center gap-1 flex-wrap">
      {boards.map((board) => {
        const active = board.id === activeBoardId
        const editing = editingId === board.id
        const confirming = confirmingId === board.id
        return (
          <div
            key={board.id}
            className={[
              'group flex items-center gap-1 border px-2 py-1.5 transition-colors',
              active
                ? 'border-[#FCE300] bg-[#FCE300]/10 text-[#FCE300]'
                : 'border-[#3F3F46] text-white/60 hover:border-[#FCE300]/60 hover:text-white',
            ].join(' ')}
          >
            {editing ? (
              <input
                autoFocus
                value={draftName}
                aria-label={`重命名「${board.name}」`}
                className="bg-transparent text-xs w-24 outline-none border-b border-[#FCE300] text-[#FCE300]"
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') setEditingId(null)
                }}
                onBlur={commitRename}
              />
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={active}
                title="双击重命名"
                className="text-xs max-w-[10rem] truncate"
                onClick={() => switchBoard(board.id)}
                onDoubleClick={() => beginRename(board.id, board.name)}
              >
                {board.name}
              </button>
            )}
            {/* 至少保留一页:仅剩一页时不出删除入口 */}
            {boards.length > 1 && !editing && (
              confirming ? (
                <button
                  type="button"
                  aria-label={`确认删除「${board.name}」`}
                  title="再点一次确认删除本页及其全部卡片"
                  className="text-[10px] px-1 border border-red-500 bg-red-500/20 text-red-400"
                  onClick={() => {
                    setConfirmingId(null)
                    removeBoard(board.id)
                  }}
                >
                  确认删除
                </button>
              ) : (
                <button
                  type="button"
                  aria-label={`删除页「${board.name}」`}
                  title="删除本页(需二次确认)"
                  className="text-white/30 hover:text-red-400 text-xs px-0.5"
                  onClick={() => armConfirm(board.id)}
                >
                  ✕
                </button>
              )
            )}
          </div>
        )
      })}
      <button
        type="button"
        aria-label="新建页"
        title="新建一个独立的工作页"
        className="text-xs border border-dashed border-[#3F3F46] text-white/50 hover:border-[#FCE300] hover:text-[#FCE300] px-2.5 py-1.5 transition-colors"
        onClick={() => addBoard()}
      >
        ＋
      </button>
    </div>
  )
}

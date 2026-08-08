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
  const setBoardSummary = useVideoWorkbenchStore((s) => s.setBoardSummary)

  /**
   * 行内编辑中的页(同一时刻最多一个)。带 field 是因为页名和摘要共用同一套
   * 「双击进入 / Enter 确认 / Esc 取消 / 失焦提交」的编辑机制 —— 分成两套状态
   * 会出现两个输入框同时开着的中间态。
   */
  const [editing, setEditing] = useState<{ id: string; field: 'name' | 'summary' } | null>(null)
  const [draft, setDraft] = useState('')
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

  const beginEdit = (id: string, field: 'name' | 'summary', value: string) => {
    setEditing({ id, field })
    setDraft(value)
  }

  const commitEdit = () => {
    if (editing) {
      // 摘要允许提交空串(= 清除);页名不允许,renameBoard 自己会挡。
      if (editing.field === 'name') renameBoard(editing.id, draft)
      else setBoardSummary(editing.id, draft)
    }
    setEditing(null)
  }

  return (
    <div role="tablist" aria-label="工作台页" className="flex items-center gap-1 flex-wrap">
      {boards.map((board) => {
        const active = board.id === activeBoardId
        const editingName = editing?.id === board.id && editing.field === 'name'
        const editingSummary = editing?.id === board.id && editing.field === 'summary'
        const busy = editingName || editingSummary
        const confirming = confirmingId === board.id
        const summary = board.summary?.trim() ?? ''
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
            {editingName ? (
              <input
                autoFocus
                value={draft}
                aria-label={`重命名「${board.name}」`}
                className="bg-transparent text-xs w-24 outline-none border-b border-[#FCE300] text-[#FCE300]"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEdit()
                  if (e.key === 'Escape') setEditing(null)
                }}
                onBlur={commitEdit}
              />
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={active}
                // 摘要进 title 而不是只靠行内那段:行内是截断的,完整内容得有地方看。
                // 按钮已有可见文本作为无障碍名,title 在这里落成「描述」,语义正好。
                title={summary ? `${summary}\n\n双击页名改名，双击摘要改摘要` : '双击重命名'}
                className="text-xs max-w-[10rem] truncate"
                onClick={() => switchBoard(board.id)}
                onDoubleClick={() => beginEdit(board.id, 'name', board.name)}
              >
                {board.name}
              </button>
            )}
            {/*
              摘要行内显示,而不是塞进第二行 —— 页签栏会 flex-wrap,加一行等于把整条
              栏抬高一倍,哪怕大多数页根本没写摘要。这里横向截断得比页名更狠(7rem):
              它是扫读用的提示,不是拿来读全文的,全文在 title 里。
              没写摘要的页不占任何位置,不留空占位符。
            */}
            {editingSummary ? (
              <input
                autoFocus
                value={draft}
                placeholder="这一页装的是什么"
                aria-label={`「${board.name}」的摘要`}
                className="bg-transparent text-[11px] w-32 outline-none border-b border-[#FCE300]/60 text-white/80 placeholder:text-white/25"
                maxLength={200}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEdit()
                  if (e.key === 'Escape') setEditing(null)
                }}
                onBlur={commitEdit}
              />
            ) : summary ? (
              <span
                // 不是 button:点它要走的是「切到这一页」,和点页名一样,不该是第二个
                // tab stop。双击才是它自己的动作。
                className="text-[11px] max-w-[7rem] truncate text-white/40 cursor-text"
                title={`${summary}\n\n双击编辑摘要（清空即删除）`}
                onClick={() => switchBoard(board.id)}
                onDoubleClick={() => beginEdit(board.id, 'summary', summary)}
              >
                {summary}
              </span>
            ) : (
              // 没摘要时只在悬停/激活时露出一个极淡的入口 —— 否则用户永远发现不了
              // 这里可以写东西(agent 写的摘要他也就无从修改)。
              <button
                type="button"
                aria-label={`给「${board.name}」写摘要`}
                title="写一句话说明这页装的是什么"
                className={[
                  'text-[11px] px-0.5 text-white/25 hover:text-[#FCE300] transition-opacity',
                  active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                ].join(' ')}
                onClick={() => beginEdit(board.id, 'summary', '')}
              >
                ＋摘要
              </button>
            )}
            {/* 至少保留一页:仅剩一页时不出删除入口 */}
            {boards.length > 1 && !busy && (
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

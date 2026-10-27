// 一个小的「重命名」对话框 —— 总览分段卡是整张 <button>,里面不能再放 <input>
// (按钮里嵌输入框:点输入框会触发整张卡的 onClick,也不合 HTML 规范),
// 所以右键「重命名」在这里弹出,而不是就地编辑。剧栏行和分段页签各自已有就地编辑,不用它。

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export function RenameDialog({
  open,
  title,
  initial,
  onCommit,
  onClose,
}: {
  open: boolean
  title: string
  initial: string
  /** 返回 false = 被拒(例如空名),对话框保持打开。 */
  onCommit: (name: string) => boolean | void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(initial)
  const ref = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    setDraft(initial)
    // 等 portal 挂上再聚焦并全选,方便直接键入新名字
    const t = setTimeout(() => {
      ref.current?.focus()
      ref.current?.select()
    }, 0)
    return () => clearTimeout(t)
  }, [open, initial])

  if (!open) return null
  const empty = draft.trim() === ''
  const submit = () => {
    if (empty) return
    if (onCommit(draft) === false) return
    onClose()
  }

  return createPortal(
    <div className="vw-palette-backdrop" onMouseDown={onClose}>
      <div className="vw-palette vw-dialog vw-dialog-sm" role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="vw-dialog-title">{title}</div>
        <div className="vw-dialog-body">
          <input
            ref={ref}
            aria-label="新名称"
            className="vw-dialog-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') onClose()
            }}
          />
        </div>
        <div className="vw-dialog-actions">
          <button type="button" className="vw-ghost" onClick={onClose}>取消</button>
          <button type="button" className="vw-primary" disabled={empty} onClick={submit}>确定</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

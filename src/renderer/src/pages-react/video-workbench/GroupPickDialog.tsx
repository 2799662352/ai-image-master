// 「移到分组…」对话框:列出已有分组(点一下就移过去),或者键入一个新名字建组并移入。
// 右键菜单没有二级菜单,所以走一个小对话框,和 RenameDialog 同一套外观。

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Folder } from 'lucide-react'
import { normalizeGroupName } from '../../features/video-workbench/projectGroups'

export function GroupPickDialog({
  open,
  projectName,
  groups,
  current,
  onPick,
  onClose,
}: {
  open: boolean
  projectName: string
  /** 可选的分组名(有成员的 + 本机暂存的空分组)。 */
  groups: readonly string[]
  /** 这部剧现在所在的分组(没有 = 未分组);它在列表里标出来、不可再选。 */
  current?: string
  /** 返回 false = 被拒,对话框保持打开。 */
  onPick: (group: string) => boolean | void
  onClose: () => void
}) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    setDraft('')
    // 有现成分组时先让用户看列表;没有就直接聚焦输入框
    if (groups.length > 0) return
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(t)
    // 只在每次打开时重置草稿;groups 在对话框开着时不变
  }, [open])

  if (!open) return null
  const name = normalizeGroupName(draft)
  const pick = (g: string) => {
    if (onPick(g) === false) return
    onClose()
  }

  return createPortal(
    <div className="vw-palette-backdrop" onMouseDown={onClose}>
      <div
        className="vw-palette vw-dialog vw-dialog-sm"
        role="dialog"
        aria-label={`把「${projectName}」移到分组`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="vw-dialog-title">移到分组</div>
        <div className="vw-dialog-body">
          {groups.length > 0 && (
            <ul className="vw-grouppick-list" aria-label="已有分组">
              {groups.map((g) => (
                <li key={g}>
                  <button
                    type="button"
                    className="vw-grouppick-item"
                    aria-label={`移到分组 ${g}`}
                    disabled={g === current}
                    onClick={() => pick(g)}
                  >
                    <Folder size={13} aria-hidden="true" />
                    <span className="truncate">{g}</span>
                    {g === current && <span className="vw-grouppick-cur">当前</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input
            ref={inputRef}
            aria-label="新分组名"
            className="vw-dialog-input"
            placeholder="或者新建一个分组…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name && name !== current) pick(name)
              if (e.key === 'Escape') onClose()
            }}
          />
        </div>
        <div className="vw-dialog-actions">
          <button type="button" className="vw-ghost" onClick={onClose}>取消</button>
          <button
            type="button"
            className="vw-primary"
            disabled={!name || name === current}
            onClick={() => name && pick(name)}
          >
            新建并移入
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// 工作台撤销/重做入口:工具条两个按钮 + Ctrl/⌘+Z、Ctrl/⌘+Shift+Z(兼容 Ctrl+Y)。
//
// 撤销的粒度是「一次编排改动」,agent 的整板 applyIR 也算一步 —— 这就是它存在的
// 主要理由:让 AI 一次性重构看板变成一个可以后悔的操作。

import { useCallback, useEffect } from 'react'
import { useToastStore } from '../../stores/useToastStore'
import type { WorkbenchRestoreResult } from '../../features/video-workbench/workbenchHistory'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'

/**
 * 焦点在可编辑元素里时把 Ctrl+Z 让给浏览器 —— 用户在提示词框里按撤销,期待的是
 * 撤销刚打的那几个字,而不是回滚整个看板。
 */
function isTextEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function UndoRedoButtons() {
  const canUndo = useVideoWorkbenchStore((s) => s.undoStack.length > 0)
  const canRedo = useVideoWorkbenchStore((s) => s.redoStack.length > 0)
  const undo = useVideoWorkbenchStore((s) => s.undo)
  const redo = useVideoWorkbenchStore((s) => s.redo)
  const addToast = useToastStore((s) => s.addToast)

  const report = useCallback(
    (label: string, result: WorkbenchRestoreResult) => {
      if (!result.ok) {
        addToast({ type: 'info', message: `${label}:${result.skipped[0]?.reason ?? '没有可用的步骤'}` })
        return
      }
      // 在飞的卡不删、渲染中的卡规格定格 —— 这些是刻意的拒绝,不说用户会以为撤销没生效。
      if (result.skipped.length > 0) {
        addToast({
          type: 'warning',
          message: `${label}完成,但 ${result.skipped.length} 张卡未能回滚:${result.skipped[0].reason}`,
          duration: 5000,
        })
      }
    },
    [addToast],
  )

  const runUndo = useCallback(async () => {
    report('撤销', await undo())
  }, [report, undo])

  const runRedo = useCallback(async () => {
    report('重做', await redo())
  }, [report, redo])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const key = e.key.toLowerCase()
      const wantRedo = (key === 'z' && e.shiftKey) || key === 'y'
      if (key !== 'z' && key !== 'y') return
      if (isTextEditing(e.target)) return
      e.preventDefault()
      void (wantRedo ? runRedo() : runUndo())
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [runRedo, runUndo])

  const base
    = 'text-xs px-2.5 py-2 border transition-colors disabled:opacity-30 disabled:cursor-not-allowed'
  const enabled = 'border-[#3F3F46] text-white/70 hover:border-[#FCE300] hover:text-[#FCE300]'

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label="撤销"
        title="撤销上一步编排改动(Ctrl+Z)—— 包括 AI 的整板重构"
        className={`${base} ${enabled}`}
        disabled={!canUndo}
        onClick={() => void runUndo()}
      >
        ↶
      </button>
      <button
        type="button"
        aria-label="重做"
        title="重做被撤销的一步(Ctrl+Shift+Z)"
        className={`${base} ${enabled}`}
        disabled={!canRedo}
        onClick={() => void runRedo()}
      >
        ↷
      </button>
    </div>
  )
}

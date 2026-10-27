// 剧 / 分段右键菜单的条目构建 + 带 toast 的动作封装。
// 三个入口(剧栏行、总览分段卡、分段页签)共用,保证文案和规则只有一份。
// 状态在「右键那一刻」读取,所以菜单里的置顶/取消置顶、可否删除永远是最新的。

import { useVideoWorkbenchStore } from '../../features/video-workbench/store'
import { useToastStore } from '../../stores/useToastStore'
import type { ContextMenuItem } from './ContextMenu'

const store = () => useVideoWorkbenchStore.getState()
const toast = (message: string, type: 'success' | 'error' | 'info' = 'info') =>
  useToastStore.getState().addToast({ message, type, duration: type === 'error' ? 4500 : 3500 })

/** 删剧:移入回收站(可恢复)。被拒时把原因讲给用户。 */
export function trashProjectWithToast(id: string): boolean {
  const name = store().projects.find((p) => p.id === id)?.name ?? ''
  const r = store().trashProject(id)
  if (!r.ok) {
    toast(r.reason ?? '无法删除这部剧', 'error')
    return false
  }
  toast(`已将剧「${name}」移入回收站,可在回收站恢复或彻底删除(也可 Ctrl+Z 撤销)`, 'success')
  return true
}

/** 删分段:移入回收站(可恢复)。 */
export function trashBoardWithToast(id: string): boolean {
  const name = store().boards.find((b) => b.id === id)?.name ?? ''
  const r = store().trashBoard(id)
  if (!r.ok) {
    toast(r.reason ?? '无法删除这个分段', 'error')
    return false
  }
  toast(`已将分段「${name}」移入回收站,可在回收站恢复或彻底删除(也可 Ctrl+Z 撤销)`, 'success')
  return true
}

export function forkProjectWithToast(id: string): string | null {
  const copy = store().duplicateProject(id)
  if (!copy) {
    toast('复制失败:这部剧已不存在', 'error')
    return null
  }
  const name = store().projects.find((p) => p.id === copy)?.name ?? ''
  toast(`已创建副本「${name}」`, 'success')
  return copy
}

export function forkBoardWithToast(id: string): string | null {
  const copy = store().duplicateBoard(id)
  if (!copy) {
    toast('复制失败:这个分段已不存在', 'error')
    return null
  }
  const name = store().boards.find((b) => b.id === copy)?.name ?? ''
  toast(`已创建副本「${name}」,紧跟在原分段后面`, 'success')
  return copy
}

export function projectMenuItems(projectId: string, opts: { onRename: () => void }): ContextMenuItem[] {
  const s = store()
  const pinned = s.pinnedProjectIds.includes(projectId)
  const only = s.projects.length <= 1
  return [
    { id: 'rename', label: '重命名', onSelect: opts.onRename },
    {
      id: 'pin',
      label: pinned ? '取消置顶' : '置顶',
      hint: pinned ? 'Unpin' : 'Pin',
      onSelect: () => store().setProjectPinned(projectId, !pinned),
    },
    { id: 'fork', label: 'Fork', hint: '创建副本', onSelect: () => void forkProjectWithToast(projectId) },
    {
      id: 'delete',
      label: '删除',
      hint: '移入回收站',
      danger: true,
      separatorBefore: true,
      disabled: only,
      disabledReason: '至少保留一部剧',
      onSelect: () => void trashProjectWithToast(projectId),
    },
  ]
}

export function boardMenuItems(
  boardId: string,
  opts: { onRename: () => void; onOpen?: () => void },
): ContextMenuItem[] {
  const s = store()
  const board = s.boards.find((b) => b.id === boardId)
  const pinned = s.pinnedBoardIds.includes(boardId)
  const only = board ? s.boards.filter((b) => b.projectId === board.projectId).length <= 1 : true
  return [
    ...(opts.onOpen ? [{ id: 'open', label: '打开', onSelect: opts.onOpen }] : []),
    { id: 'rename', label: '重命名', onSelect: opts.onRename },
    {
      id: 'pin',
      label: pinned ? '取消置顶' : '置顶',
      hint: pinned ? 'Unpin' : 'Pin',
      onSelect: () => store().setBoardPinned(boardId, !pinned),
    },
    { id: 'fork', label: 'Fork', hint: '创建副本', onSelect: () => void forkBoardWithToast(boardId) },
    {
      id: 'delete',
      label: '删除',
      hint: '移入回收站',
      danger: true,
      separatorBefore: true,
      disabled: only,
      disabledReason: '每部剧至少保留一个分段',
      onSelect: () => void trashBoardWithToast(boardId),
    },
  ]
}

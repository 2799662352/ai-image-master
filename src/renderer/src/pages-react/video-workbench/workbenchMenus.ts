// 剧 / 分段右键菜单的条目构建 + 带 toast 的动作封装。
// 三个入口(剧栏行、总览分段卡、分段页签)共用,保证文案和规则只有一份。
// 状态在「右键那一刻」读取,所以菜单里的置顶/取消置顶、可否删除永远是最新的。

import { pinnedFirstBy, planReorder } from '../../features/video-workbench/projects'
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

export function projectMenuItems(
  projectId: string,
  opts: {
    onRename: () => void
    /** 给了才出现「移到分组…」(剧栏有对话框可弹);总览头部的菜单不传,保持原样。 */
    onMoveToGroup?: () => void
  },
): ContextMenuItem[] {
  const s = store()
  const pinned = s.pinnedProjectIds.includes(projectId)
  const only = s.projects.length <= 1
  const group = s.projects.find((p) => p.id === projectId)?.group
  return [
    { id: 'rename', label: '重命名', onSelect: opts.onRename },
    {
      id: 'pin',
      label: pinned ? '取消置顶' : '置顶',
      hint: pinned ? 'Unpin' : 'Pin',
      onSelect: () => store().setProjectPinned(projectId, !pinned),
    },
    ...(opts.onMoveToGroup
      ? [
          { id: 'move-group', label: '移到分组…', onSelect: opts.onMoveToGroup },
          ...(group
            ? [
                {
                  id: 'ungroup',
                  label: '移出分组',
                  hint: group,
                  onSelect: () => void store().assignProjectGroup(projectId, null),
                },
              ]
            : []),
        ]
      : []),
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

/** 分组标题的右键菜单:重命名 / 解散。空分组(还没放进任何剧)没有东西可「解散」,改叫「删除分组」。 */
export function groupMenuItems(name: string, opts: { empty: boolean; onRename: () => void }): ContextMenuItem[] {
  return [
    { id: 'rename-group', label: '重命名', onSelect: opts.onRename },
    {
      id: 'dissolve-group',
      label: opts.empty ? '删除分组' : '解散分组',
      hint: opts.empty ? '它还是空的' : '剧回到未分组',
      danger: opts.empty,
      separatorBefore: true,
      onSelect: () => void store().dissolveGroup(name),
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
  const own = board ? s.boards.filter((b) => b.projectId === board.projectId) : []
  const only = board ? own.length <= 1 : true
  // 前移 / 后移:拖动之外的键盘 / 右键通路。按「显示顺序」找邻居(置顶的显示在最前),
  // 但新顺序交给 planReorder 按存储顺序算 —— 和拖动同一口径,跨置顶边界的挪法它会拒绝。
  const ids = own.sort((a, b) => a.order - b.order).map((b) => b.id)
  const shown = pinnedFirstBy(ids, s.pinnedBoardIds, (id) => id)
  const at = shown.indexOf(boardId)
  const prevId = at > 0 ? shown[at - 1] : undefined
  const nextId = at >= 0 ? shown[at + 1] : undefined
  const movePrev = prevId ? planReorder(ids, s.pinnedBoardIds, boardId, prevId, 'before') : null
  const moveNext = nextId ? planReorder(ids, s.pinnedBoardIds, boardId, nextId, 'after') : null
  const pinBoundary = '置顶的分段始终排在最前面,不能和未置顶的互换位置'
  return [
    ...(opts.onOpen ? [{ id: 'open', label: '打开', onSelect: opts.onOpen }] : []),
    { id: 'rename', label: '重命名', onSelect: opts.onRename },
    {
      id: 'pin',
      label: pinned ? '取消置顶' : '置顶',
      hint: pinned ? 'Unpin' : 'Pin',
      onSelect: () => store().setBoardPinned(boardId, !pinned),
    },
    {
      id: 'move-prev',
      label: '前移一格',
      hint: '←',
      disabled: !movePrev,
      disabledReason: prevId ? pinBoundary : '已经是第一个',
      onSelect: () => {
        if (board && movePrev) store().reorderBoards(board.projectId, movePrev)
      },
    },
    {
      id: 'move-next',
      label: '后移一格',
      hint: '→',
      disabled: !moveNext,
      disabledReason: nextId ? pinBoundary : '已经是最后一个',
      onSelect: () => {
        if (board && moveNext) store().reorderBoards(board.projectId, moveNext)
      },
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

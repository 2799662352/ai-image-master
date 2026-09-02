import { create } from 'zustand'
import { DEFAULT_ERASE_TOOL, type EraseTool, type EraseTask, type EraseProbeResult } from '../../../types/smartErase'

export interface EraseSessionTask extends EraseTask {
  filePath: string
  posterDataUrl: string
  /** 这条任务走的是高清还是去字幕;列表与结果卡按它标注。 */
  tool?: EraseTool
}

interface EraseSessionState {
  activeTasks: EraseSessionTask[]
  recentlyFinished: string | null
  selectedHistoryId: string | null
  modalItemId: string | null

  pendingProbes: EraseProbeResult[]
  showCostConfirm: boolean

  /**
   * 上传区当前选的工具。默认高清(产品要求 2026-09-01)。
   * 刻意不持久化:两个工具的费用与耗时差别很大,每次进页面都从明确的默认值起手,
   * 比「上次不知何时点过的那个」更不容易误提交。
   */
  tool: EraseTool
  setTool: (tool: EraseTool) => void

  addTask: (task: EraseSessionTask) => void
  removeActiveTask: (taskId: string) => void
  updateTaskStatus: (
    taskId: string,
    status: EraseTask['status'],
    patch?: Partial<EraseSessionTask>,
  ) => void
  failTask: (taskId: string, errorMessage: string, errorCode?: string) => void
  cancelTask: (taskId: string) => void

  setRecentlyFinished: (id: string | null) => void
  setSelectedHistoryId: (id: string | null) => void
  setModalItemId: (id: string | null) => void

  setPendingProbes: (probes: EraseProbeResult[]) => void
  setShowCostConfirm: (open: boolean) => void
}

export const useEraseSessionStore = create<EraseSessionState>()((set) => ({
  activeTasks: [],
  recentlyFinished: null,
  selectedHistoryId: null,
  modalItemId: null,
  pendingProbes: [],
  showCostConfirm: false,

  tool: DEFAULT_ERASE_TOOL,
  setTool: (tool) => set({ tool }),

  addTask: (task) => set((s) => ({ activeTasks: [...s.activeTasks, task] })),

  removeActiveTask: (taskId) =>
    set((s) => ({ activeTasks: s.activeTasks.filter((t) => t.id !== taskId) })),

  updateTaskStatus: (taskId, status, patch) =>
    set((s) => ({
      activeTasks: s.activeTasks.map((t) =>
        t.id === taskId
          ? { ...t, ...patch, status }
          : t,
      ),
    })),

  failTask: (taskId, errorMessage, errorCode) =>
    set((s) => ({
      activeTasks: s.activeTasks.map((t) =>
        t.id === taskId
          ? { ...t, status: 'failed' as const, errorMessage, errorCode }
          : t,
      ),
    })),

  cancelTask: (taskId) =>
    set((s) => ({
      activeTasks: s.activeTasks.filter((t) => t.id !== taskId),
    })),

  setRecentlyFinished: (id) => set({ recentlyFinished: id }),
  setSelectedHistoryId: (id) => set({ selectedHistoryId: id }),
  setModalItemId: (id) => set({ modalItemId: id, selectedHistoryId: id }),

  setPendingProbes: (probes) => set({ pendingProbes: probes }),
  setShowCostConfirm: (open) => set({ showCostConfirm: open }),
}))

import { create } from 'zustand'
import type { EraseTask, EraseProbeResult } from '../../../types/smartErase'

export interface EraseSessionTask extends EraseTask {
  filePath: string
  posterDataUrl: string
}

interface EraseSessionState {
  activeTasks: EraseSessionTask[]
  recentlyFinished: string | null
  selectedHistoryId: string | null
  modalItemId: string | null

  pendingProbes: EraseProbeResult[]
  showCostConfirm: boolean

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

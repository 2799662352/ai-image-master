import { create } from 'zustand'
import type { EraseTask, EraseProbeResult } from '../../../types/smartErase'

/**
 * Renderer-side enrichment of EraseTask: carries fields needed by the UI
 * (filePath for side-by-side compare, local poster) that don't belong in
 * the IPC contract because they're produced/consumed entirely in the
 * renderer or returned synchronously from submitErase.
 */
export interface EraseSessionTask extends EraseTask {
  filePath: string         // local absolute path; '' if not available (synthetic File)
  posterDataUrl: string    // base64 jpeg returned from submit IPC
  error?: string           // human-readable failure message
}

interface EraseSessionState {
  activeTasks: EraseSessionTask[]
  recentlyFinished: string | null
  selectedHistoryId: string | null

  // Cost-confirm flow: probe results staged before user confirms in dialog.
  pendingProbes: EraseProbeResult[]
  showCostConfirm: boolean

  addTask: (task: EraseSessionTask) => void
  removeActiveTask: (taskId: string) => void
  updateTaskStatus: (
    taskId: string,
    status: EraseTask['status'],
    uploadProgress?: number,
    mpsTaskId?: string,
  ) => void
  failTask: (taskId: string, error: string, errorCode?: string) => void
  cancelTask: (taskId: string) => void

  setRecentlyFinished: (id: string | null) => void
  setSelectedHistoryId: (id: string | null) => void

  setPendingProbes: (probes: EraseProbeResult[]) => void
  setShowCostConfirm: (open: boolean) => void
}

export const useEraseSessionStore = create<EraseSessionState>()((set) => ({
  activeTasks: [],
  recentlyFinished: null,
  selectedHistoryId: null,
  pendingProbes: [],
  showCostConfirm: false,

  addTask: (task) => set((s) => ({ activeTasks: [...s.activeTasks, task] })),

  removeActiveTask: (taskId) =>
    set((s) => ({ activeTasks: s.activeTasks.filter((t) => t.id !== taskId) })),

  updateTaskStatus: (taskId, status, uploadProgress, mpsTaskId) =>
    set((s) => ({
      activeTasks: s.activeTasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              status,
              uploadProgress: uploadProgress ?? t.uploadProgress,
              mpsTaskId: mpsTaskId ?? t.mpsTaskId,
            }
          : t,
      ),
    })),

  failTask: (taskId, error, errorCode) =>
    set((s) => ({
      activeTasks: s.activeTasks.map((t) =>
        t.id === taskId
          ? { ...t, status: 'failed' as const, error, errorCode }
          : t,
      ),
    })),

  cancelTask: (taskId) =>
    set((s) => ({
      activeTasks: s.activeTasks.filter((t) => t.id !== taskId),
    })),

  setRecentlyFinished: (id) => set({ recentlyFinished: id }),
  setSelectedHistoryId: (id) => set({ selectedHistoryId: id }),

  setPendingProbes: (probes) => set({ pendingProbes: probes }),
  setShowCostConfirm: (open) => set({ showCostConfirm: open }),
}))

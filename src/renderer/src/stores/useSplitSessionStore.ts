import { create } from 'zustand'
import type { SplitTask, SplitTaskStatus, SplitStage, SplitResult } from '../../../types/storyboardSplit'

interface SplitSessionState {
  tasks: SplitTask[]
  drawerOpen: boolean

  addTask: (task: SplitTask) => void
  removeTask: (taskId: string) => void
  updateTaskProgress: (taskId: string, status: SplitTaskStatus, progress: number, stage?: SplitStage) => void
  finishTask: (taskId: string, results: SplitResult[]) => void
  failTask: (taskId: string, error: string, errorCode?: string) => void
  cancelTask: (taskId: string) => void
  clearImageData: (taskId: string) => void
  reopenHistory: (task: SplitTask) => void
  toggleDrawer: () => void
}

export const useSplitSessionStore = create<SplitSessionState>()((set, get) => ({
  tasks: [],
  drawerOpen: false,

  addTask: (task) => set((s) => ({ tasks: [...s.tasks, task] })),

  removeTask: (taskId) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== taskId) })),

  updateTaskProgress: (taskId, status, progress, stage) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, status, progress, stage: stage ?? t.stage } : t
      ),
    })),

  finishTask: (taskId, results) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId
          ? { ...t, status: 'finished' as const, progress: 100, stage: 'done' as const, results, finishedAt: Date.now() }
          : t
      ),
    })),

  failTask: (taskId, error, errorCode) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, status: 'failed' as const, error, errorCode } : t
      ),
    })),

  cancelTask: (taskId) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, status: 'cancelled' as const } : t
      ),
    })),

  clearImageData: (taskId) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId ? { ...t, imageDataUrl: '' } : t
      ),
    })),

  reopenHistory: (task) => {
    if (get().tasks.some((t) => t.id === task.id)) return
    set((s) => ({ tasks: [...s.tasks, task] }))
  },

  toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
}))

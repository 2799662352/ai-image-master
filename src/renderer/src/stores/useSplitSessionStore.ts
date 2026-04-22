import { create } from 'zustand'
import type { SplitTask, SplitTaskStatus, SplitStage } from '../../../types/storyboardSplit'

interface SplitSessionState {
  activeTasks: SplitTask[]
  recentlyFinished: string | null
  selectedHistoryId: string | null
  previewMode: 'single' | 'grid'
  previewIndex: number

  addTask: (task: SplitTask) => void
  removeActiveTask: (taskId: string) => void
  updateTaskProgress: (taskId: string, status: SplitTaskStatus, progress: number, stage?: SplitStage) => void
  failTask: (taskId: string, error: string, errorCode?: string) => void
  cancelTask: (taskId: string) => void
  clearImageData: (taskId: string) => void
  setRecentlyFinished: (id: string | null) => void
  setSelectedHistoryId: (id: string | null) => void
  setPreviewMode: (mode: 'single' | 'grid') => void
  setPreviewIndex: (index: number) => void
}

export const useSplitSessionStore = create<SplitSessionState>()((set) => ({
  activeTasks: [],
  recentlyFinished: null,
  selectedHistoryId: null,
  previewMode: 'single' as const,
  previewIndex: 0,

  addTask: (task) => set((s) => ({ activeTasks: [...s.activeTasks, task] })),

  removeActiveTask: (taskId) =>
    set((s) => ({ activeTasks: s.activeTasks.filter((t) => t.id !== taskId) })),

  updateTaskProgress: (taskId, status, progress, stage) =>
    set((s) => ({
      activeTasks: s.activeTasks.map((t) =>
        t.id === taskId ? { ...t, status, progress, stage: stage ?? t.stage } : t
      ),
    })),

  failTask: (taskId, error, errorCode) =>
    set((s) => ({
      activeTasks: s.activeTasks.map((t) =>
        t.id === taskId ? { ...t, status: 'failed' as const, error, errorCode } : t
      ),
    })),

  cancelTask: (taskId) =>
    set((s) => ({
      activeTasks: s.activeTasks.filter((t) => t.id !== taskId),
    })),

  clearImageData: (taskId) =>
    set((s) => ({
      activeTasks: s.activeTasks.map((t) =>
        t.id === taskId ? { ...t, imageDataUrl: '' } : t
      ),
    })),

  setRecentlyFinished: (id) => set({ recentlyFinished: id }),
  setSelectedHistoryId: (id) => set({ selectedHistoryId: id }),
  setPreviewMode: (mode) => set({ previewMode: mode }),
  setPreviewIndex: (index) => set({ previewIndex: index }),
}))

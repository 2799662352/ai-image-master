import { create } from 'zustand'

export type WorkspaceSectionKey = 'overview' | 'permissions' | 'mcp' | 'skills' | 'threads' | 'logs' | 'doctor'

interface WorkspaceState {
  section: WorkspaceSectionKey
  setSection: (section: WorkspaceSectionKey) => void
  configDirty: boolean
  setConfigDirty: (value: boolean) => void
}

export const useAgentWorkspaceStore = create<WorkspaceState>((set) => ({
  section: 'overview',
  setSection: (section) => set({ section }),
  configDirty: false,
  setConfigDirty: (configDirty) => set({ configDirty }),
}))

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'

export const VALID_TABS = [
  'generate',
  'batch',
  'compare',
  'history',
  'understand',
  'director',
  'storyboardSplit',
  'smartErase',
  'portraitLibrary',
  'promptTemplates',
  'agentWorkspace',
  'marketplace',
  'settings',
] as const

export type TabName = (typeof VALID_TABS)[number]

export function isTabName(tab: string): tab is TabName {
  return VALID_TABS.includes(tab as TabName)
}

interface TabState {
  activeTab: TabName
  previousTab: TabName | null
  switchTab: (tab: string) => void
}

export const useTabStore = create<TabState>()(
  subscribeWithSelector((set, get) => ({
    activeTab: 'generate',
    previousTab: null,
    switchTab: (tab: string) => {
      if (!isTabName(tab)) return
      const prev = get().activeTab
      if (prev === tab) return
      set({ activeTab: tab as TabName, previousTab: prev })
    },
  }))
)

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'

const VALID_TABS = [
  'generate',
  'batch',
  'compare',
  'history',
  'understand',
  'director',
  'storyboardSplit',
  'promptTemplates',
  'settings',
] as const

export type TabName = (typeof VALID_TABS)[number]

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
      if (!VALID_TABS.includes(tab as TabName)) return
      const prev = get().activeTab
      if (prev === tab) return
      set({ activeTab: tab as TabName, previousTab: prev })
    },
  }))
)

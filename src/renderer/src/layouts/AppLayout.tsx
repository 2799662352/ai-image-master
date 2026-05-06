import { Suspense, useEffect } from 'react'
import { useTabStore, type TabName } from '../stores'
import { TabBar } from '../components/TabBar'
import { AgentChatPanel, mountAgentToolExecutor, useAgentChatStore } from '../features/agent-chat'
import {
  GeneratePage,
  BatchPage,
  ComparePage,
  HistoryPage,
  UnderstandPage,
  SettingsPage,
  DirectorPage,
  PromptTemplatesPage,
  StoryboardSplitPage,
  SmartErasePage,
} from '../pages-react'

const PAGE_MAP: Record<TabName, React.LazyExoticComponent<() => React.JSX.Element>> = {
  generate: GeneratePage,
  batch: BatchPage,
  compare: ComparePage,
  history: HistoryPage,
  understand: UnderstandPage,
  settings: SettingsPage,
  director: DirectorPage,
  promptTemplates: PromptTemplatesPage,
  storyboardSplit: StoryboardSplitPage,
  smartErase: SmartErasePage,
}

function PageFallback() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="w-8 h-8 border-2 border-cyberpunk-yellow border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

export function AppLayout() {
  const activeTab = useTabStore((s) => s.activeTab)
  const ActivePage = PAGE_MAP[activeTab]

  useEffect(() => {
    const unsub = useTabStore.subscribe(
      (state) => state.activeTab,
      (tab) => { window.location.hash = tab }
    )
    return unsub
  }, [])

  useEffect(() => {
    const hash = window.location.hash.slice(1)
    if (hash) useTabStore.getState().switchTab(hash)
  }, [])

  useEffect(() => {
    return mountAgentToolExecutor()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        useAgentChatStore.getState().toggle()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="flex flex-col h-screen bg-cyberpunk-black text-white font-exo">
      <TabBar />
      <main className="flex-1 overflow-auto">
        <Suspense fallback={<PageFallback />}>
          <ActivePage />
        </Suspense>
      </main>
      <AgentChatPanel />
    </div>
  )
}

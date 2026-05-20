import { Activity, Suspense, useEffect, useState, type ComponentType, type LazyExoticComponent } from 'react'
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
  AgentWorkspacePage,
  MarketplacePage,
} from '../pages-react'

const PAGE_MAP: Record<TabName, LazyExoticComponent<ComponentType>> = {
  generate: GeneratePage,
  batch: BatchPage,
  compare: ComparePage,
  history: HistoryPage,
  understand: UnderstandPage,
  settings: SettingsPage,
  director: DirectorPage,
  promptTemplates: PromptTemplatesPage,
  agentWorkspace: AgentWorkspacePage,
  marketplace: MarketplacePage,
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

  // Track every tab the user has ever opened. We render Activity wrappers
  // only for those — a fresh session that only ever visits History never
  // pays the cost of mounting Batch / Director / etc.
  //
  // Render-time set-update (NOT in useEffect) avoids the 1-frame blank
  // flash on first visit: useEffect would only fire after commit, so
  // Render 1 would have activeTab=new but visited={old}, painting nothing
  // for the new tab for one frame. React explicitly allows setState during
  // render when derived from current state — it discards the in-progress
  // render and re-renders synchronously with the updated state.
  // See: https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [visited, setVisited] = useState<Set<TabName>>(() => new Set([activeTab]))
  if (!visited.has(activeTab)) {
    setVisited((prev) => {
      if (prev.has(activeTab)) return prev
      const next = new Set(prev)
      next.add(activeTab)
      return next
    })
  }

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
        {Array.from(visited).map((tab) => {
          const Page = PAGE_MAP[tab]
          return (
            <Activity key={tab} mode={tab === activeTab ? 'visible' : 'hidden'}>
              {/* Each Activity gets its OWN Suspense so a lazy-page
                  suspension only affects its own tab — does not blow away
                  the already-mounted DOM of other hidden tabs. */}
              <Suspense fallback={<PageFallback />}>
                <Page />
              </Suspense>
            </Activity>
          )
        })}
      </main>
      <AgentChatPanel />
    </div>
  )
}

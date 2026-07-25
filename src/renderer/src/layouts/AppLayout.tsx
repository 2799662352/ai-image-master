import { Activity, Suspense, useEffect, useState, type ComponentType, type LazyExoticComponent } from 'react'
import { useTabStore, type TabName } from '../stores'
import { TabBar } from '../components/TabBar'
import {
  AgentChatPanel,
  mountAgentToolExecutor,
  mountSeedanceTaskListener,
  useAgentChatStore,
} from '../features/agent-chat'
import { mountWorkbenchTaskListener, useVideoWorkbenchStore } from '../features/video-workbench/store'
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
  VideoWorkbenchPage,
  SmartErasePage,
  AgentWorkspacePage,
  MarketplacePage,
  PortraitLibraryPage,
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
  videoWorkbench: VideoWorkbenchPage,
  smartErase: SmartErasePage,
  portraitLibrary: PortraitLibraryPage,
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
    return mountSeedanceTaskListener()
  }, [])

  // 工作台任务回流必须挂在 App 级:页面本身被下面的 `<Activity mode="hidden">`
  // 托管,切走标签页时 React 会销毁页面 effect,订阅会随之断开,期间完成的任务
  // 广播就永久丢了(全局 SeedanceTaskListener 对 source==='workbench' 不接)。
  // mountWorkbenchTaskListener 是引用计数的,与页面自己那份共存。
  useEffect(() => {
    return mountWorkbenchTaskListener()
  }, [])

  // 重启对账:主进程任务表是纯内存的,上次退出时进行中的任务在那边已经没人轮询,
  // 但上游还在跑。把卡片记住的 taskId 交回去重新接管,结果照旧走落盘+写历史;
  // 上游查不到的直接落 failed,免得永久停在「渲染中」。先挂好监听再对账,
  // 否则接管后立刻到达的广播会没人接。
  useEffect(() => {
    const store = useVideoWorkbenchStore.getState()
    void store.ensureHydrated().then(() => useVideoWorkbenchStore.getState().reconcileInFlight())
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

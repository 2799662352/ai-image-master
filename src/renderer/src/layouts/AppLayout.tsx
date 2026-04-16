import { Suspense } from 'react'
import { useTabStore, type TabName } from '../stores'
import {
  GeneratePage,
  BatchPage,
  ComparePage,
  HistoryPage,
  UnderstandPage,
  SettingsPage,
  DirectorPage,
  PromptTemplatesPage,
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

  return (
    <div className="flex flex-col h-screen bg-cyberpunk-black text-white font-exo">
      {/* TabBar will be inserted here in Task 11 */}
      <main className="flex-1 overflow-auto">
        <Suspense fallback={<PageFallback />}>
          <ActivePage />
        </Suspense>
      </main>
    </div>
  )
}

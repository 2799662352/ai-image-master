import { useState, useTransition } from 'react'
import { Bot } from 'lucide-react'

import { useTabStore, type TabName } from '../../stores'
import { AgentStatusButton } from '../AgentStatusButton'

interface TabDef {
  key: TabName
  label: string
  icon: string
}

const TABS: TabDef[] = [
  { key: 'generate', label: '生成', icon: '🎨' },
  { key: 'batch', label: '批量', icon: '📦' },
  { key: 'compare', label: '对比', icon: '🔍' },
  { key: 'history', label: '历史', icon: '📜' },
  { key: 'videoWorkbench', label: '生成视频', icon: '🎥' },
  { key: 'director', label: '导演', icon: '🎬' },
  { key: 'understand', label: '理解', icon: '🧠' },
  // storyboardSplit（宫格拆图）已从导航隐藏，页面代码保留

  { key: 'smartErase', label: '去字幕', icon: '✂️' },
  { key: 'portraitLibrary', label: '人像库', icon: '👤' },
  { key: 'promptTemplates', label: '模板', icon: '📝' },
  { key: 'agentWorkspace', label: 'Agent Workspace', icon: 'agent' },
  { key: 'marketplace', label: '技能市场', icon: '🛒' },
  { key: 'settings', label: '设置', icon: '⚙️' },
]

export function TabBar() {
  const activeTab = useTabStore((s) => s.activeTab)
  const switchTab = useTabStore((s) => s.switchTab)
  // useTransition lets the click highlight commit instantly while React
  // renders the new tab's heavy subtree at low priority. pendingTab tells
  // us which tab the user just clicked so we can dim it during the transition.
  const [isPending, startTransition] = useTransition()
  const [pendingTab, setPendingTab] = useState<TabName | null>(null)

  const handleSwitch = (tab: TabName) => {
    setPendingTab(tab)
    startTransition(() => switchTab(tab))
  }

  return (
    <div className="flex items-center justify-between w-full bg-cyberpunk-dark border-b border-cyberpunk-yellow/20">
      <nav className="flex items-center gap-1 px-4 py-2 overflow-x-auto">
        {TABS.map((tab) => {
          const isThisPending = isPending && pendingTab === tab.key
          return (
            <button
              key={tab.key}
              onClick={() => handleSwitch(tab.key)}
              aria-busy={isThisPending}
              className={`
                flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-exo
                transition-colors whitespace-nowrap
                ${
                  activeTab === tab.key
                    ? 'bg-cyberpunk-yellow text-cyberpunk-black font-semibold'
                    : 'text-gray-400 hover:text-white hover:bg-white/5'
                }
                ${isThisPending ? 'opacity-60' : ''}
              `}
            >
              {tab.key === 'agentWorkspace' ? (
                <Bot className="h-4 w-4" aria-hidden="true" />
              ) : (
                <span>{tab.icon}</span>
              )}
              <span>{tab.label}</span>
            </button>
          )
        })}
      </nav>
      <div className="flex items-center gap-2 px-4">
        <AgentStatusButton />
      </div>
    </div>
  )
}

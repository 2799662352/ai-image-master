import { useTabStore, type TabName } from '../../stores'

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
  { key: 'understand', label: '理解', icon: '🧠' },
  { key: 'director', label: '导演', icon: '🎬' },
  { key: 'storyboardSplit', label: '拆图', icon: '🧩' },
  { key: 'promptTemplates', label: '模板', icon: '📝' },
  { key: 'settings', label: '设置', icon: '⚙️' },
]

export function TabBar() {
  const activeTab = useTabStore((s) => s.activeTab)
  const switchTab = useTabStore((s) => s.switchTab)

  return (
    <nav className="flex items-center gap-1 px-4 py-2 bg-cyberpunk-dark border-b border-cyberpunk-yellow/20 overflow-x-auto">
      {TABS.map((tab) => (
        <button
          key={tab.key}
          onClick={() => switchTab(tab.key)}
          className={`
            flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-exo
            transition-colors whitespace-nowrap
            ${
              activeTab === tab.key
                ? 'bg-cyberpunk-yellow text-cyberpunk-black font-semibold'
                : 'text-gray-400 hover:text-white hover:bg-white/5'
            }
          `}
        >
          <span>{tab.icon}</span>
          <span>{tab.label}</span>
        </button>
      ))}
    </nav>
  )
}

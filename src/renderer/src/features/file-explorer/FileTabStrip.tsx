import { useFileExplorerStore } from './store'
import { CloseIcon, DotIcon } from './icons'

export function FileTabStrip() {
  const { tabs, activeTabId, setActiveTab, closeTab } = useFileExplorerStore()
  if (tabs.length === 0) return null
  return (
    <div role="tablist" className="flex overflow-x-auto border-b border-cyan-500/15 bg-black/40">
      {tabs.map((t) => {
        const active = t.id === activeTabId
        return (
          <div
            key={t.id}
            data-testid={`tab-${t.id}`}
            data-active={active ? 'true' : 'false'}
            onClick={() => setActiveTab(t.id)}
            className={
              'flex h-7 cursor-pointer items-center gap-1 border-r border-cyan-500/10 px-3 text-xs ' +
              (active ? 'bg-cyan-500/10 text-cyan-100' : 'text-cyan-300/60 hover:bg-white/5')
            }
          >
            {t.dirty && (
              <span data-testid={`tab-${t.id}-dirty`}>
                <DotIcon className="text-cyan-300" />
              </span>
            )}
            <span className="max-w-[180px] truncate">{t.name}</span>
            <button
              type="button"
              aria-label={`Close ${t.name}`}
              onClick={(e) => {
                e.stopPropagation()
                closeTab(t.id)
              }}
              className="rounded p-0.5 hover:bg-white/10"
            >
              <CloseIcon />
            </button>
          </div>
        )
      })}
    </div>
  )
}

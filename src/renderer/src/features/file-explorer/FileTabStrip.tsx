import { useEffect, useRef, useState } from 'react'
import { useFileExplorerStore } from './store'
import { CloseIcon, DotIcon } from './icons'
import type { FileTab } from './types'

export function FileTabStrip() {
  const { tabs, activeTabId, setActiveTab, closeTab, saveTab } = useFileExplorerStore()
  const scrollActiveTabToken = useFileExplorerStore((s) => s.scrollActiveTabToken)
  const [pendingClose, setPendingClose] = useState<FileTab | null>(null)
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  // Why both activeTabId AND token in deps:
  //  - activeTabId change handles the natural case (openTab → new active tab,
  //    scroll it into view automatically).
  //  - token handles the "jump-back" gesture from LatestPreviewBanner when
  //    the user manually scrolled the strip and activeTabId didn't change.
  useEffect(() => {
    if (!activeTabId) return
    const el = tabRefs.current.get(activeTabId)
    if (!el) return
    if (typeof el.scrollIntoView !== 'function') return
    // `inline: 'center'` keeps the active tab visually centered in the strip
    // so neighbors stay visible — better orientation than 'nearest' alone.
    el.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }, [activeTabId, scrollActiveTabToken])

  if (tabs.length === 0) return null
  return (
    <div role="tablist" className="flex overflow-x-auto border-b border-cyan-500/15 bg-black/40">
      {tabs.map((t) => {
        const active = t.id === activeTabId
        return (
          <div
            key={t.id}
            ref={(el) => {
              if (el) tabRefs.current.set(t.id, el)
              else tabRefs.current.delete(t.id)
            }}
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
            {t.dirty && (
              <button
                type="button"
                aria-label={`Save ${t.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  void saveTab(t.id)
                }}
                className="rounded border border-cyan-400/25 px-1 py-0.5 text-[10px] text-cyan-100 hover:bg-cyan-500/20"
              >
                Save
              </button>
            )}
            <button
              type="button"
              aria-label={`Close ${t.name}`}
              onClick={(e) => {
                e.stopPropagation()
                if (t.dirty && t.kind === 'text') {
                  setPendingClose(t)
                  return
                }
                void closeTab(t.id)
              }}
              className="rounded p-0.5 hover:bg-white/10"
            >
              <CloseIcon />
            </button>
          </div>
        )
      })}
      {pendingClose ? (
        <div
          role="dialog"
          aria-label={`Save changes to ${pendingClose.name}?`}
          className="fixed left-1/2 top-16 z-[50000] w-[340px] -translate-x-1/2 rounded-xl border border-cyan-400/25 bg-zinc-950 p-4 text-cyan-50 shadow-2xl"
        >
          <div className="text-sm font-semibold">Save changes before closing?</div>
          <div className="mt-1 text-xs leading-relaxed text-cyan-100/60">
            {pendingClose.name} has unsaved changes.
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPendingClose(null)}
              className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                const id = pendingClose.id
                setPendingClose(null)
                void closeTab(id, { saveDirty: false })
              }}
              className="rounded border border-red-400/30 px-3 py-1.5 text-xs text-red-200 hover:bg-red-500/10"
            >
              Don&apos;t Save
            </button>
            <button
              type="button"
              onClick={() => {
                const id = pendingClose.id
                setPendingClose(null)
                void closeTab(id, { saveDirty: true })
              }}
              className="rounded bg-cyan-300 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-cyan-200"
            >
              Save
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

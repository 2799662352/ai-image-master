import { useMemo } from 'react'
import { useFileExplorerStore } from './store'
import type { FileTab, FileTabKind } from './types'
import { FileIcon, OpenInPanelIcon } from '../agent-chat/icons'

/**
 * Status strip pinned above the tab strip. Always tells the user which file
 * they are currently previewing, regardless of how the tab strip has been
 * scrolled. Clicking it asks the strip to scroll the active tab back into
 * view.
 *
 * Why a separate component instead of folding into FileTabStrip:
 *  - It's a different visual element (a single-row banner, not a list of
 *    tabs) and FileTabStrip already has its own horizontal scroll context
 *    so embedding the banner inside would break its layout invariants.
 *  - Keeping it separate makes the "jump-back" interaction
 *    (`requestScrollActiveTabIntoView`) easy to wire and test.
 *
 * Hidden when there is no active tab — otherwise the strip would show "Open
 * a file to begin" twice (banner + ActiveViewer placeholder).
 */
export function LatestPreviewBanner() {
  const activeTab = useFileExplorerStore((s) =>
    s.activeTabId ? s.tabs.find((t) => t.id === s.activeTabId) ?? null : null,
  )
  const requestScrollActiveTabIntoView = useFileExplorerStore((s) => s.requestScrollActiveTabIntoView)

  // Only re-derive the badge/hint when the fields the banner actually reads
  // change. Using the whole `activeTab` object as the dep would invalidate on
  // every keystroke (because `setTabState` produces a new tab reference) even
  // though the banner doesn't care about `state` / `dirty`.
  const display = useMemo(
    () => (activeTab ? describeTab(activeTab) : null),
    [activeTab?.id, activeTab?.kind, activeTab?.source],
  )

  if (!activeTab || !display) return null

  return (
    <button
      type="button"
      onClick={() => requestScrollActiveTabIntoView()}
      data-testid="latest-preview-banner"
      aria-label={`Latest preview: ${activeTab.name}. Click to scroll the tab strip back to this file.`}
      title={`Scroll back to ${activeTab.name}`}
      className="group flex w-full items-center gap-2 border-b border-cyan-500/15 bg-cyan-500/[0.04] px-3 py-1 text-left text-[11px] text-cyan-100/80 transition-colors hover:bg-cyan-500/10 hover:text-cyan-50"
    >
      <span
        className={
          'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] ' +
          display.badgeClass
        }
      >
        {display.badge}
      </span>
      <FileIcon className="shrink-0 text-cyan-300/70" />
      <span className="truncate font-mono" title={activeTab.path || activeTab.name}>
        {activeTab.name}
      </span>
      {activeTab.dirty && (
        <span className="shrink-0 rounded bg-amber-500/15 px-1 text-[9px] uppercase tracking-wider text-amber-200">
          modified
        </span>
      )}
      <span className="ml-auto shrink-0 truncate text-cyan-300/50">{display.hint}</span>
      <OpenInPanelIcon className="ml-1 shrink-0 text-cyan-300/40 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  )
}

type Display = { badge: string; badgeClass: string; hint: string }

function describeTab(tab: FileTab): Display {
  const kindBadge = kindBadgeFor(tab.kind)
  const sourceHint = sourceHintFor(tab)
  return {
    badge: kindBadge.label,
    badgeClass: kindBadge.className,
    hint: sourceHint,
  }
}

function kindBadgeFor(kind: FileTabKind): { label: string; className: string } {
  switch (kind) {
    case 'image':
      return { label: 'image', className: 'bg-cyan-400/15 text-cyan-200' }
    case 'video':
      return { label: 'video', className: 'bg-purple-400/15 text-purple-200' }
    case 'pdf':
      return { label: 'pdf', className: 'bg-red-400/15 text-red-200' }
    case 'binary':
      return { label: 'bin', className: 'bg-zinc-500/20 text-zinc-300' }
    case 'reference':
      return { label: 'ref', className: 'bg-amber-400/15 text-amber-200' }
    case 'compare':
      return { label: 'diff', className: 'bg-emerald-400/15 text-emerald-200' }
    case 'ai-change':
      return { label: 'ai', className: 'bg-fuchsia-400/15 text-fuchsia-200' }
    case 'text':
    default:
      return { label: 'text', className: 'bg-cyan-500/10 text-cyan-200' }
  }
}

function sourceHintFor(tab: FileTab): string {
  if (tab.source === 'attachments') return 'from chat'
  if (tab.kind === 'reference') return 'reference'
  if (tab.kind === 'ai-change') return 'ai change'
  if (tab.kind === 'compare') return 'compare'
  return 'workspace'
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { createPortal } from 'react-dom'
import type { AgentThreadSummary, CodexThreadSummary } from '../../../../types/agent'
import {
  ArrowUpRightIcon,
  BrainIcon,
  ChatBubbleIcon,
  CircleCheckIcon,
  CloseIcon,
  LayoutDashboardIcon,
  LoaderIcon,
  MoreIcon,
  PanelCollapseRightIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from './icons'
import {
  formatRelativeTime,
  groupThreadsByRecency,
  isThreadPinned,
  type ThreadGroup,
} from './relativeTime'
import { useAgentChatStore } from './store'
import { useTabStore } from '../../stores/useTabStore'

/**
 * Rows shown per group before the rest folds behind「更多 +N」. Six is what
 * Cursor's agent sidebar shows before its "More" row; it keeps four groups on
 * one 900px-tall screen without scrolling.
 */
const GROUP_FOLD_AT = 6

/**
 * Row subline, after Cursor's per-thread status line:「12 条消息 · 5h ago」, or
 *「运行中 · 12 条消息」while a turn streams. Count omitted when the list
 * predates the `messageCount` column (older main process).
 */
export function threadSubline(thread: AgentThreadSummary, running: boolean): string {
  const count = typeof thread.messageCount === 'number' ? `${thread.messageCount} 条消息` : null
  if (running) return count ? `运行中 · ${count}` : '运行中'
  const when = formatRelativeTime(thread.lastMessageAt)
  return count ? `${count} · ${when}` : when
}

/** Case-insensitive substring match on the title; empty query matches all. */
export function filterThreadsByQuery(
  threads: ReadonlyArray<AgentThreadSummary>,
  query: string,
): AgentThreadSummary[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...threads]
  return threads.filter((t) => t.title.toLowerCase().includes(q))
}

/**
 * Right-edge thread sidebar. Pinned to `right: 0` so it sits flush against the
 * screen edge — the chat panel offsets its own `right` by `sidebarWidth` to
 * make room. When `sidebarOpen` is false the component returns null and the
 * panel slides over to `right: 0` for a true full collapse (no rail residue).
 *
 * Owned by AgentChatPanel: it is only mounted while the panel itself is open,
 * so closing the panel takes the sidebar with it.
 *
 * Layout (design D1, Cursor-style): search + collapse → New chat → Agent
 * 工作台 → groups Pinned / Today / Yesterday / Last 7 days / Older (each folds
 * past {@link GROUP_FOLD_AT}) → Codex Sessions. Rows carry a status column
 * (running / done), a title and a subline (running or relative time); hover
 * reveals pin + ⋯.
 */
export function ThreadSidebar(): JSX.Element | null {
  const sidebarOpen = useAgentChatStore((s) => s.sidebarOpen)
  const sidebarWidth = useAgentChatStore((s) => s.sidebarWidth)
  const setSidebarWidth = useAgentChatStore((s) => s.setSidebarWidth)
  const toggleSidebar = useAgentChatStore((s) => s.toggleSidebar)
  const threadList = useAgentChatStore((s) => s.threadList)
  const threadListLoading = useAgentChatStore((s) => s.threadListLoading)
  const codexThreadList = useAgentChatStore((s) => s.codexThreadList)
  const codexThreadListLoading = useAgentChatStore((s) => s.codexThreadListLoading)
  const runningByThread = useAgentChatStore((s) => s.runningByThread)
  const threadId = useAgentChatStore((s) => s.threadId)
  const newThread = useAgentChatStore((s) => s.newThread)
  const switchThread = useAgentChatStore((s) => s.switchThread)
  const renameThread = useAgentChatStore((s) => s.renameThread)
  const deleteThread = useAgentChatStore((s) => s.deleteThread)
  const setThreadPinned = useAgentChatStore((s) => s.setThreadPinned)
  const setThreadMemoryMode = useAgentChatStore((s) => s.setThreadMemoryMode)
  const memoriesGloballyEnabled = useAgentChatStore((s) => s.memoriesGloballyEnabled)
  const forkCodexThread = useAgentChatStore((s) => s.forkCodexThread)

  const [query, setQuery] = useState('')
  const filtered = useMemo(() => filterThreadsByQuery(threadList, query), [threadList, query])
  const groups: ThreadGroup[] = useMemo(() => groupThreadsByRecency(filtered), [filtered])
  const searching = query.trim().length > 0

  // Same action as the header's "Open Agent Workspace": the workspace page is
  // a full tab, so the drawer gets out of the way.
  const openAgentWorkspace = useCallback(() => {
    useTabStore.getState().switchTab('agentWorkspace')
    useAgentChatStore.setState({ isOpen: false })
  }, [])

  // Drag the left edge to resize. The store action clamps to [200, 360] and
  // persists to localStorage for us — we just need to translate cursor X into
  // a width relative to the right edge.
  const onResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const prevUserSelect = document.body.style.userSelect
      const prevCursor = document.body.style.cursor
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'ew-resize'

      function onMove(ev: PointerEvent): void {
        const next = window.innerWidth - ev.clientX
        setSidebarWidth(next)
      }
      function onUp(): void {
        document.body.style.userSelect = prevUserSelect
        document.body.style.cursor = prevCursor
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
      }
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
    },
    [setSidebarWidth],
  )

  if (!sidebarOpen) return null

  return (
    <aside
      data-testid="thread-sidebar"
      aria-label="Conversation threads"
      className="fixed top-0 right-0 z-[40000] flex h-screen flex-col border-l border-zinc-800/80 bg-zinc-950/95 text-zinc-200 backdrop-blur"
      style={{ width: sidebarWidth }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={onResizePointerDown}
        className="absolute left-0 top-0 z-10 h-full w-1 cursor-ew-resize hover:bg-cyan-400/40 active:bg-cyan-400/60"
        data-testid="thread-sidebar-resize"
      />

      <header className="border-b border-zinc-800/80 px-3 pb-2 pt-3">
        <div className="flex items-center gap-2">
          <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/70 px-2 text-zinc-500 transition-colors focus-within:border-cyan-400/40">
            <SearchIcon className="h-3.5 w-3.5 shrink-0" />
            <input
              type="search"
              aria-label="Search threads"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.preventDefault()
                  setQuery('')
                }
              }}
              placeholder="搜索线程…"
              className="min-w-0 flex-1 bg-transparent text-[12px] text-zinc-100 outline-none placeholder:text-zinc-500 [&::-webkit-search-cancel-button]:hidden"
            />
            {searching ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery('')}
                className="inline-flex h-4 w-4 cursor-pointer items-center justify-center rounded text-zinc-500 hover:text-zinc-100"
              >
                <CloseIcon className="h-3 w-3" />
              </button>
            ) : null}
          </label>
          <button
            type="button"
            aria-label="Collapse sidebar"
            title="收起线程侧栏"
            onClick={() => toggleSidebar()}
            className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md border border-zinc-700/60 bg-zinc-900/60 text-zinc-400 transition-colors hover:border-cyan-300/50 hover:text-cyan-100"
          >
            <PanelCollapseRightIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-2 space-y-0.5">
          <button
            type="button"
            onClick={() => newThread()}
            title="Start a new chat"
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-cyan-100 transition-colors hover:bg-cyan-400/10"
          >
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-cyan-400/40 bg-cyan-400/10">
              <PlusIcon className="h-3 w-3" />
            </span>
            <span className="flex-1 font-medium">New chat</span>
          </button>
          <button
            type="button"
            onClick={openAgentWorkspace}
            title="打开 Agent 工作台（Overview / Permissions / MCP Servers / Skills / Connectors / Threads / Doctor / Logs）"
            className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-zinc-200 transition-colors hover:bg-zinc-800/60"
          >
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-zinc-400">
              <LayoutDashboardIcon className="h-3.5 w-3.5" />
            </span>
            <span className="flex-1">Agent 工作台</span>
            <ArrowUpRightIcon className="h-3 w-3 text-zinc-500" />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto pb-2">
        <div>
          {threadListLoading && groups.length === 0 ? (
            <ThreadListSkeleton />
          ) : groups.length === 0 ? (
            searching ? (
              <NoSearchMatches query={query} />
            ) : (
              <EmptyThreadList />
            )
          ) : (
            groups.map((group) => (
              <ThreadGroupSection
                key={group.label}
                group={group}
                // A search already narrows the list; folding on top of it hides hits.
                foldAt={searching ? Number.POSITIVE_INFINITY : GROUP_FOLD_AT}
                activeThreadId={threadId}
                runningByThread={runningByThread}
                onSwitch={switchThread}
                onRename={renameThread}
                onDelete={deleteThread}
                onSetPinned={setThreadPinned}
                onSetMemoryMode={setThreadMemoryMode}
                memoriesGloballyEnabled={memoriesGloballyEnabled}
              />
            ))
          )}
        </div>
        <CodexSessionsSection
          sessions={codexThreadList}
          loading={codexThreadListLoading}
          onFork={forkCodexThread}
        />
      </div>
    </aside>
  )
}

function EmptyThreadList(): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <ChatBubbleIcon className="h-7 w-7 text-zinc-600" />
      <p className="text-[12px] text-zinc-400">No threads yet.</p>
      <p className="text-[11px] leading-relaxed text-zinc-500">
        Start a new chat to ask the agent anything.
      </p>
    </div>
  )
}

function NoSearchMatches({ query }: { query: string }): JSX.Element {
  return (
    <div className="px-4 py-8 text-center text-[11px] text-zinc-500">
      没有标题包含「{query.trim()}」的线程
    </div>
  )
}

function ThreadListSkeleton(): JSX.Element {
  return (
    <div className="space-y-1.5 px-2 pt-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-9 animate-pulse rounded-md bg-zinc-800/60" />
      ))}
    </div>
  )
}

interface CodexSessionsSectionProps {
  sessions: CodexThreadSummary[]
  loading: boolean
  onFork: (threadId: string) => Promise<void> | void
}

function CodexSessionsSection(props: CodexSessionsSectionProps): JSX.Element | null {
  if (!props.loading && props.sessions.length === 0) return null
  return (
    <section className="mt-2 border-t border-zinc-800/80 py-2">
      <h3 className="px-3 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.24em] text-zinc-500">
        Codex Sessions
      </h3>
      {props.loading && props.sessions.length === 0 ? (
        <div className="px-3 py-2 text-[11px] text-zinc-500">Loading Codex sessions...</div>
      ) : (
        <ul className="space-y-1 px-2">
          {props.sessions.map((session) => (
            <li
              key={session.id}
              className="rounded-md border border-zinc-800/70 bg-black/20 px-2 py-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[12px] text-zinc-200" title={session.title}>
                    {session.title}
                  </div>
                  <div className="truncate text-[10px] text-zinc-500" title={session.cwd ?? session.model ?? ''}>
                    {session.cwd ?? session.model ?? 'Codex-owned history'}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`Fork Codex session ${session.title}`}
                  onClick={() => void props.onFork(session.id)}
                  className="shrink-0 cursor-pointer rounded border border-cyan-400/20 px-2 py-0.5 text-[11px] text-cyan-100 transition-colors hover:border-cyan-300/50 hover:bg-cyan-400/10"
                >
                  Fork
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

interface ThreadGroupSectionProps {
  group: ThreadGroup
  /** Rows shown before the fold; `Infinity` disables folding. */
  foldAt: number
  activeThreadId: string | undefined
  runningByThread: Record<string, boolean>
  onSwitch: (id: string) => Promise<void> | void
  onRename: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onSetPinned: (id: string, pinned: boolean) => Promise<void>
  onSetMemoryMode: (
    id: string,
    mode: 'enabled' | 'disabled',
  ) => Promise<{ ok: boolean; error?: string }>
  memoriesGloballyEnabled?: boolean
}

function ThreadGroupSection(props: ThreadGroupSectionProps): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const total = props.group.threads.length
  const folded = !expanded && total > props.foldAt
  const visible = folded ? props.group.threads.slice(0, props.foldAt) : props.group.threads
  const hidden = total - visible.length
  const pinnedGroup = props.group.label === 'Pinned'

  return (
    <section>
      <h3 className="flex items-center justify-between px-3.5 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.24em] text-zinc-500">
        <span className="flex items-center gap-1.5">
          {pinnedGroup ? <PinIcon className="h-3 w-3 rotate-45 text-cyan-300/70" /> : null}
          <span>{props.group.label}</span>
        </span>
        <span className="font-mono text-[10px] tabular-nums normal-case tracking-normal text-zinc-600">{total}</span>
      </h3>
      <ul className="space-y-0.5 px-1.5 pb-1">
        {visible.map((t) => (
          <ThreadRow
            key={t.id}
            thread={t}
            active={t.id === props.activeThreadId}
            running={props.runningByThread[t.id] ?? false}
            onSwitch={props.onSwitch}
            onRename={props.onRename}
            onDelete={props.onDelete}
            onSetPinned={props.onSetPinned}
            onSetMemoryMode={props.onSetMemoryMode}
            memoriesGloballyEnabled={props.memoriesGloballyEnabled}
          />
        ))}
      </ul>
      {folded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mx-1.5 mb-1 flex w-[calc(100%-12px)] cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] text-zinc-500 transition-colors hover:bg-zinc-800/60 hover:text-zinc-300"
        >
          <span className="inline-flex h-4 w-4 items-center justify-center">
            <MoreIcon className="h-3.5 w-3.5" />
          </span>
          <span>更多</span>
          <span className="font-mono text-[10px] tabular-nums text-zinc-600">+{hidden}</span>
        </button>
      ) : null}
    </section>
  )
}

interface ThreadRowProps {
  thread: AgentThreadSummary
  active: boolean
  /** Whether THIS thread has a turn streaming (active or in the background). */
  running: boolean
  onSwitch: (id: string) => Promise<void> | void
  onRename: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onSetPinned: (id: string, pinned: boolean) => Promise<void>
  onSetMemoryMode: (
    id: string,
    mode: 'enabled' | 'disabled',
  ) => Promise<{ ok: boolean; error?: string }>
  /** Global `features.memories`; undefined until session status is read. */
  memoriesGloballyEnabled?: boolean
}

type RowMode = 'idle' | 'menu' | 'rename' | 'confirm-delete'

function ThreadRow(props: ThreadRowProps): JSX.Element {
  const [mode, setMode] = useState<RowMode>('idle')
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const [draftTitle, setDraftTitle] = useState(props.thread.title)
  const [memoryBusy, setMemoryBusy] = useState(false)
  const [memoryError, setMemoryError] = useState<string | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)

  const pinned = isThreadPinned(props.thread)

  const startRename = useCallback(() => {
    setDraftTitle(props.thread.title)
    setMode('rename')
    requestAnimationFrame(() => inputRef.current?.select())
  }, [props.thread.title])

  const commitRename = useCallback(async () => {
    const next = draftTitle.trim()
    setMode('idle')
    if (!next || next === props.thread.title) return
    await props.onRename(props.thread.id, next)
  }, [draftTitle, props])

  const togglePinned = useCallback(async () => {
    setMode('idle')
    await props.onSetPinned(props.thread.id, !pinned)
  }, [pinned, props])

  // Absent memoryMode means "never chosen", and codex remembers by default —
  // so an unchosen thread reads as remembering.
  const memoryOn = props.thread.memoryMode !== 'disabled'

  const toggleMemory = useCallback(async () => {
    setMemoryError(undefined)
    setMemoryBusy(true)
    const res = await props.onSetMemoryMode(props.thread.id, memoryOn ? 'disabled' : 'enabled')
    setMemoryBusy(false)
    // Failures keep the menu open so the reason is readable; success closes it.
    if (!res.ok) setMemoryError(res.error ?? '设置失败')
    else setMode('idle')
  }, [memoryOn, props])

  // Close the popover menu on outside click — using mousedown so we close
  // before any other onClick on the page fires (matches ContextPopover's
  // approach and avoids the re-open race we hit on the token meter).
  useEffect(() => {
    if (mode !== 'menu') return undefined
    function onMouseDown(e: MouseEvent): void {
      const target = e.target as Node | null
      if (menuRef.current && target && !menuRef.current.contains(target)) {
        setMode('idle')
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [mode])

  useEffect(() => {
    if (mode !== 'menu') return undefined
    function syncMenuPosition(): void {
      const rect = menuButtonRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = 190
      const viewportWidth = Number.isFinite(window.innerWidth) && window.innerWidth > 0 ? window.innerWidth : 1024
      const viewportHeight = Number.isFinite(window.innerHeight) && window.innerHeight > 0 ? window.innerHeight : 768
      const left = Math.max(8, Math.min(viewportWidth - width - 8, rect.right - width))
      const top = Math.max(8, Math.min(viewportHeight - 190, rect.bottom + 4))
      setMenuPos({ top, left })
    }
    syncMenuPosition()
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('scroll', syncMenuPosition, true)
      window.addEventListener('resize', syncMenuPosition)
    }
    return () => {
      if (typeof window.removeEventListener === 'function') {
        window.removeEventListener('scroll', syncMenuPosition, true)
        window.removeEventListener('resize', syncMenuPosition)
      }
    }
  }, [mode])

  if (mode === 'rename') {
    return (
      <li className="px-1">
        <input
          ref={inputRef}
          aria-label="Rename thread"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void commitRename()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setMode('idle')
            }
          }}
          className="w-full rounded-md border border-cyan-400/40 bg-black/60 px-2 py-1.5 text-[12px] text-zinc-100 outline-none ring-2 ring-cyan-400/20 focus:border-cyan-300 focus:ring-cyan-400/40"
          autoFocus
        />
      </li>
    )
  }

  if (mode === 'confirm-delete') {
    return (
      <li
        className="px-1"
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative z-[80] flex items-center justify-between gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-100">
          <span className="truncate" title={props.thread.title}>
            Delete &quot;{props.thread.title}&quot;?
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setMode('idle')}
              className="cursor-pointer rounded px-2 py-0.5 text-zinc-300 transition-colors hover:bg-zinc-800/60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={async () => {
                setMode('idle')
                await props.onDelete(props.thread.id)
              }}
              className="cursor-pointer rounded bg-red-500/30 px-2 py-0.5 font-medium text-red-50 transition-colors hover:bg-red-500/50"
            >
              Delete
            </button>
          </span>
        </div>
      </li>
    )
  }

  const actionsVisible = mode === 'menu'

  return (
    <li className="group relative">
      <div
        className={[
          'flex items-stretch overflow-hidden rounded-md transition-colors duration-150',
          props.active ? 'bg-cyan-500/10 ring-1 ring-cyan-400/25' : 'hover:bg-zinc-800/60',
        ].join(' ')}
      >
        <span
          aria-hidden="true"
          className={[
            'w-[3px] shrink-0 rounded-full transition-colors duration-200',
            props.active ? 'bg-cyan-400' : 'bg-transparent',
          ].join(' ')}
        />
        <button
          type="button"
          onClick={() => {
            if (props.active) return
            void props.onSwitch(props.thread.id)
          }}
          onDoubleClick={() => startRename()}
          title={props.thread.title}
          className={[
            'flex min-w-0 flex-1 cursor-pointer items-start gap-2 px-2 py-1.5 text-left text-[12px] transition-colors',
            props.active ? 'text-cyan-100' : 'text-zinc-200',
          ].join(' ')}
        >
          <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center">
            {props.running ? (
              <span
                aria-label="Running"
                title="正在运行（可切走，不会中断）"
                className="inline-flex h-4 w-4 items-center justify-center text-cyan-300"
              >
                <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
              </span>
            ) : (
              <CircleCheckIcon className="h-3.5 w-3.5 text-zinc-600" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate">{props.thread.title}</span>
            <span
              className={[
                'mt-0.5 block truncate text-[10px]',
                props.running ? 'text-cyan-300/80' : 'text-zinc-500',
              ].join(' ')}
            >
              {threadSubline(props.thread, props.running)}
            </span>
          </span>
        </button>
        <span
          className={[
            'flex shrink-0 items-center gap-0.5 pr-1.5 transition-opacity duration-150',
            actionsVisible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
          ].join(' ')}
        >
          <button
            type="button"
            data-testid={`thread-pin-${props.thread.id}`}
            aria-label={pinned ? `Unpin thread ${props.thread.title}` : `Pin thread ${props.thread.title}`}
            aria-pressed={pinned}
            title={pinned ? '取消置顶' : '置顶'}
            onClick={(e) => {
              e.stopPropagation()
              void togglePinned()
            }}
            className={[
              'inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded transition-colors',
              pinned ? 'text-cyan-300 hover:bg-zinc-700/60' : 'text-zinc-500 hover:bg-zinc-700/60 hover:text-zinc-100',
            ].join(' ')}
          >
            <PinIcon className="h-3.5 w-3.5 rotate-45" />
          </button>
          <button
            ref={menuButtonRef}
            type="button"
            data-testid={`thread-menu-${props.thread.id}`}
            aria-label={`Thread actions for ${props.thread.title}`}
            aria-haspopup="menu"
            aria-expanded={mode === 'menu'}
            onClick={(e) => {
              e.stopPropagation()
              if (mode === 'menu') {
                setMode('idle')
                return
              }
              const rect = e.currentTarget.getBoundingClientRect()
              const width = 190
              const viewportWidth = Number.isFinite(window.innerWidth) && window.innerWidth > 0 ? window.innerWidth : 1024
              const viewportHeight = Number.isFinite(window.innerHeight) && window.innerHeight > 0 ? window.innerHeight : 768
              setMenuPos({
                top: Math.max(8, Math.min(viewportHeight - 190, rect.bottom + 4)),
                left: Math.max(8, Math.min(viewportWidth - width - 8, rect.right - width)),
              })
              setMode('menu')
            }}
            className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-700/60 hover:text-zinc-100 aria-expanded:bg-zinc-700/60 aria-expanded:text-zinc-100"
          >
            <MoreIcon className="h-3.5 w-3.5" />
          </button>
        </span>
        {/* Resting pin marker: pinned rows show a faint pin where the hover
            actions will appear, so pinned state reads without hovering. */}
        {pinned && !actionsVisible ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-2 text-cyan-300/60 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
          >
            <PinIcon className="h-3 w-3 rotate-45" />
          </span>
        ) : null}
      </div>
      {mode === 'menu' && menuPos ? createPortal(
        <>
          {/*
            Pointer shield: menu actions used to "click through" into the app
            behind the sidebar when the menu closed during the same pointer
            gesture. A fixed transparent shield consumes all outside pointer /
            mouse / click events first, so the underlying UI never receives
            them. The menu itself sits one z-layer above this shield.
          */}
          <div
            aria-hidden="true"
            data-testid={`thread-menu-shield-${props.thread.id}`}
            className="fixed inset-0 z-[99998] cursor-default"
            onPointerDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setMode('idle')
            }}
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
          />
          <div
            ref={menuRef}
            role="menu"
            style={{ top: menuPos.top, left: menuPos.left }}
            onPointerDownCapture={(e) => {
              e.stopPropagation()
            }}
            onMouseDownCapture={(e) => {
              e.stopPropagation()
            }}
            className="fixed z-[99999] min-w-[190px] overflow-hidden rounded-md border border-zinc-700 bg-zinc-950 py-1 text-[12px] text-zinc-200 shadow-[0_18px_60px_rgba(0,0,0,0.65)] ring-1 ring-cyan-400/20"
          >
            <button
              role="menuitem"
              type="button"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                void togglePinned()
              }}
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-zinc-800/60"
            >
              <PinIcon className="h-3.5 w-3.5 rotate-45" />
              {pinned ? '取消置顶' : '置顶'}
            </button>
            <button
              role="menuitem"
              type="button"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setMode('idle')
                startRename()
              }}
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-zinc-800/60"
            >
              <PencilIcon className="h-3.5 w-3.5" />
              Rename
            </button>
            <button
              role="menuitemcheckbox"
              type="button"
              aria-checked={memoryOn}
              data-testid={`thread-memory-toggle-${props.thread.id}`}
              disabled={memoryBusy || props.memoriesGloballyEnabled === false}
              title={
                props.memoriesGloballyEnabled === false
                  ? '记忆功能已全局关闭（设置 → Codex 权限）'
                  : memoryOn
                    ? '这个会话会写入跨会话记忆'
                    : '这个会话不会写入跨会话记忆'
              }
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                void toggleMemory()
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-zinc-800/60 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <BrainIcon className="h-3.5 w-3.5" />
              <span className="flex-1">记忆此会话</span>
              <span aria-hidden="true" className="text-[10px] text-cyan-300">
                {memoryBusy ? '…' : memoryOn ? '✓' : ''}
              </span>
            </button>
            {props.memoriesGloballyEnabled === false ? (
              <p className="px-3 pb-1 text-[10px] leading-tight text-zinc-500">
                记忆功能已全局关闭
              </p>
            ) : null}
            {memoryError ? (
              <p role="alert" className="px-3 pb-1 text-[10px] leading-tight text-red-300">
                {memoryError}
              </p>
            ) : null}
            <div className="my-1 border-t border-zinc-800" />
            <button
              role="menuitem"
              type="button"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setMode('confirm-delete')
              }}
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-red-300 transition-colors hover:bg-red-500/15"
            >
              <TrashIcon className="h-3.5 w-3.5" />
              Delete
            </button>
          </div>
        </>,
        document.body,
      ) : null}
    </li>
  )
}

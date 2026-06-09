import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { AgentThreadSummary, CodexThreadSummary } from '../../../../types/agent'
import { ChatBubbleIcon, MoreIcon, PencilIcon, PlusIcon, TrashIcon } from './icons'
import { formatRelativeTime, groupThreadsByRecency, type ThreadGroup } from './relativeTime'
import { useAgentChatStore } from './store'

/**
 * Right-edge thread sidebar. Pinned to `right: 0` so it sits flush against the
 * screen edge — the chat panel offsets its own `right` by `sidebarWidth` to
 * make room. When `sidebarOpen` is false the component returns null and the
 * panel slides over to `right: 0` for a true full collapse (no rail residue).
 *
 * Owned by AgentChatPanel: it is only mounted while the panel itself is open,
 * so closing the panel takes the sidebar with it.
 */
export function ThreadSidebar(): JSX.Element | null {
  const sidebarOpen = useAgentChatStore((s) => s.sidebarOpen)
  const sidebarWidth = useAgentChatStore((s) => s.sidebarWidth)
  const setSidebarWidth = useAgentChatStore((s) => s.setSidebarWidth)
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
  const forkCodexThread = useAgentChatStore((s) => s.forkCodexThread)

  const groups: ThreadGroup[] = useMemo(() => groupThreadsByRecency(threadList), [threadList])

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
      <header className="flex items-center justify-between gap-2 border-b border-zinc-800/80 px-3 py-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.32em] text-cyan-300/70">
          Threads
        </span>
        <button
          type="button"
          onClick={() => newThread()}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-2 py-1 text-[11px] font-medium text-cyan-100 transition-colors duration-200 hover:border-cyan-300/60 hover:bg-cyan-400/20"
          title="Start a new chat"
        >
          <PlusIcon className="h-3.5 w-3.5" />
          New chat
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div>
          {threadListLoading && groups.length === 0 ? (
            <ThreadListSkeleton />
          ) : groups.length === 0 ? (
            <EmptyThreadList />
          ) : (
            groups.map((group) => (
              <ThreadGroupSection
                key={group.label}
                group={group}
                activeThreadId={threadId}
                runningByThread={runningByThread}
                onSwitch={switchThread}
                onRename={renameThread}
                onDelete={deleteThread}
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

function ThreadListSkeleton(): JSX.Element {
  return (
    <div className="space-y-1.5 px-2 pt-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-7 animate-pulse rounded-md bg-zinc-800/60" />
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
    <section className="border-t border-zinc-800/80 py-2">
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
  activeThreadId: string | undefined
  runningByThread: Record<string, boolean>
  onSwitch: (id: string) => Promise<void> | void
  onRename: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

function ThreadGroupSection(props: ThreadGroupSectionProps): JSX.Element {
  return (
    <section>
      <h3 className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.24em] text-zinc-500">
        {props.group.label}
      </h3>
      <ul className="px-1 pb-2">
        {props.group.threads.map((t) => (
          <ThreadRow
            key={t.id}
            thread={t}
            active={t.id === props.activeThreadId}
            running={props.runningByThread[t.id] ?? false}
            onSwitch={props.onSwitch}
            onRename={props.onRename}
            onDelete={props.onDelete}
          />
        ))}
      </ul>
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
}

type RowMode = 'idle' | 'menu' | 'rename' | 'confirm-delete'

function ThreadRow(props: ThreadRowProps): JSX.Element {
  const [mode, setMode] = useState<RowMode>('idle')
  const [draftTitle, setDraftTitle] = useState(props.thread.title)
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

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
      <li className="px-1">
        <div className="flex items-center justify-between gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-100">
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

  return (
    <li className="group relative px-1">
      <div
        className={[
          'flex items-stretch overflow-hidden rounded-md transition-colors duration-150',
          props.active ? 'bg-cyan-500/10' : 'hover:bg-zinc-800/60',
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
            'flex flex-1 items-center justify-between gap-2 px-2 py-1.5 text-left text-[12px] transition-colors cursor-pointer',
            props.active ? 'text-cyan-100' : 'text-zinc-200',
          ].join(' ')}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {props.running ? (
              <span
                aria-label="Running"
                title="正在运行（可切走，不会中断）"
                className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-cyan-400"
              />
            ) : null}
            <span className="truncate">{props.thread.title}</span>
          </span>
          <span className="shrink-0 text-[10px] text-zinc-500">
            {formatRelativeTime(props.thread.lastMessageAt)}
          </span>
        </button>
        <button
          type="button"
          data-testid={`thread-menu-${props.thread.id}`}
          aria-label={`Thread actions for ${props.thread.title}`}
          aria-haspopup="menu"
          aria-expanded={mode === 'menu'}
          onClick={(e) => {
            e.stopPropagation()
            setMode((m) => (m === 'menu' ? 'idle' : 'menu'))
          }}
          className="flex w-7 cursor-pointer items-center justify-center text-zinc-500 opacity-0 transition-opacity duration-150 hover:text-zinc-100 group-hover:opacity-100 aria-expanded:opacity-100"
        >
          <MoreIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      {mode === 'menu' ? (
        <div
          ref={menuRef}
          role="menu"
          className="absolute right-2 top-full z-10 mt-1 min-w-[140px] overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/98 py-1 text-[12px] text-zinc-200 shadow-2xl ring-1 ring-black/40"
        >
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setMode('idle')
              startRename()
            }}
            className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-zinc-800/60"
          >
            <PencilIcon className="h-3.5 w-3.5" />
            Rename
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => setMode('confirm-delete')}
            className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-red-300 transition-colors hover:bg-red-500/15"
          >
            <TrashIcon className="h-3.5 w-3.5" />
            Delete
          </button>
        </div>
      ) : null}
    </li>
  )
}

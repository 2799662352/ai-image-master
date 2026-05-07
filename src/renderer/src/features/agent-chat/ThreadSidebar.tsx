import { useCallback, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { AgentThreadSummary } from '../../../../types/agent'
import { formatRelativeTime, groupThreadsByRecency, type ThreadGroup } from './relativeTime'
import { useAgentChatStore } from './store'

const RAIL_WIDTH = 24

/**
 * Right-edge thread sidebar. Pinned to `right: 0` so it always sits on the
 * screen edge — the chat panel is responsible for offsetting its own `right`
 * by `sidebarWidth` (or RAIL_WIDTH when collapsed) to make room.
 *
 * Renders nothing at all when `sidebarOpen` is false; the parent can show a
 * 24px rail with an expand button instead.
 */
export function ThreadSidebar(): JSX.Element | null {
  const sidebarOpen = useAgentChatStore((s) => s.sidebarOpen)
  const sidebarWidth = useAgentChatStore((s) => s.sidebarWidth)
  const threadList = useAgentChatStore((s) => s.threadList)
  const isRunning = useAgentChatStore((s) => s.isRunning)
  const threadId = useAgentChatStore((s) => s.threadId)
  const newThread = useAgentChatStore((s) => s.newThread)
  const switchThread = useAgentChatStore((s) => s.switchThread)
  const renameThread = useAgentChatStore((s) => s.renameThread)
  const deleteThread = useAgentChatStore((s) => s.deleteThread)
  const toggleSidebar = useAgentChatStore((s) => s.toggleSidebar)

  const groups: ThreadGroup[] = useMemo(() => groupThreadsByRecency(threadList), [threadList])

  if (!sidebarOpen) return null

  return (
    <aside
      data-testid="thread-sidebar"
      className="fixed top-0 right-0 z-[40000] flex h-screen flex-col border-l border-zinc-800/80 bg-zinc-950/95 text-zinc-200 backdrop-blur"
      style={{ width: sidebarWidth }}
    >
      <header className="flex items-center justify-between border-b border-zinc-800/80 px-3 py-2">
        <span className="text-[10px] uppercase tracking-[0.32em] text-cyan-300/70">Threads</span>
        <button
          type="button"
          onClick={() => newThread()}
          className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-[11px] text-cyan-100 hover:border-cyan-300/60 hover:bg-cyan-400/20"
          title="Start a new chat"
        >
          + New chat
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <p className="px-3 py-6 text-center text-[11px] text-zinc-500">No threads yet.</p>
        ) : (
          groups.map((group) => (
            <ThreadGroupSection
              key={group.label}
              group={group}
              activeThreadId={threadId}
              isRunning={isRunning}
              onSwitch={switchThread}
              onRename={renameThread}
              onDelete={deleteThread}
            />
          ))
        )}
      </div>

      <footer className="border-t border-zinc-800/80 px-3 py-2">
        <button
          type="button"
          onClick={() => toggleSidebar()}
          className="text-[10px] text-zinc-500 hover:text-zinc-200"
          aria-label="Collapse sidebar"
        >
          ▶ collapse ({RAIL_WIDTH}px rail)
        </button>
      </footer>
    </aside>
  )
}

interface ThreadGroupSectionProps {
  group: ThreadGroup
  activeThreadId: string | undefined
  isRunning: boolean
  onSwitch: (id: string) => Promise<void> | void
  onRename: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

function ThreadGroupSection(props: ThreadGroupSectionProps): JSX.Element {
  return (
    <section>
      <h3 className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-[0.24em] text-zinc-500">
        {props.group.label}
      </h3>
      <ul className="px-1 pb-2">
        {props.group.threads.map((t) => (
          <ThreadRow
            key={t.id}
            thread={t}
            active={t.id === props.activeThreadId}
            isRunning={props.isRunning}
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
  isRunning: boolean
  onSwitch: (id: string) => Promise<void> | void
  onRename: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

type RowMode = 'idle' | 'menu' | 'rename' | 'confirm-delete'

function ThreadRow(props: ThreadRowProps): JSX.Element {
  const [mode, setMode] = useState<RowMode>('idle')
  const [draftTitle, setDraftTitle] = useState(props.thread.title)
  const inputRef = useRef<HTMLInputElement>(null)

  const disabled = props.isRunning && !props.active

  const startRename = useCallback(() => {
    setDraftTitle(props.thread.title)
    setMode('rename')
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [props.thread.title])

  const commitRename = useCallback(async () => {
    const next = draftTitle.trim()
    setMode('idle')
    if (!next || next === props.thread.title) return
    await props.onRename(props.thread.id, next)
  }, [draftTitle, props])

  return (
    <li className="group relative">
      {mode === 'rename' ? (
        <div className="flex items-center gap-1 px-2 py-1.5">
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
            className="w-full rounded border border-cyan-400/40 bg-black/40 px-2 py-1 text-[12px] text-zinc-100 outline-none"
          />
        </div>
      ) : mode === 'confirm-delete' ? (
        <div className="flex items-center justify-between gap-1 px-2 py-1.5 text-[11px] text-red-200">
          <span className="truncate">Delete &quot;{props.thread.title}&quot;?</span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setMode('idle')}
              className="rounded px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800/60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={async () => {
                setMode('idle')
                await props.onDelete(props.thread.id)
              }}
              className="rounded bg-red-500/20 px-1.5 py-0.5 text-red-100 hover:bg-red-500/40"
            >
              Delete
            </button>
          </span>
        </div>
      ) : (
        <div className="flex items-center">
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              if (props.active) return
              void props.onSwitch(props.thread.id)
            }}
            onDoubleClick={() => startRename()}
            title={props.thread.title}
            className={[
              'flex flex-1 items-center justify-between gap-2 px-2 py-1.5 text-left text-[12px] transition',
              props.active ? 'bg-cyan-500/10 text-cyan-100' : 'text-zinc-200 hover:bg-zinc-800/60',
              disabled ? 'cursor-not-allowed opacity-40' : '',
              props.active ? 'border-l-2 border-cyan-400' : '',
            ].join(' ')}
          >
            <span className="truncate">{props.thread.title}</span>
            <span className="shrink-0 text-[10px] text-zinc-500">
              {formatRelativeTime(props.thread.lastMessageAt)}
            </span>
          </button>
          <button
            type="button"
            data-testid={`thread-menu-${props.thread.id}`}
            aria-label={`Thread actions for ${props.thread.title}`}
            onClick={() => setMode((m) => (m === 'menu' ? 'idle' : 'menu'))}
            className="px-1.5 text-zinc-500 hover:text-zinc-200"
          >
            ⋯
          </button>
          {mode === 'menu' ? (
            <div
              role="menu"
              className="absolute right-1 top-full z-10 mt-1 min-w-[120px] rounded border border-zinc-800 bg-zinc-950/95 py-1 text-[12px] text-zinc-200 shadow-xl"
              onMouseLeave={() => setMode('idle')}
            >
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  setMode('idle')
                  startRename()
                }}
                className="block w-full px-3 py-1.5 text-left hover:bg-zinc-800/60"
              >
                Rename
              </button>
              <button
                role="menuitem"
                type="button"
                onClick={() => setMode('confirm-delete')}
                className="block w-full px-3 py-1.5 text-left text-red-300 hover:bg-zinc-800/60"
              >
                Delete
              </button>
            </div>
          ) : null}
        </div>
      )}
    </li>
  )
}

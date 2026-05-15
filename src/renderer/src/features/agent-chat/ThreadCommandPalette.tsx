import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { AgentThreadSummary } from '../../../../types/agent'
import { useAgentChatStore } from './store'

export function ThreadCommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [threads, setThreads] = useState<AgentThreadSummary[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const isRunning = useAgentChatStore((s) => s.isRunning)
  const currentThreadId = useAgentChatStore((s) => s.threadId)

  useEffect(() => {
    function onGlobalKeyDown(e: globalThis.KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    document.addEventListener('keydown', onGlobalKeyDown)
    return () => document.removeEventListener('keydown', onGlobalKeyDown)
  }, [])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelectedIdx(0)
    const agent = (
      window as {
        electronAPI?: { agent?: { listThreads?: () => Promise<AgentThreadSummary[]> } }
      }
    ).electronAPI?.agent
    if (agent?.listThreads) {
      agent.listThreads().then((list) => setThreads(list)).catch(() => setThreads([]))
    }
    const id = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(id)
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return threads
    return threads.filter((t) => t.title.toLowerCase().includes(q))
  }, [query, threads])

  const handleSelect = useCallback(
    (threadId: string | null): void => {
      if (isRunning && threadId !== currentThreadId) return
      setOpen(false)
      if (threadId === null) {
        useAgentChatStore.getState().newThread()
      } else if (threadId !== currentThreadId) {
        void useAgentChatStore.getState().switchThread(threadId)
      }
    },
    [isRunning, currentThreadId],
  )

  const onListKeyDown = useCallback(
    (e: ReactKeyboardEvent): void => {
      const total = filtered.length + 1
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIdx((i) => Math.min(i + 1, total - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (selectedIdx === 0) handleSelect(null)
        else handleSelect(filtered[selectedIdx - 1]?.id ?? null)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    },
    [filtered, selectedIdx, handleSelect],
  )

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[49000] flex items-start justify-center pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[400px] overflow-hidden rounded-lg border border-cyan-400/25 bg-zinc-950/95 shadow-[0_24px_60px_rgba(0,0,0,0.7)] backdrop-blur"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onListKeyDown}
        role="presentation"
      >
        <div className="border-b border-zinc-800/80 p-2">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelectedIdx(0)
            }}
            placeholder="Search threads…"
            className="w-full rounded border border-zinc-800 bg-black/40 px-2 py-1.5 text-[12px] text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-cyan-400/40"
          />
        </div>
        <div className="max-h-[320px] overflow-y-auto py-1">
          <button
            type="button"
            disabled={isRunning}
            onClick={() => handleSelect(null)}
            className={[
              'flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition',
              selectedIdx === 0 ? 'bg-cyan-500/10 text-cyan-100' : 'text-zinc-300 hover:bg-zinc-800/60',
              isRunning ? 'cursor-not-allowed opacity-40' : '',
            ].join(' ')}
            title={isRunning ? 'Wait for the current turn to finish' : 'Create a new chat'}
          >
            ➕ New chat
          </button>
          {filtered.map((t, i) => {
            const idx = i + 1
            const isCurrent = t.id === currentThreadId
            const disabled = isRunning && !isCurrent
            return (
              <button
                key={t.id}
                type="button"
                disabled={disabled}
                onClick={() => handleSelect(t.id)}
                className={[
                  'flex w-full items-center justify-between px-3 py-1.5 text-left text-[12px] transition',
                  selectedIdx === idx ? 'bg-cyan-500/10 text-cyan-100' : 'text-zinc-200 hover:bg-zinc-800/60',
                  disabled ? 'cursor-not-allowed opacity-40' : '',
                  isCurrent ? 'border-l-2 border-cyan-400' : '',
                ].join(' ')}
                title={disabled ? 'Wait for the current turn to finish' : t.title}
              >
                <span className="truncate">{t.title}</span>
                <span className="text-[10px] text-zinc-500">
                  {new Date(t.updatedAt).toLocaleDateString()}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'

import type { CodexThreadDetail, CodexThreadSummary } from '../../../../types/agent'

type ThreadsApi = {
  agent?: {
    listCodexThreads?: () => Promise<CodexThreadSummary[]>
    readCodexThread?: (threadId: string) => Promise<CodexThreadDetail>
    forkCodexThread?: (threadId: string) => Promise<CodexThreadSummary>
  }
}

export function ThreadsSection(): React.JSX.Element {
  const [threads, setThreads] = useState<CodexThreadSummary[]>([])
  const [detail, setDetail] = useState<CodexThreadDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const mountedRef = useRef(false)
  const loadRequestIdRef = useRef(0)

  const loadThreads = useCallback(async () => {
    const requestId = loadRequestIdRef.current + 1
    loadRequestIdRef.current = requestId
    const canUpdate = () => mountedRef.current && requestId === loadRequestIdRef.current
    const api = getThreadsApi()
    if (!api?.listCodexThreads) {
      if (canUpdate()) {
        setError('Codex threads API is unavailable.')
        setLoading(false)
      }
      return
    }

    try {
      const nextThreads = await api.listCodexThreads()
      if (canUpdate()) {
        setThreads(nextThreads)
        setError(undefined)
        setLoading(false)
      }
    } catch (reason) {
      if (canUpdate()) {
        setError(errorMessage(reason))
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void loadThreads()

    return () => {
      mountedRef.current = false
    }
  }, [loadThreads])

  async function readThread(id: string): Promise<void> {
    const api = getThreadsApi()
    if (!api?.readCodexThread) {
      setError('Codex threads API is unavailable.')
      return
    }

    try {
      const nextDetail = await api.readCodexThread(id)
      if (mountedRef.current) {
        setDetail(nextDetail)
      }
    } catch (reason) {
      if (mountedRef.current) {
        setError(errorMessage(reason))
      }
    }
  }

  async function forkThread(id: string): Promise<void> {
    const api = getThreadsApi()
    if (!api?.forkCodexThread) {
      setError('Codex threads API is unavailable.')
      return
    }

    try {
      await api.forkCodexThread(id)
      if (mountedRef.current) {
        void loadThreads()
      }
    } catch (reason) {
      if (mountedRef.current) {
        setError(errorMessage(reason))
      }
    }
  }

  if (loading) {
    return (
      <section className="rounded-xl border border-cyan-400/15 bg-zinc-950/70 p-4 text-sm text-zinc-300">
        Loading threads...
      </section>
    )
  }

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)]">
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-cyan-100">Threads</h2>
          <p className="mt-1 text-sm text-zinc-500">Read and fork saved Codex threads.</p>
        </div>

        {error ? (
          <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-100">
            {error}
          </div>
        ) : null}

        {threads.length === 0 ? (
          <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/70 p-4 text-sm text-zinc-400">
            No Codex threads yet.
          </div>
        ) : (
          <div className="space-y-3">
            {threads.map((thread) => (
              <article key={thread.id} className="rounded-xl border border-cyan-400/15 bg-zinc-950/70 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-zinc-100">{thread.title || thread.id}</h3>
                    <p className="mt-1 text-xs text-zinc-500">{thread.updatedAt || 'No updated time'}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void readThread(thread.id)}
                      className="cursor-pointer rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors duration-200 hover:border-cyan-400/40 hover:text-cyan-100"
                    >
                      Read
                    </button>
                    <button
                      type="button"
                      onClick={() => void forkThread(thread.id)}
                      className="cursor-pointer rounded-md border border-cyan-400/30 px-3 py-1.5 text-sm text-cyan-100 transition-colors duration-200 hover:bg-cyan-500/10"
                    >
                      Fork
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <aside className="rounded-xl border border-cyan-400/15 bg-zinc-950/70 p-4">
        <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-500">Thread detail</h3>
        {detail ? (
          <div className="mt-3 space-y-3">
            <div>
              <div className="text-sm font-semibold text-zinc-100">{detail.title || detail.id}</div>
              <div className="text-xs text-zinc-500">{detail.updatedAt}</div>
            </div>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300">
              {JSON.stringify(detail, null, 2)}
            </pre>
          </div>
        ) : (
          <div className="mt-3 text-sm text-zinc-500">Select a thread to inspect messages.</div>
        )}
      </aside>
    </section>
  )
}

function getThreadsApi() {
  return (window as Window & { electronAPI?: ThreadsApi }).electronAPI?.agent
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

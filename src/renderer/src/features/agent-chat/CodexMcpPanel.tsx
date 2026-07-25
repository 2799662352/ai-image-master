import { useEffect, useState } from 'react'
import type { CodexMcpSummary } from '../../../../types/agent'
import { getAgentApi } from '../../utils/agentBridge'

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; summary: CodexMcpSummary }
  | { status: 'error'; error: string }

export function CodexMcpPanel() {
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    let alive = true
    const api = getAgentApi()
    if (!api?.getMcpSummary) {
      setState({ status: 'error', error: 'Codex MCP discovery API is unavailable' })
      return () => {
        alive = false
      }
    }

    setState({ status: 'loading' })
    void api.getMcpSummary()
      .then((summary) => {
        if (alive) setState({ status: 'loaded', summary })
      })
      .catch((err) => {
        if (alive) setState({ status: 'error', error: err instanceof Error ? err.message : String(err) })
      })

    return () => {
      alive = false
    }
  }, [])

  return (
    <section className="rounded-xl border border-cyan-400/15 bg-zinc-950/70 p-3 text-[12px] text-zinc-200">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold text-cyan-100">MCP servers</h3>
          <p className="mt-0.5 text-[11px] text-zinc-500">Displays Codex config only.</p>
        </div>
      </div>

      {state.status === 'loading' ? (
        <p className="text-[11px] text-zinc-500">Loading Codex MCP servers...</p>
      ) : null}

      {state.status === 'error' ? (
        <p className="rounded-lg border border-red-400/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-100">
          {state.error}
        </p>
      ) : null}

      {state.status === 'loaded' && state.summary.servers.length === 0 ? (
        <p className="text-[11px] text-zinc-500">No Codex MCP servers found.</p>
      ) : null}

      {state.status === 'loaded' && state.summary.servers.length > 0 ? (
        <div className="space-y-2">
          {state.summary.servers.map((server) => (
            <article key={server.name} className="rounded-lg border border-zinc-800 bg-black/20 p-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-cyan-50">{server.name}</span>
                <Badge>{server.transport}</Badge>
                <Badge>{server.enabled ? 'enabled' : 'disabled'}</Badge>
                <Badge>{server.required ? 'required' : 'optional'}</Badge>
              </div>
              {server.command ? <RedactedDetail label="command" value={server.command} /> : null}
              {server.url ? <RedactedDetail label="url" value={server.url} /> : null}
            </article>
          ))}
        </div>
      ) : null}

      {state.status === 'loaded' && state.summary.warnings.length > 0 ? (
        <ul className="mt-2 space-y-1 text-[11px] text-amber-100">
          {state.summary.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function Badge({ children }: { children: string }) {
  return (
    <span className="rounded-md border border-zinc-700/70 bg-zinc-900/70 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] text-zinc-400">
      {children}
    </span>
  )
}

function RedactedDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-1.5">
      <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">{label}</span>
      <code className="mt-0.5 block truncate rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-300">
        {value}
      </code>
    </div>
  )
}

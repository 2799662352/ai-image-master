import { useEffect, useState } from 'react'
import type React from 'react'

import type { CodexAuditLogEntry } from '../../../../types/agent'

type LogsApi = {
  agent?: {
    getWorkspaceLogs?: (opts?: { limit?: number; sinceIso?: string }) => Promise<CodexAuditLogEntry[]>
  }
}

export function LogsSection(): React.JSX.Element {
  const [rows, setRows] = useState<CodexAuditLogEntry[]>([])
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    const api = getLogsApi()
    if (!api?.getWorkspaceLogs) {
      setError('Codex logs API is unavailable.')
      return
    }

    void api.getWorkspaceLogs({ limit: 200 }).then(
      (entries) => {
        if (!cancelled) {
          setRows(entries)
        }
      },
      (reason) => {
        if (!cancelled) {
          setError(errorMessage(reason))
        }
      },
    )

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-cyan-100">Audit logs</h2>
        <p className="mt-1 text-sm text-zinc-500">Recent Codex workspace configuration changes.</p>
      </div>

      {error ? (
        <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-100">
          {error}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-cyan-400/15 bg-zinc-950/70">
        <table className="w-full text-sm font-mono">
          <thead className="text-zinc-500">
            <tr>
              <th className="px-3 py-2 text-left">Time</th>
              <th className="px-3 py-2 text-left">Action</th>
              <th className="px-3 py-2 text-left">Scope</th>
              <th className="px-3 py-2 text-left">Name</th>
              <th className="px-3 py-2 text-left">OK</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.tsIso}-${row.action}-${index}`} className="border-t border-zinc-800/40">
                <td className="px-3 py-2 text-zinc-400">{row.tsIso}</td>
                <td className="px-3 py-2 text-zinc-200">{row.action}</td>
                <td className="px-3 py-2 text-zinc-300">{row.scope ?? ''}</td>
                <td className="px-3 py-2 text-zinc-300">{row.name ?? ''}</td>
                <td className="px-3 py-2">
                  {row.ok ? <span className="text-emerald-300">OK</span> : <span className="text-red-300">Failed</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? <div className="p-4 text-sm text-zinc-500">No audit entries yet.</div> : null}
      </div>
    </section>
  )
}

function getLogsApi() {
  return (window as Window & { electronAPI?: LogsApi }).electronAPI?.agent
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

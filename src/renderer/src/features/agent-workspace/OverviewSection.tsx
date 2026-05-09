import { useEffect, useState } from 'react'

type CodexRuntimeStatus = {
  sandboxMode: string
  approvalPolicy: string
  webSearch: string
  writableRoots: string[]
}

type AgentWorkspaceOverviewApi = {
  agent?: {
    getSessionStatus?: () => Promise<CodexRuntimeStatus>
    listMcp?: () => Promise<unknown[]>
    listSkills?: () => Promise<unknown[]>
  }
}

type OverviewState =
  | { status: 'loading' }
  | {
      status: 'loaded'
      sandboxMode: string
      approvalPolicy: string
      webSearch: string
      writableRootsCount: number
      mcpCount: number
      skillsCount: number
      warnings: string[]
    }

const UNAVAILABLE = 'Unavailable'

export function OverviewSection() {
  const [state, setState] = useState<OverviewState>({ status: 'loading' })

  useEffect(() => {
    let alive = true
    const api = (window as Window & { electronAPI?: AgentWorkspaceOverviewApi }).electronAPI?.agent

    async function loadOverview(): Promise<void> {
      const [sessionResult, mcpResult, skillsResult] = await Promise.allSettled([
        api?.getSessionStatus?.() ?? Promise.reject(new Error('Codex runtime status API is unavailable')),
        api?.listMcp?.() ?? Promise.reject(new Error('Codex MCP list API is unavailable')),
        api?.listSkills?.() ?? Promise.reject(new Error('Codex skills list API is unavailable')),
      ])

      if (!alive) return

      const warnings: string[] = []
      const runtime = sessionResult.status === 'fulfilled' ? sessionResult.value : undefined
      const mcp = mcpResult.status === 'fulfilled' && Array.isArray(mcpResult.value) ? mcpResult.value : []
      const skills =
        skillsResult.status === 'fulfilled' && Array.isArray(skillsResult.value) ? skillsResult.value : []

      if (sessionResult.status === 'rejected') warnings.push(errorMessage(sessionResult.reason))
      if (mcpResult.status === 'rejected') warnings.push(errorMessage(mcpResult.reason))
      if (skillsResult.status === 'rejected') warnings.push(errorMessage(skillsResult.reason))

      setState({
        status: 'loaded',
        sandboxMode: runtime?.sandboxMode ?? UNAVAILABLE,
        approvalPolicy: runtime?.approvalPolicy ?? UNAVAILABLE,
        webSearch: runtime?.webSearch ?? UNAVAILABLE,
        writableRootsCount: runtime?.writableRoots.length ?? 0,
        mcpCount: mcp.length,
        skillsCount: skills.length,
        warnings,
      })
    }

    void loadOverview()

    return () => {
      alive = false
    }
  }, [])

  if (state.status === 'loading') {
    return (
      <section className="rounded-xl border border-cyan-400/15 bg-zinc-950/70 p-4 text-sm text-zinc-300">
        Loading Codex runtime overview...
      </section>
    )
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-cyan-100">Codex runtime overview</h2>
        <p className="mt-1 text-sm text-zinc-500">Read-only status from the current Codex session.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="Sandbox" value={state.sandboxMode} />
        <StatCard label="Approval" value={state.approvalPolicy} />
        <StatCard label="Web search" value={state.webSearch} />
        <StatCard label="Writable roots" value={pluralize(state.writableRootsCount, 'writable root')} />
        <StatCard label="MCP servers" value={pluralize(state.mcpCount, 'MCP server')} />
        <StatCard label="Skills" value={pluralize(state.skillsCount, 'skill')} />
      </div>

      {state.warnings.length > 0 ? (
        <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-[12px] text-amber-100">
          <p className="font-medium">Some Codex overview details are unavailable.</p>
          <ul className="mt-2 space-y-1">
            {state.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="rounded-xl border border-cyan-400/15 bg-zinc-950/70 p-4">
      <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">{label}</p>
      <p className="mt-2 text-base font-semibold text-zinc-100">{value}</p>
    </article>
  )
}

function pluralize(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? '' : 's'}`
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

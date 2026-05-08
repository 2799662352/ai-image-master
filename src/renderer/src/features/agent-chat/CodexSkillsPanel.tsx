import { useEffect, useState } from 'react'
import type { CodexSkillsSummary } from '../../../../types/agent'
import { useAgentChatStore } from './store'

type CodexSkillsApi = {
  agent?: {
    getSkillsSummary?: () => Promise<CodexSkillsSummary>
  }
}

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; summary: CodexSkillsSummary }
  | { status: 'error'; error: string }

export function CodexSkillsPanel() {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const setInput = useAgentChatStore((store) => store.setInput)

  useEffect(() => {
    let alive = true
    const api = (window as Window & { electronAPI?: CodexSkillsApi }).electronAPI?.agent
    if (!api?.getSkillsSummary) {
      setState({ status: 'error', error: 'Codex skills discovery API is unavailable' })
      return () => {
        alive = false
      }
    }

    setState({ status: 'loading' })
    void api.getSkillsSummary()
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

  function insertSkill(name: string): void {
    const mention = `$${name}`
    const current = useAgentChatStore.getState().input.trimEnd()
    setInput(current ? `${current} ${mention}` : mention)
  }

  return (
    <section className="rounded-xl border border-cyan-400/15 bg-zinc-950/70 p-3 text-[12px] text-zinc-200">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold text-cyan-100">Skills</h3>
          <p className="mt-0.5 text-[11px] text-zinc-500">Displays .agents/skills only.</p>
        </div>
      </div>

      {state.status === 'loading' ? (
        <p className="text-[11px] text-zinc-500">Loading Codex skills...</p>
      ) : null}

      {state.status === 'error' ? (
        <p className="rounded-lg border border-red-400/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-100">
          {state.error}
        </p>
      ) : null}

      {state.status === 'loaded' && state.summary.skills.length === 0 ? (
        <p className="text-[11px] text-zinc-500">No Codex skills found.</p>
      ) : null}

      {state.status === 'loaded' && state.summary.skills.length > 0 ? (
        <div className="space-y-2">
          {state.summary.skills.map((skill) => (
            <article key={`${skill.scope}:${skill.name}`} className="rounded-lg border border-zinc-800 bg-black/20 p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium text-cyan-50">{skill.name}</span>
                    <span className="rounded-md border border-zinc-700/70 bg-zinc-900/70 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] text-zinc-400">
                      {skill.scope}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] text-zinc-400">
                    {skill.description || 'No description provided.'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => insertSkill(skill.name)}
                  className="shrink-0 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-2 py-1 text-[11px] font-medium text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/20"
                >
                  Insert ${skill.name}
                </button>
              </div>
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

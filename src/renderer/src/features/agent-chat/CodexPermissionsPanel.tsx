import { useEffect, useMemo, useState } from 'react'
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  CodexSessionConfig,
  CodexSessionStatus,
  CodexWebSearchMode,
} from '../../../../types/agent'

const SANDBOX_OPTIONS: CodexSandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']
const APPROVAL_OPTIONS: CodexApprovalPolicy[] = ['untrusted', 'on-request', 'never']
const WEB_SEARCH_OPTIONS: CodexWebSearchMode[] = ['cached', 'live', 'disabled']

interface CodexPermissionsPanelProps {
  status?: CodexSessionStatus
  onApply: (patch: Partial<CodexSessionConfig>) => Promise<void> | void
}

type Draft = Pick<CodexSessionConfig, 'sandboxMode' | 'approvalPolicy' | 'webSearch'>

export function CodexPermissionsPanel({ status, onApply }: CodexPermissionsPanelProps) {
  const [draft, setDraft] = useState<Draft | undefined>(() => statusToDraft(status))
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    setDraft(statusToDraft(status))
  }, [status])

  const patch = useMemo(() => {
    if (!status || !draft) return {}
    const next: Partial<CodexSessionConfig> = {}
    if (draft.sandboxMode !== status.sandboxMode) next.sandboxMode = draft.sandboxMode
    if (draft.approvalPolicy !== status.approvalPolicy) next.approvalPolicy = draft.approvalPolicy
    if (draft.webSearch !== status.webSearch) next.webSearch = draft.webSearch
    return next
  }, [draft, status])

  if (!status || !draft) {
    return (
      <div className="mt-3 rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-3 text-[12px] text-zinc-500">
        Codex permissions unavailable.
      </div>
    )
  }

  const changed = Object.keys(patch).length > 0
  const unsafe =
    draft.sandboxMode === 'danger-full-access' ||
    draft.approvalPolicy === 'never' ||
    draft.webSearch === 'live'

  async function apply(): Promise<void> {
    if (!changed) return
    setApplying(true)
    try {
      await onApply(patch)
    } finally {
      setApplying(false)
    }
  }

  return (
    <section className="mt-3 rounded-xl border border-cyan-400/15 bg-zinc-950/70 p-3 text-[12px] text-zinc-200">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold text-cyan-100">Codex permissions</h3>
          <p className="mt-0.5 text-[11px] text-zinc-500">Applied to future Codex turns.</p>
        </div>
        <button
          type="button"
          onClick={() => void apply()}
          disabled={!changed || applying}
          className="rounded-md border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1 text-[11px] font-medium text-cyan-100 transition hover:border-cyan-300/60 hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:border-zinc-700/60 disabled:bg-zinc-900 disabled:text-zinc-500"
        >
          Apply permissions
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <RadioGroup
          legend="Sandbox"
          value={draft.sandboxMode}
          options={SANDBOX_OPTIONS}
          onChange={(sandboxMode) => setDraft({ ...draft, sandboxMode })}
        />
        <RadioGroup
          legend="Approval"
          value={draft.approvalPolicy}
          options={APPROVAL_OPTIONS}
          onChange={(approvalPolicy) => setDraft({ ...draft, approvalPolicy })}
        />
        <RadioGroup
          legend="Web search"
          value={draft.webSearch}
          options={WEB_SEARCH_OPTIONS}
          onChange={(webSearch) => setDraft({ ...draft, webSearch })}
        />
      </div>

      {status.writableRoots.length > 0 ? (
        <div className="mt-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">Writable roots</div>
          <ul className="mt-1 space-y-1">
            {status.writableRoots.map((root) => (
              <li key={root} className="truncate rounded-md border border-zinc-800 bg-black/25 px-2 py-1 text-zinc-400">
                {root}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {unsafe ? (
        <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-100">
          Unsafe permission selected. The main process will ask for confirmation before applying.
        </div>
      ) : null}
    </section>
  )
}

function statusToDraft(status?: CodexSessionStatus): Draft | undefined {
  if (!status) return undefined
  return {
    sandboxMode: status.sandboxMode,
    approvalPolicy: status.approvalPolicy,
    webSearch: status.webSearch,
  }
}

function RadioGroup<T extends string>({
  legend,
  value,
  options,
  onChange,
}: {
  legend: string
  value: T
  options: readonly T[]
  onChange: (value: T) => void
}) {
  return (
    <fieldset className="rounded-lg border border-zinc-800/80 bg-black/20 p-2">
      <legend className="px-1 text-[11px] font-medium text-zinc-400">{legend}</legend>
      <div className="mt-1 space-y-1">
        {options.map((option) => (
          <label key={option} className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-300">
            <input
              type="radio"
              checked={value === option}
              onChange={() => onChange(option)}
              className="h-3 w-3 accent-cyan-300"
            />
            <span>{option}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

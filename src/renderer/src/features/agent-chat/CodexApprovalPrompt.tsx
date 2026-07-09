import { useRef, useState } from 'react'
import type { JSX } from 'react'
import type { CodexApprovalRequest, CodexApprovalResponse } from '../../../../types/agent'
import { useAutosizeTextarea } from '../../hooks/useAutosizeTextarea'

const SUMMARY_LIMIT = 800
const PREFERRED_VALUE_LIMIT = 180

interface CodexApprovalPromptProps {
  request: CodexApprovalRequest
  onRespond: (response: CodexApprovalResponse) => void | Promise<void>
}

/**
 * Dispatch table for the three typed approval requests codex's app-server
 * surfaces (per `app-server-protocol/src/protocol.rs`). Anything not in
 * this list falls back to the generic Approve/Deny prompt — which is also
 * what older codex builds emit, so this stays backwards-compatible.
 *
 * Visual language is intentionally distinct so the user can tell at a
 * glance whether they're authorizing a shell command, a file edit, or a
 * permission grant. Different verbs (Execute / Apply / Grant) make the
 * action concrete; same Approve color (emerald) signals "safe to proceed".
 */
type ApprovalKind = 'command' | 'fileChange' | 'permissions' | 'generic'

function classifyMethod(method: string): ApprovalKind {
  if (method === 'item/commandExecution/requestApproval') return 'command'
  if (method === 'item/fileChange/requestApproval') return 'fileChange'
  if (method === 'item/permissions/requestApproval') return 'permissions'
  return 'generic'
}

export function CodexApprovalPrompt({ request, onRespond }: CodexApprovalPromptProps) {
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const kind = classifyMethod(request.method)
  const messageRef = useRef<HTMLTextAreaElement>(null)
  useAutosizeTextarea(messageRef, message, { minRows: 2, maxRows: 10 })

  async function respond(approved: boolean): Promise<void> {
    setSubmitting(true)
    try {
      await onRespond({
        id: request.id,
        approved,
        ...(!approved && message.trim().length > 0 ? { message: message.trim() } : {}),
      })
    } finally {
      setSubmitting(false)
    }
  }

  const labels = labelsFor(kind)

  return (
    <section className="rounded-xl border border-amber-400/35 bg-amber-500/10 p-3 text-sm text-amber-50">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.28em] text-amber-200/70">{labels.tagline}</p>
          <h3 className="mt-1 truncate text-sm font-semibold text-amber-50">
            {labels.title ?? request.method}
          </h3>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void respond(false)}
            className="rounded-md border border-red-300/40 bg-red-500/15 px-2.5 py-1 text-xs font-medium text-red-100 transition hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {labels.deny}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void respond(true)}
            className="rounded-md border border-emerald-300/40 bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-100 transition hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {labels.approve}
          </button>
        </div>
      </div>

      <ApprovalDetails kind={kind} params={request.params} />

      <label className="mt-2 block text-xs text-amber-100/80">
        {labels.denialLabel}
        <textarea
          ref={messageRef}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Optional reason for denying this request"
          className="mt-1 w-full resize-none rounded-lg border border-amber-300/20 bg-black/30 p-2 text-xs text-amber-50 outline-none placeholder:text-amber-100/30 focus:border-amber-200/50 transition-[height] duration-100"
        />
      </label>
    </section>
  )
}

function labelsFor(kind: ApprovalKind): {
  tagline: string
  title?: string
  approve: string
  deny: string
  denialLabel: string
} {
  switch (kind) {
    case 'command':
      return {
        tagline: 'execute command',
        title: 'Run shell command',
        approve: 'Execute',
        deny: 'Block',
        denialLabel: 'Reason for blocking',
      }
    case 'fileChange':
      return {
        tagline: 'file change',
        title: 'Apply file changes',
        approve: 'Apply',
        deny: 'Reject',
        denialLabel: 'Reason for rejecting',
      }
    case 'permissions':
      return {
        tagline: 'grant permissions',
        title: 'Permissions request',
        approve: 'Grant',
        deny: 'Deny',
        denialLabel: 'Reason for denying',
      }
    case 'generic':
      return {
        tagline: 'approval required',
        approve: 'Approve',
        deny: 'Deny',
        denialLabel: 'Denial message',
      }
  }
}

function ApprovalDetails({
  kind,
  params,
}: {
  kind: ApprovalKind
  params: Record<string, unknown>
}): JSX.Element {
  if (kind === 'command') {
    const command = stringField(params, 'command')
    const cwd = stringField(params, 'cwd')
    return (
      <div className="mt-2 space-y-1">
        {command ? (
          <pre className="overflow-auto rounded-lg border border-amber-300/15 bg-black/40 p-2 font-mono text-xs leading-relaxed text-amber-50">
            {truncate(command, PREFERRED_VALUE_LIMIT * 4)}
          </pre>
        ) : null}
        {cwd ? (
          <p className="text-[11px] text-amber-100/70">
            <span className="opacity-60">cwd: </span>
            <span className="font-mono">{cwd}</span>
          </p>
        ) : null}
      </div>
    )
  }
  if (kind === 'fileChange') {
    const filePath = stringField(params, 'path')
    const changes = Array.isArray(params['changes']) ? (params['changes'] as unknown[]) : []
    return (
      <div className="mt-2 space-y-1">
        {filePath ? (
          <p className="text-[11px] text-amber-100">
            <span className="opacity-60">path: </span>
            <span className="font-mono">{filePath}</span>
          </p>
        ) : null}
        {changes.length > 0 ? (
          <p className="text-[11px] text-amber-100/70">
            {changes.length} change{changes.length === 1 ? '' : 's'} pending
          </p>
        ) : null}
      </div>
    )
  }
  if (kind === 'permissions') {
    const perms = Array.isArray(params['permissions'])
      ? (params['permissions'] as unknown[]).map((p) => (typeof p === 'string' ? p : safeStringify(p)))
      : []
    return (
      <ul className="mt-2 space-y-0.5 rounded-lg border border-amber-300/15 bg-black/25 p-2 text-xs text-amber-50/90">
        {perms.length === 0 ? (
          <li className="text-amber-100/60">(no permissions detail)</li>
        ) : (
          perms.map((p, idx) => (
            <li key={`${p}-${idx}`} className="font-mono">
              · {p}
            </li>
          ))
        )}
      </ul>
    )
  }
  // Generic fallback — same compact dump as the original component, kept
  // for unknown / older / custom approval methods.
  return (
    <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-amber-300/15 bg-black/25 p-2 text-xs leading-relaxed text-amber-50/90">
      {summarizeParams(params)}
    </pre>
  )
}

function stringField(params: Record<string, unknown>, key: string): string | null {
  const value = params[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function summarizeParams(params: Record<string, unknown>): string {
  const preferred = ['command', 'tool', 'skill', 'reason', 'cwd', 'path']
  const lines: string[] = []
  for (const key of preferred) {
    const value = params[key]
    if (typeof value === 'string' && value.length > 0) {
      lines.push(`${key}: ${truncate(value, PREFERRED_VALUE_LIMIT)}`)
    }
  }
  if (lines.length > 0) return truncate(lines.join('\n'), SUMMARY_LIMIT)
  try {
    const json = JSON.stringify(params, null, 2)
    return truncate(json, SUMMARY_LIMIT)
  } catch {
    return '[unavailable request details]'
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value
}

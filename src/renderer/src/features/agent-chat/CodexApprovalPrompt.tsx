import { useState } from 'react'
import type { CodexApprovalRequest, CodexApprovalResponse } from '../../../../types/agent'

const SUMMARY_LIMIT = 800
const PREFERRED_VALUE_LIMIT = 180

interface CodexApprovalPromptProps {
  request: CodexApprovalRequest
  onRespond: (response: CodexApprovalResponse) => void | Promise<void>
}

export function CodexApprovalPrompt({ request, onRespond }: CodexApprovalPromptProps) {
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)

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

  return (
    <section className="rounded-xl border border-amber-400/35 bg-amber-500/10 p-3 text-sm text-amber-50">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.28em] text-amber-200/70">approval required</p>
          <h3 className="mt-1 truncate text-sm font-semibold text-amber-50">{request.method}</h3>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void respond(false)}
            className="rounded-md border border-red-300/40 bg-red-500/15 px-2.5 py-1 text-xs font-medium text-red-100 transition hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Deny
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void respond(true)}
            className="rounded-md border border-emerald-300/40 bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-100 transition hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Approve
          </button>
        </div>
      </div>

      <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-amber-300/15 bg-black/25 p-2 text-xs leading-relaxed text-amber-50/90">
        {summarizeParams(request.params)}
      </pre>

      <label className="mt-2 block text-xs text-amber-100/80">
        Denial message
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Optional reason for denying this request"
          className="mt-1 min-h-16 w-full resize-y rounded-lg border border-amber-300/20 bg-black/30 p-2 text-xs text-amber-50 outline-none placeholder:text-amber-100/30 focus:border-amber-200/50"
        />
      </label>
    </section>
  )
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

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value
}

import type { AgentReference } from '../../../../types/agent-reference'

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return `Unable to render JSON: ${typeof value === 'object' ? '[object]' : String(value)}`
  }
}

export function JsonResourcePreview({ reference }: { reference: AgentReference }) {
  const value = reference.preview?.json ?? reference.preview?.summary ?? reference
  const text = safeStringify(value)

  return (
    <div className="h-full overflow-auto bg-zinc-950 p-3">
      <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-cyan-300/80">{reference.type}</div>
      <pre className="whitespace-pre-wrap break-words rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 font-mono text-xs text-zinc-200">
        {text}
      </pre>
    </div>
  )
}

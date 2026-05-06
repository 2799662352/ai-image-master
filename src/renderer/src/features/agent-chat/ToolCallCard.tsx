import type { AgentChatToolEvent } from './types'

export function ToolCallCard({ tool }: { tool: AgentChatToolEvent }) {
  const color = tool.status === 'error' ? 'border-red-400/30 text-red-200' : 'border-cyan-400/25 text-cyan-100'

  return (
    <div className={`mb-2 rounded-lg border bg-zinc-950/70 px-3 py-2 text-xs ${color}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono">{tool.name}</span>
        <span className="rounded-full bg-white/10 px-2 py-0.5 uppercase tracking-wide">{tool.status}</span>
      </div>
      {tool.error ? <p className="mt-1 text-red-200/90">{tool.error}</p> : null}
    </div>
  )
}

import type { JSX } from 'react'
import { Bot } from 'lucide-react'

import { useAgentChatStore } from '../features/agent-chat'
import { useTabStore } from '../stores'

const DEFAULT_SANDBOX = 'workspace-write'
const DEFAULT_APPROVAL_POLICY = 'on-request'

export function AgentStatusButton(): JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
      <button
        type="button"
        data-testid="agent-status-button"
        aria-label={`Toggle Codex chat panel, ${DEFAULT_SANDBOX}, ${DEFAULT_APPROVAL_POLICY}`}
        onClick={() => useAgentChatStore.getState().toggle()}
        className="inline-flex shrink-0 items-center gap-2 rounded-md border border-zinc-700/60 bg-zinc-900/60 px-3 py-1.5 text-xs font-mono text-zinc-200 transition-colors duration-200 hover:border-cyan-300/50 hover:bg-cyan-400/10 hover:text-cyan-100 cursor-pointer"
      >
        <Bot className="h-3.5 w-3.5" aria-hidden="true" />
        <span>
          Codex · {DEFAULT_SANDBOX} · {DEFAULT_APPROVAL_POLICY}
        </span>
      </button>
      <button
        type="button"
        onClick={() => useTabStore.getState().switchTab('agentWorkspace')}
        className="shrink-0 text-xs text-zinc-400 hover:text-cyan-200 cursor-pointer"
      >
        Open Workspace
      </button>
    </div>
  )
}

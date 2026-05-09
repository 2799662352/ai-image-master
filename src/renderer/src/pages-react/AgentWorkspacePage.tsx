import React from 'react'

import { AgentWorkspaceNav } from '../features/agent-workspace/AgentWorkspaceNav'
import { useAgentWorkspaceStore } from '../features/agent-workspace/useAgentWorkspaceStore'

export default function AgentWorkspacePage(): React.JSX.Element {
  const section = useAgentWorkspaceStore((state) => state.section)

  return (
    <div className="flex h-full w-full bg-slate-950 font-mono text-slate-100">
      <AgentWorkspaceNav />
      <main className="flex-1 overflow-y-auto p-6">
        {section === 'overview' && <div data-testid="section-overview">Overview placeholder</div>}
        {section === 'permissions' && (
          <div data-testid="section-permissions">Permissions placeholder</div>
        )}
        {section === 'mcp' && <div data-testid="section-mcp">MCP placeholder</div>}
        {section === 'skills' && <div data-testid="section-skills">Skills placeholder</div>}
        {section === 'threads' && <div data-testid="section-threads">Threads placeholder</div>}
        {section === 'logs' && <div data-testid="section-logs">Logs placeholder</div>}
      </main>
    </div>
  )
}

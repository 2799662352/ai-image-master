import type React from 'react'

import { useAgentWorkspaceStore } from './useAgentWorkspaceStore'
import type { WorkspaceSectionKey } from './useAgentWorkspaceStore'

const ITEMS: Array<{ key: WorkspaceSectionKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'permissions', label: 'Permissions' },
  { key: 'mcp', label: 'MCP Servers' },
  { key: 'skills', label: 'Skills' },
  { key: 'threads', label: 'Threads' },
  { key: 'logs', label: 'Logs' },
]

export function AgentWorkspaceNav(): React.JSX.Element {
  const section = useAgentWorkspaceStore((state) => state.section)
  const setSection = useAgentWorkspaceStore((state) => state.setSection)

  return (
    <nav className="flex min-w-[200px] flex-col gap-1 border-r border-zinc-800/60 bg-zinc-950/40 p-3">
      {ITEMS.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => setSection(item.key)}
          className={
            'cursor-pointer rounded-md px-3 py-2 text-left text-sm transition-colors duration-200 ' +
            (section === item.key
              ? 'bg-cyan-500/15 text-cyan-100'
              : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100')
          }
        >
          {item.label}
        </button>
      ))}
    </nav>
  )
}

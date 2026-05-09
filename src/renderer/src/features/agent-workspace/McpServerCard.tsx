import type React from 'react'

import { ToolChip } from './ToolChip'
import type { McpServerCard as McpServerCardData } from './useMcpStore'

interface McpServerCardProps {
  server: McpServerCardData
  onEdit: (name: string) => void
  onDelete: (name: string) => void
  onToggle: (name: string, enabled: boolean) => void
}

const STATUS_DOT: Record<string, string> = {
  ready: 'bg-green-400',
  starting: 'bg-yellow-400 animate-pulse',
  failed: 'bg-red-400',
  cancelled: 'bg-zinc-500',
  unknown: 'bg-zinc-600',
}

export function McpServerCard({ server, onEdit, onDelete, onToggle }: McpServerCardProps): React.JSX.Element {
  const dotColor = STATUS_DOT[server.status] ?? STATUS_DOT.unknown

  return (
    <div className="group rounded-lg border border-zinc-800/60 bg-zinc-900/60 p-4 transition-colors hover:border-zinc-700/80">
      {/* Header row */}
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dotColor}`} title={server.status} />
        <span className="flex-1 truncate text-sm font-medium text-zinc-100">{server.name}</span>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase text-zinc-400">
          {server.type}
        </span>
      </div>

      {/* Command / URL */}
      <p className="mt-1 truncate text-xs text-zinc-500">
        {server.type === 'http' ? server.url : [server.command, ...(server.args ?? [])].join(' ')}
      </p>

      {/* Error message */}
      {server.error && (
        <p className="mt-1 truncate text-xs text-red-400" title={server.error}>
          {server.error}
        </p>
      )}

      {/* Tool chips */}
      {server.tools.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {server.tools.map((tool) => (
            <ToolChip
              key={tool.name}
              serverName={server.name}
              toolName={tool.name}
              description={tool.description}
              disabled={tool.disabled}
            />
          ))}
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-3 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          onClick={() => onToggle(server.name, !server.enabled)}
          className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        >
          {server.enabled ? '禁用' : '启用'}
        </button>
        {!server.isBuiltin && (
          <>
            <button
              type="button"
              onClick={() => onEdit(server.name)}
              className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              编辑
            </button>
            <button
              type="button"
              onClick={() => onDelete(server.name)}
              className="rounded px-2 py-1 text-xs text-red-400/70 hover:bg-red-500/10 hover:text-red-300"
            >
              删除
            </button>
          </>
        )}
      </div>
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import type React from 'react'

import { McpServerCard } from './McpServerCard'
import { useMcpStore } from './useMcpStore'

interface McpServerListProps {
  onOpenEditor: (serverName?: string) => void
  onOpenImport: () => void
}

export function McpServerList({ onOpenEditor, onOpenImport }: McpServerListProps): React.JSX.Element {
  const servers = useMcpStore((s) => s.servers)
  const loading = useMcpStore((s) => s.loading)
  const error = useMcpStore((s) => s.error)
  const fetchServers = useMcpStore((s) => s.fetchServers)
  const toggleEnabled = useMcpStore((s) => s.toggleEnabled)
  const deleteServer = useMcpStore((s) => s.deleteServer)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  useEffect(() => {
    fetchServers()
  }, [fetchServers])

  const handleDelete = useCallback(
    async (name: string) => {
      if (confirmDelete === name) {
        await deleteServer(name)
        setConfirmDelete(null)
      } else {
        setConfirmDelete(name)
      }
    },
    [confirmDelete, deleteServer],
  )

  const handleToggle = useCallback(
    async (name: string, enabled: boolean) => {
      await toggleEnabled(name, enabled)
    },
    [toggleEnabled],
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-zinc-500">加载 MCP 服务器...</div>
    )
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-300">
        <p>{error}</p>
        <button
          type="button"
          onClick={() => fetchServers()}
          className="mt-2 rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
        >
          重试
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header with action buttons */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-200">MCP 服务器 ({servers.length})</h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onOpenImport}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            导入
          </button>
          <button
            type="button"
            onClick={() => onOpenEditor()}
            className="rounded-md bg-cyan-600/80 px-3 py-1.5 text-xs text-white hover:bg-cyan-600"
          >
            + 新增
          </button>
        </div>
      </div>

      {/* Server cards */}
      {servers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-700 p-8 text-center text-sm text-zinc-500">
          暂无 MCP 服务器配置。点击「+ 新增」或「导入」来添加。
        </div>
      ) : (
        <div className="grid gap-3">
          {servers.map((server) => (
            <McpServerCard
              key={server.name}
              server={server}
              onEdit={onOpenEditor}
              onDelete={handleDelete}
              onToggle={handleToggle}
            />
          ))}
        </div>
      )}

      {/* Delete confirmation toast */}
      {confirmDelete && (
        <div className="fixed bottom-4 right-4 z-50 rounded-lg border border-zinc-700 bg-zinc-900 p-3 shadow-xl">
          <p className="text-xs text-zinc-300">
            确定删除 <strong>{confirmDelete}</strong>？再次点击删除确认。
          </p>
          <button
            type="button"
            onClick={() => setConfirmDelete(null)}
            className="mt-1 text-xs text-zinc-500 hover:text-zinc-300"
          >
            取消
          </button>
        </div>
      )}
    </div>
  )
}

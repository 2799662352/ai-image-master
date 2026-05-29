import { useCallback, useEffect, useMemo, useState } from 'react'
import type React from 'react'

import { AutoFixToast } from './AutoFixToast'
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
  const codexConfigError = useMcpStore((s) => s.codexConfigError)
  const loggingIn = useMcpStore((s) => s.loggingIn)
  const hasFetchedOnce = useMcpStore((s) => s.hasFetchedOnce)
  const syncing = useMcpStore((s) => s.syncing)
  const syncError = useMcpStore((s) => s.syncError)
  const fetchServers = useMcpStore((s) => s.fetchServers)
  const toggleEnabled = useMcpStore((s) => s.toggleEnabled)
  const deleteServer = useMcpStore((s) => s.deleteServer)
  const startOAuthLogin = useMcpStore((s) => s.startOAuthLogin)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  // Heuristic: extract the offending mcp_servers.X name from codex's
  // error message (e.g. "invalid transport in `mcp_servers.apiyi`") so
  // we can deep-link "修复" straight into the JSON editor on that server.
  const offendingServerName = useMemo(() => {
    if (!codexConfigError) return null
    const m = codexConfigError.match(/mcp_servers[.`'"]+([A-Za-z0-9_.-]+)/)
    return m ? m[1] : null
  }, [codexConfigError])

  // Split servers into "🎁 预装" (vendored by us into resources/, seeded into
  // codex config on first boot — currently just apiyi-mcp) vs everything
  // else the user has added themselves. Stable order: bundled stays in the
  // order returned by buildServersFromConfig (alphabetical-ish), user list
  // is untouched so manual reordering in config.toml still shows through.
  const { bundledServers, userServers } = useMemo(() => {
    const bundled: typeof servers = []
    const userAdded: typeof servers = []
    for (const s of servers) {
      if (s.isAppBundled) bundled.push(s)
      else userAdded.push(s)
    }
    return { bundledServers: bundled, userServers: userAdded }
  }, [servers])

  useEffect(() => {
    // Only auto-fetch if we have never loaded yet — keeps state when the user
    // navigates away and returns. Manual refresh is still available below.
    // The store's module-level IPC listener already routes status updates;
    // we no longer wire one in this component.
    if (!hasFetchedOnce) {
      fetchServers()
    }
  }, [fetchServers, hasFetchedOnce])

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

  const handleLogin = useCallback(
    (name: string) => {
      startOAuthLogin(name)
    },
    [startOAuthLogin],
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-zinc-500">加载 MCP 服务器...</div>
    )
  }

  // True fatal: we couldn't read the config in ANY form (codex RPC failed
  // AND the raw TOML fallback also failed, or MCP IPC is unavailable
  // entirely). Schema rejections by codex don't land here — they go
  // through `codexConfigError` so the user keeps editor access.
  if (error) {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-300">
        <p className="whitespace-pre-wrap">{error}</p>
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
    // `min-w-0` lets this column live inside any flex/grid parent without
    // its unbreakable string children (long Windows paths, long URLs)
    // pushing the parent wider than its allotted width and forcing a
    // page-level horizontal scrollbar.
    <div className="flex min-w-0 flex-col gap-4">
      <AutoFixToast />
      {/* Header with action buttons */}
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-200">
          <span>MCP 服务器 ({servers.length})</span>
          {syncing && <span className="text-[11px] text-zinc-500">同步中...</span>}
        </h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              void fetchServers()
            }}
            disabled={syncing}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            title="重新读取配置 + 刷新工具列表"
          >
            刷新
          </button>
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

      {codexConfigError && (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-200">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-red-100">Codex 拒绝加载当前 MCP 配置</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-red-200/90">
                {codexConfigError}
              </p>
              <p className="mt-1 text-red-300/80">
                以下卡片来自原始 <code className="text-[10px]">~/.codex/config.toml</code>。
                修复{offendingServerName ? <> <strong>{offendingServerName}</strong> 的</> : '出错的'}
                配置后点「刷新」可让 Codex 重新加载。
              </p>
            </div>
            {offendingServerName && (
              <button
                type="button"
                onClick={() => onOpenEditor(offendingServerName)}
                className="shrink-0 self-start rounded bg-red-500/20 px-3 py-1 text-xs text-red-100 hover:bg-red-500/30"
              >
                修复 {offendingServerName}
              </button>
            )}
          </div>
        </div>
      )}

      {syncError && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
          工具列表同步失败：{syncError}（状态点不受影响，可点「刷新」重试）
        </div>
      )}

      {/* Server cards — split into "🎁 预装" (app-bundled) and user-added */}
      {servers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-700 p-8 text-center text-sm text-zinc-500">
          暂无 MCP 服务器配置。点击「+ 新增」或「导入」来添加。
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {bundledServers.length > 0 && (
            <section className="flex min-w-0 flex-col gap-2">
              <div className="flex items-center gap-2">
                <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300/80">
                  <span aria-hidden>🎁</span>
                  <span>预装 MCP</span>
                  <span className="ml-1 text-zinc-500/80">({bundledServers.length})</span>
                </h3>
                <span className="text-[11px] text-zinc-500">
                  应用自带 · 配置 API Key 即可启用
                </span>
              </div>
              {/* `grid-cols-[minmax(0,1fr)]` is the canonical fix for the
                  CSS-Grid horizontal-overflow trap: grid items default to
                  `min-width: auto` (= max-content), so an unbreakable long
                  string inside any card would push the track wider than
                  the viewport and create a horizontal scrollbar on the
                  whole MCP page. The explicit `minmax(0, 1fr)` makes the
                  track shrinkable, letting child `truncate` actually clip. */}
              <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
                {bundledServers.map((server) => (
                  <McpServerCard
                    key={server.name}
                    server={server}
                    loggingIn={loggingIn === server.name}
                    onEdit={onOpenEditor}
                    onDelete={handleDelete}
                    onToggle={handleToggle}
                    onLogin={handleLogin}
                  />
                ))}
              </div>
            </section>
          )}

          {userServers.length > 0 && (
            <section className="flex min-w-0 flex-col gap-2">
              <div className="flex items-center gap-2">
                <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-300/80">
                  <span>你的 MCP 服务器</span>
                  <span className="ml-1 text-zinc-500/80">({userServers.length})</span>
                </h3>
                <span className="text-[11px] text-zinc-500">手动添加或导入</span>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
                {userServers.map((server) => (
                  <McpServerCard
                    key={server.name}
                    server={server}
                    loggingIn={loggingIn === server.name}
                    onEdit={onOpenEditor}
                    onDelete={handleDelete}
                    onToggle={handleToggle}
                    onLogin={handleLogin}
                  />
                ))}
              </div>
            </section>
          )}
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

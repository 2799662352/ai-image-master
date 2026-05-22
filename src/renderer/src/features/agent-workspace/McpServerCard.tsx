import type React from 'react'

import { ToolChip } from './ToolChip'
import type { McpServerCard as McpServerCardData } from './useMcpStore'

interface McpServerCardProps {
  server: McpServerCardData
  loggingIn?: boolean
  onEdit: (name: string) => void
  onDelete: (name: string) => void
  onToggle: (name: string, enabled: boolean) => void
  onLogin: (name: string) => void
}

const STATUS_DOT: Record<string, string> = {
  ready: 'bg-green-400',
  starting: 'bg-yellow-400 animate-pulse',
  failed: 'bg-red-400',
  cancelled: 'bg-zinc-500',
  unknown: 'bg-zinc-600',
}

/**
 * Render the "ready but tools=0" hint based on the actual server, not a
 * one-size-fits-all Docker message. apiyi (and any other app-bundled MCP
 * that needs an API key) usually hits this state when the key env var
 * is missing/empty — the child registers its tool handlers and then
 * exits at `initializeGenAI()`, leaving codex with an empty tool cache.
 * Docker MCP Gateway hits this when Docker Desktop is not running.
 * Everything else falls back to a neutral "still handshaking, try
 * refreshing" message.
 */
function getEmptyToolsHint(server: McpServerCardData): string {
  // App-bundled apiyi-mcp-server: vendored into resources/apiyi-mcp/,
  // launched as `<node> .../dist/index.js`. Needs APIYI_API_KEY in env.
  if (server.isAppBundled && server.name === 'apiyi') {
    return '已连接但未返回工具。请确认已在「设置 → 🎥 视频理解 API Key」中填入有效的 api.apiyi.com Key，然后点上方「刷新」。'
  }
  // Anything routed through docker (gateway or otherwise) — the original
  // hint is correct here.
  const cmd = (server.command ?? '').toLowerCase()
  const looksLikeDocker =
    cmd.startsWith('docker') ||
    cmd.endsWith('\\docker.exe') ||
    cmd.endsWith('/docker') ||
    /^docker[-_]/i.test(server.name)
  if (looksLikeDocker) {
    return '服务器已连接，但未返回工具。Docker MCP Gateway 通常需要 Docker Desktop 运行，并在 Docker MCP Toolkit 中启用至少一个 server。'
  }
  return '已连接但未返回工具。可能仍在初始化或子进程已退出 —— 请稍候点上方「刷新」，或检查该 MCP 的命令行参数 / 环境变量 / stderr 日志。'
}

interface ToggleSwitchProps {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}

function ToggleSwitch({ checked, onChange, label }: ToggleSwitchProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        checked ? 'bg-cyan-500/80' : 'bg-zinc-700'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

export function McpServerCard({
  server,
  loggingIn,
  onEdit,
  onDelete,
  onToggle,
  onLogin,
}: McpServerCardProps): React.JSX.Element {
  const dotColor = STATUS_DOT[server.status] ?? STATUS_DOT.unknown
  const needsLogin = server.authStatus === 'notLoggedIn'

  return (
    <div className="group rounded-lg border border-zinc-800/60 bg-zinc-900/60 p-4 transition-colors hover:border-zinc-700/80">
      {/* Header row: status dot · name · type badge · toggle */}
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dotColor}`} title={server.status} />
        <span className="flex-1 truncate text-sm font-medium text-zinc-100">{server.name}</span>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase text-zinc-400">
          {server.type}
        </span>
        <ToggleSwitch
          checked={server.enabled}
          onChange={(next) => onToggle(server.name, next)}
          label={server.enabled ? '已启用' : '已禁用'}
        />
      </div>

      {/* Command / URL */}
      <p className="mt-1 truncate text-xs text-zinc-500">
        {server.type === 'http' ? server.url : [server.command, ...(server.args ?? [])].join(' ')}
      </p>

      {/* Error message */}
      {server.error && (
        <p className="mt-1 text-xs text-red-400" title={server.error}>
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
      {server.status === 'ready' && server.tools.length === 0 && (
        <p className="mt-2 text-xs text-amber-300/80">
          {getEmptyToolsHint(server)}
        </p>
      )}

      {/* Action row: login button (when needed), edit, delete */}
      <div className="mt-3 flex items-center gap-2">
        {needsLogin && !loggingIn && (
          <button
            type="button"
            onClick={() => onLogin(server.name)}
            className="rounded bg-cyan-600/80 px-2.5 py-1 text-xs font-medium text-white hover:bg-cyan-600"
          >
            登录 →
          </button>
        )}
        {loggingIn && (
          <span className="inline-flex items-center gap-1.5 rounded bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-400" />
            登录中...
          </span>
        )}

        {/* Edit/delete only revealed on hover to keep the card calm */}
        {!server.isBuiltin && (
          <div className="ml-auto flex gap-2 opacity-0 transition-opacity group-hover:opacity-100">
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
          </div>
        )}
      </div>
    </div>
  )
}

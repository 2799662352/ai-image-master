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

const STATUS_LABEL: Record<string, string> = {
  ready: '已连接',
  starting: '启动中',
  failed: '连接失败',
  cancelled: '已禁用',
  unknown: '状态未知',
}

function PencilIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  )
}

function TrashIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-2 14a2 2 0 01-2 2H9a2 2 0 01-2-2L5 6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  )
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
  const statusLabel = STATUS_LABEL[server.status] ?? server.status
  const needsLogin = server.authStatus === 'notLoggedIn'
  const commandLine =
    server.type === 'http'
      ? (server.url ?? '')
      : [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
  const emptyToolsHint =
    server.status === 'ready' && server.tools.length === 0 ? getEmptyToolsHint(server) : null

  return (
    <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/60 p-3 transition-colors hover:border-zinc-700/80">
      {/* Header row — name on the left, actions + toggle ALWAYS visible on
          the right. Cursor-style: never hidden behind hover, never pushed
          off-screen by long description text below (which is line-clamped). */}
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${dotColor}`}
          title={statusLabel}
          aria-label={statusLabel}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-100" title={server.name}>
          {server.name}
        </span>

        {server.isAppBundled && (
          <span
            className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300"
            title="应用自带的预装 MCP 服务器"
          >
            预装
          </span>
        )}
        <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase text-zinc-500">
          {server.type}
        </span>

        {/* Action cluster — always visible, fixed-width so card width is
            stable regardless of name length or status text. */}
        <div className="ml-1 flex shrink-0 items-center gap-0.5">
          {!server.isBuiltin && (
            <>
              <button
                type="button"
                onClick={() => onEdit(server.name)}
                className="flex h-7 w-7 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                title="编辑"
                aria-label={`编辑 ${server.name}`}
              >
                <PencilIcon />
              </button>
              <button
                type="button"
                onClick={() => onDelete(server.name)}
                className="flex h-7 w-7 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-red-500/15 hover:text-red-300"
                title="删除"
                aria-label={`删除 ${server.name}`}
              >
                <TrashIcon />
              </button>
            </>
          )}
          <div className="ml-1">
            <ToggleSwitch
              checked={server.enabled}
              onChange={(next) => onToggle(server.name, next)}
              label={server.enabled ? '已启用' : '已禁用'}
            />
          </div>
        </div>
      </div>

      {/* Command / URL — single line, full text on hover */}
      {commandLine && (
        <p className="mt-1.5 truncate text-xs text-zinc-500" title={commandLine}>
          {commandLine}
        </p>
      )}

      {/* Error message — clamped to 2 lines so it can never push the card
          taller than ~3 rows of text. Hover for full message. */}
      {server.error && (
        <p
          className="mt-1 line-clamp-2 break-all text-xs text-red-400"
          title={server.error}
        >
          {server.error}
        </p>
      )}

      {/* Empty-tools hint — also clamped + hover-for-full. */}
      {emptyToolsHint && (
        <p
          className="mt-1 line-clamp-2 break-all text-xs text-amber-300/80"
          title={emptyToolsHint}
        >
          {emptyToolsHint}
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

      {/* Login row — only rendered when an HTTP MCP demands auth, which is
          rare enough that a dedicated row is fine here. */}
      {(needsLogin || loggingIn) && (
        <div className="mt-2 flex items-center gap-2">
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
        </div>
      )}
    </div>
  )
}

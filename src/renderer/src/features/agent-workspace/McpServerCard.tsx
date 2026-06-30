import type React from 'react'

import { ToolChip } from './ToolChip'
import type { McpServerCard as McpServerCardData } from './useMcpStore'

interface McpServerCardProps {
  server: McpServerCardData
  loggingIn?: boolean
  /** This card's per-server refresh is in flight (independent of other cards). */
  refreshing?: boolean
  onEdit: (name: string) => void
  onDelete: (name: string) => void
  onToggle: (name: string, enabled: boolean) => void
  onLogin: (name: string) => void
  /** Optional: when provided, renders a per-server refresh button. */
  onRefresh?: (name: string) => void
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

function RefreshIcon({ spinning }: { spinning?: boolean }): React.JSX.Element {
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
      className={spinning ? 'animate-spin' : undefined}
    >
      <path d="M23 4v6h-6" />
      <path d="M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
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
 * Strip platform path prefixes from a runtime binary path and drop the
 * trailing `.exe` so the rendered command line stays short. We keep the
 * full path in `title` for hover-to-inspect; this is purely a display
 * concession. Path separators on Windows can be either `\` or `/`.
 *
 * Examples (all → "electron"):
 *   D:\tecx\...\node_modules\electron\dist\electron.exe
 *   C:/Users/me/AppData/Local/Programs/electron/electron.exe
 *   /usr/local/bin/node
 */
function shortenBinary(bin: string): string {
  if (!bin) return ''
  // Normalize separators, take last non-empty segment, strip .exe
  const parts = bin.replace(/\\/g, '/').split('/').filter(Boolean)
  const last = parts[parts.length - 1] ?? bin
  return last.replace(/\.exe$/i, '')
}

/**
 * Strip path prefix from a CLI arg if it looks like an absolute path to a
 * script or executable (anything with at least one `/` or `\` segment).
 * Short args (flags, image names like `mcp/test`) pass through unchanged.
 *
 * Examples:
 *   "D:\tecx\...\resources\apiyi-mcp\dist\index.js" → "index.js"
 *   "-i"                                            → "-i"
 *   "mcp/test"                                      → "mcp/test"
 *   "run"                                           → "run"
 */
function shortenArg(arg: string): string {
  if (!arg) return ''
  // Heuristic: only collapse if the arg is an absolute Windows path
  // (`X:\...`) or starts with `/` (POSIX absolute). Relative tokens like
  // `mcp/test` (docker image), `run`, `-i` stay verbatim — they're already
  // short and shortening them loses meaning (e.g. `mcp/test` → `test`).
  const looksAbsolute = /^[a-zA-Z]:[\\/]/.test(arg) || arg.startsWith('/')
  if (!looksAbsolute) return arg
  const parts = arg.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? arg
}

/**
 * Cursor-style condensed command display. Hides the long `node_modules/.pnpm/
 * electron@x.y.z/...` and `D:\tecx\...\resources\apiyi-mcp\dist\index.js`
 * gunk that has zero value to a user reading the card; surfaces just
 * `<runtime> <script-basename> <…args>`. The full string is preserved in
 * the `title` attribute for hover-to-inspect, and the JSON editor (which
 * opens as a modal) shows the unabridged config.
 *
 * Returns BOTH the short label (for display) and the full line (for `title`)
 * so the caller can wire hover-to-inspect without re-deriving anything.
 */
function formatCommandLine(server: McpServerCardData): { short: string; full: string } {
  if (server.type === 'http') {
    const url = server.url ?? ''
    return { short: url, full: url }
  }
  const cmd = server.command ?? ''
  const args = server.args ?? []
  const full = [cmd, ...args].filter(Boolean).join(' ')
  const short = [shortenBinary(cmd), ...args.map(shortenArg)].filter(Boolean).join(' ')
  return { short: short || full, full }
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
  // launched as `<electron.exe-as-node> .../dist/index.js`. The seed already
  // pre-fills APIYI_BASE_URL / GEMINI_MODEL / ELECTRON_RUN_AS_NODE etc., so
  // the only field the user has to fill is APIYI_API_KEY.
  if (server.isAppBundled && server.name === 'apiyi') {
    return '已连接但未返回工具。请点击右上 ✏️ 编辑，把 env.APIYI_API_KEY 改成你的 api.apiyi.com 密钥（sk- 开头，不能是空格），保存后点上方「刷新」。其它字段已预填默认值无需改动。'
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

/**
 * Small auth posture pill driven by codex 0.137's typed `authStatus`.
 * `notLoggedIn` is intentionally NOT badged here — that state already gets a
 * dedicated "登录 →" button row below, so a redundant pill would be noise.
 * `unsupported` (the common case for stdio servers) renders nothing.
 */
function AuthBadge({ authStatus }: { authStatus?: string }): React.JSX.Element | null {
  if (authStatus === 'oAuth') {
    return (
      <span
        className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300"
        title="已通过 OAuth 登录"
      >
        OAuth
      </span>
    )
  }
  if (authStatus === 'bearerToken') {
    return (
      <span
        className="shrink-0 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-300"
        title="使用 Bearer Token 鉴权"
      >
        Token
      </span>
    )
  }
  return null
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
  refreshing,
  onEdit,
  onDelete,
  onToggle,
  onLogin,
  onRefresh,
}: McpServerCardProps): React.JSX.Element {
  const dotColor = STATUS_DOT[server.status] ?? STATUS_DOT.unknown
  const statusLabel = STATUS_LABEL[server.status] ?? server.status
  const needsLogin = server.authStatus === 'notLoggedIn'
  const { short: commandLineShort, full: commandLineFull } = formatCommandLine(server)
  const emptyToolsHint =
    server.status === 'ready' && server.tools.length === 0 ? getEmptyToolsHint(server) : null

  return (
    // `min-w-0` is REQUIRED here — this card sits inside a CSS Grid track,
    // and grid items default to `min-width: auto` (≈ max-content). Without
    // it, any long unbreakable string (e.g. a Windows absolute path like
    // `D:\tecx\...\dist\electron.exe`) would push the grid track wider than
    // the viewport and force a horizontal scrollbar on the entire MCP page.
    // Pair this with `min-w-0` on the inner flex row so `truncate` actually
    // collapses overflow instead of stretching the parent.
    <div className="min-w-0 rounded-lg border border-zinc-800/60 bg-zinc-900/60 p-3 transition-colors hover:border-zinc-700/80">
      {/* Header row — name on the left, actions + toggle ALWAYS visible on
          the right. Cursor-style: never hidden behind hover, never pushed
          off-screen by long description text below (which is line-clamped).
          `flex-wrap` lets the action cluster drop to a second line on very
          narrow widths instead of being shoved off-screen. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
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
        <AuthBadge authStatus={server.authStatus} />
        {server.serverInfo?.version && (
          <span
            className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400"
            title={server.serverInfo.title ? `${server.serverInfo.title} v${server.serverInfo.version}` : undefined}
          >
            v{server.serverInfo.version}
          </span>
        )}

        {/* Action cluster — always visible, fixed-width so card width is
            stable regardless of name length or status text. */}
        <div className="ml-1 flex shrink-0 items-center gap-0.5">
          {onRefresh && (
            <button
              type="button"
              onClick={() => onRefresh(server.name)}
              disabled={refreshing}
              className="flex h-7 w-7 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
              title="只刷新这个服务器（不影响其它）"
              aria-label={`刷新 ${server.name}`}
            >
              <RefreshIcon spinning={refreshing} />
            </button>
          )}
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

      {/* Command / URL — shortened to runtime + script basename (e.g.
          `electron index.js`) instead of the raw `D:\…\electron.exe
          D:\…\dist\index.js`. Full original string is preserved in `title`
          so users can hover-to-inspect, and the JSON editor modal shows
          the unabridged config. */}
      {commandLineShort && (
        <p
          className="mt-1.5 truncate text-xs text-zinc-500"
          title={commandLineFull}
        >
          {commandLineShort}
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

      {/* Inventory meta — tools/resources/templates counts surfaced by
          codex's `detail: 'full'` MCP status. Only shown when non-empty so
          the card stays compact for plain tool-only servers. */}
      {((server.resources?.length ?? 0) > 0 || (server.resourceTemplates?.length ?? 0) > 0) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
          {(server.resources?.length ?? 0) > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded bg-zinc-800/70 px-1.5 py-0.5"
              title={server.resources!.map((r) => r.title ?? r.name ?? r.uri).join('\n')}
            >
              <span aria-hidden>📄</span>
              {server.resources!.length} 资源
            </span>
          )}
          {(server.resourceTemplates?.length ?? 0) > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded bg-zinc-800/70 px-1.5 py-0.5"
              title={server.resourceTemplates!.map((t) => t.title ?? t.name ?? t.uriTemplate).join('\n')}
            >
              <span aria-hidden>🧩</span>
              {server.resourceTemplates!.length} 模板
            </span>
          )}
        </div>
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

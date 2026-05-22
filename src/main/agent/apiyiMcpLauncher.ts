import path from 'node:path'
import { getCodexResourceRoot } from './paths'

export interface ApiyiMcpPathOptions {
  appPath: string
  isPackaged: boolean
  resourcesPath?: string
}

/**
 * Resolve the absolute filesystem path to the vendored apiyi-mcp-server entry
 * (dist/index.js). Mirrors the layout produced by scripts/vendor-apiyi-mcp.mjs
 * and shipped via electron-builder.yml `extraResources`.
 *
 * Packaged: <resourcesPath>/apiyi-mcp/dist/index.js
 * Dev:      <appPath>/resources/apiyi-mcp/dist/index.js
 */
export function getApiyiMcpEntryPath(options: ApiyiMcpPathOptions): string {
  const root = getCodexResourceRoot(options)
  return path.join(root, 'apiyi-mcp', 'dist', 'index.js')
}

export interface ApiyiMcpConfigEntryInput {
  entryPath: string
  nodeBin: string
  enabled: boolean
  /** Literal API key. Only honored when `enabled` is true. */
  apiKey?: string
}

/**
 * The TOML-serializable shape we write into `mcp_servers.apiyi`.
 *
 * `command` — absolute path to a Node.js binary (Electron's `process.execPath`
 * at runtime; Electron can execute a stdio MCP server without a separate Node
 * install).
 *
 * `args[0]` — absolute path to the vendored `dist/index.js`.
 *
 * `enabled: false` is the first-boot default; the settings UI flips it to
 * `true` and re-writes the file.
 *
 * `env` decision table:
 * | enabled | apiKey     | env                              |
 * |---------|------------|----------------------------------|
 * | false   | (any)      | `{}`                             |
 * | true    | undefined  | `{}`                             |
 * | true    | 'sk-...'   | `{ APIYI_API_KEY: 'sk-...' }`    |
 *
 * The `enabled && !apiKey` combination should never happen in practice — the
 * AgentManager always passes an apiKey when enabling. Emitting `{}` in that
 * case is the safest defensive fallback: it avoids writing a stale placeholder
 * literal to disk that the codex CLI would pass through verbatim.
 */
export interface ApiyiMcpConfigEntry {
  command: string
  args: string[]
  enabled: boolean
  env: Record<string, string>
}

export function buildApiyiMcpConfigEntry(
  input: ApiyiMcpConfigEntryInput,
): ApiyiMcpConfigEntry {
  const env: Record<string, string> = {}
  if (input.enabled && input.apiKey) {
    env.APIYI_API_KEY = input.apiKey
  }
  return {
    command: input.nodeBin,
    args: [input.entryPath],
    enabled: input.enabled,
    env,
  }
}

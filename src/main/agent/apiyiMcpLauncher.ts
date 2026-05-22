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
}

/**
 * Minimal TOML-serializable shape we write into `mcp_servers.apiyi`. We
 * intentionally do NOT auto-inject any env values — the user opens the MCP
 * JSON editor and fills `APIYI_API_KEY`, `ELECTRON_RUN_AS_NODE = "1"` (required
 * when `command` is electron.exe), and `GEMINI_MODEL` themselves.
 *
 * `command` — absolute path to a Node-capable binary (Electron's `process.execPath`
 * at runtime; user is responsible for adding `ELECTRON_RUN_AS_NODE=1` to env
 * via the JSON editor, otherwise Electron spawns in GUI mode and breaks stdio).
 *
 * `args[0]` — absolute path to the vendored `dist/index.js`.
 *
 * `enabled: false` is the first-boot default; user flips it via the MCP page.
 *
 * `env` is always an empty object so the JSON-editor render shows the block
 * structure for the user to fill in.
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
  return {
    command: input.nodeBin,
    args: [input.entryPath],
    enabled: input.enabled,
    env: {},
  }
}

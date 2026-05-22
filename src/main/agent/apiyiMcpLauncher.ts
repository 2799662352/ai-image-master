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
 * Default env scaffold seeded into `mcp_servers.apiyi.env`. Every non-secret
 * field has a sensible default value pre-filled so the user only has to paste
 * their `APIYI_API_KEY` into the visible empty slot — modelled after the
 * canonical working Cursor `mcp.json` shape for apiyi-mcp-server.
 *
 *  - `APIYI_API_KEY` — empty string placeholder; user pastes their
 *    `sk-...` key from https://api.apiyi.com/ here.
 *  - `APIYI_BASE_URL` — the apiyi-mcp-server default is `https://api.bltcy.ai`
 *    (a different proxy that won't accept api.apiyi.com keys); we override it
 *    to the documented apiyi.com endpoint so the bundled `sk-...` key works
 *    out of the box.
 *  - `GEMINI_MODEL` — apiyi-mcp's stated default per its README; supports
 *    thinking. User can downgrade to `gemini-2.5-flash` for lower cost.
 *  - `GEMINI_MAX_OUTPUT_TOKENS` / `GEMINI_TIMEOUT` — matches the long-context
 *    / long-running defaults from the working Cursor reference config.
 *  - `ELECTRON_RUN_AS_NODE` — mandatory because `command` is electron.exe;
 *    without this flag Electron starts in GUI mode and stdout is polluted by
 *    Chromium logs, breaking the MCP stdio JSON-RPC channel.
 */
export const APIYI_MCP_ENV_SCAFFOLD: Readonly<Record<string, string>> = Object.freeze({
  APIYI_API_KEY: '',
  APIYI_BASE_URL: 'https://api.apiyi.com',
  GEMINI_MODEL: 'gemini-3.1-pro-preview-thinking',
  GEMINI_MAX_OUTPUT_TOKENS: '65536',
  GEMINI_TIMEOUT: '1800000',
  ELECTRON_RUN_AS_NODE: '1',
})

/**
 * Minimal TOML-serializable shape we write into `mcp_servers.apiyi`.
 *
 * `command` — absolute path to a Node-capable binary (Electron's
 *   `process.execPath` at runtime). `ELECTRON_RUN_AS_NODE=1` is shipped in
 *   the env scaffold below to keep electron.exe from launching GUI.
 *
 * `args[0]` — absolute path to the vendored `dist/index.js`.
 *
 * `enabled: false` is the first-boot default; the seeded `APIYI_API_KEY` is
 *   empty, so flipping on without filling the key would just produce a noisy
 *   "token invalid" loop. User pastes their key in the JSON editor, then
 *   flips the toggle.
 *
 * `env` is a fresh copy of the scaffold (frozen template → new mutable object
 *   per call) so downstream code can edit without poisoning future seeds.
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
    env: { ...APIYI_MCP_ENV_SCAFFOLD },
  }
}

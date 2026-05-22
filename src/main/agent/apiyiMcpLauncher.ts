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

/**
 * Default Gemini model id used when the user has never picked a video model
 * through the chat-header picker. Mirrors `DEFAULT_VIDEO_MODEL_ID` in the
 * renderer's `videoModels.ts` — keep both in sync.
 *
 * Per Google I/O 2026 (2026-05-19) Gemini 3.5 Flash beats 3.1 Pro on
 * Terminal-Bench 2.1 / MCP Atlas / GDPval-AA while being ~4× faster and
 * ~½ the price. apiyi.com has shipped same-day support. Setting this as
 * our fallback means: the user enables the MCP with just an API key →
 * we write a deterministic `GEMINI_MODEL` to the TOML instead of relying
 * on the upstream apiyi-mcp default (which still points at 3.1 Pro).
 */
export const DEFAULT_VIDEO_MODEL_ID = 'gemini-3.5-flash'

export interface ApiyiMcpConfigEntryInput {
  entryPath: string
  nodeBin: string
  enabled: boolean
  /** Literal API key. Only honored when `enabled` is true. */
  apiKey?: string
  /**
   * Gemini model id forwarded to apiyi-mcp via `GEMINI_MODEL`. Sets
   * `config.defaultModel` for every `generate_content` tool call.
   *
   * When `enabled && apiKey` but `videoModel` is missing/empty, we fall back
   * to `DEFAULT_VIDEO_MODEL_ID` (gemini-3.5-flash) rather than letting
   * apiyi-mcp choose. This ensures the picker label in the UI always
   * matches what the server is actually running.
   *
   * Only honored when both `enabled` is true and `apiKey` is provided.
   */
  videoModel?: string
}

/**
 * The TOML-serializable shape we write into `mcp_servers.apiyi`.
 *
 * `command` — absolute path to Electron's `process.execPath` at runtime
 * (`electron.exe` in dev, the packaged app exe in prod). We deliberately do
 * NOT require a separate Node install; Electron's binary doubles as a Node
 * runtime when `ELECTRON_RUN_AS_NODE=1` is set in the spawn env.
 *
 * `args[0]` — absolute path to the vendored `dist/index.js`.
 *
 * `enabled: false` is the first-boot default; the settings UI flips it to
 * `true` and re-writes the file.
 *
 * `env` always contains `ELECTRON_RUN_AS_NODE: '1'`. Without it Electron
 * launches as a GUI subsystem process (even with a `.js` argv), spins up
 * Chromium / GPU init, and writes startup noise to stdout. MCP stdio
 * framing requires stdout to be pure line-delimited JSON-RPC, so the
 * noise breaks `tools/list` handshake and the server appears as
 * "ready but 0 tools" to Codex. `ELECTRON_RUN_AS_NODE=1` skips Chromium
 * entirely and runs the binary as a node process — clean stdout, no GUI.
 *
 * `env` decision table (when enabled && apiKey are both truthy):
 * | videoModel       | env (in addition to ELECTRON_RUN_AS_NODE: '1')                       |
 * |------------------|----------------------------------------------------------------------|
 * | undefined / ''   | `{ APIYI_API_KEY: '<key>', GEMINI_MODEL: DEFAULT_VIDEO_MODEL_ID }`    |
 * | 'gemini-x.y-...' | `{ APIYI_API_KEY: '<key>', GEMINI_MODEL: 'gemini-x.y-...' }`         |
 *
 * If `enabled` is false OR `apiKey` is missing, env is just
 * `{ ELECTRON_RUN_AS_NODE: '1' }` (so even a disabled entry would still
 * spawn as Node if someone manually flipped `enabled` without going
 * through `setApiyiVideoKey`). The `enabled && !apiKey` combination
 * should never happen in practice.
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
  // ELECTRON_RUN_AS_NODE=1 is REQUIRED — see jsdoc on ApiyiMcpConfigEntry.
  // Without it, Codex's MCP client sees `tools=[]` even when APIYI_API_KEY
  // is correct, because Electron's GUI-subsystem startup pollutes stdout.
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' }
  if (input.enabled && input.apiKey) {
    env.APIYI_API_KEY = input.apiKey
    env.GEMINI_MODEL = input.videoModel && input.videoModel.length > 0
      ? input.videoModel
      : DEFAULT_VIDEO_MODEL_ID
  }
  return {
    command: input.nodeBin,
    args: [input.entryPath],
    enabled: input.enabled,
    env,
  }
}

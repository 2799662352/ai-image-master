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
 * The TOML-serializable shape we write into `mcp_servers.apiyi`.
 *
 * `command` is the absolute path to a Node.js binary (we use Electron's own
 * `process.execPath` at runtime — Electron is built on Node so it can execute
 * a stdio MCP server fine, and we avoid forcing the user to install Node).
 *
 * `args[0]` is the absolute path to the vendored `dist/index.js`.
 *
 * `enabled: false` is the first-boot default; the settings IPC in PR-2 flips
 * it to `true` and re-writes the file. The codex CLI honors the `enabled`
 * field per `codexConfigMerge.ts:stripEnabledTrue`.
 *
 * `env.APIYI_API_KEY` is a *string placeholder* (`'${APIYI_API_KEY}'`) when
 * enabled — the real key is injected by the AgentManager at child-process spawn
 * time, NOT persisted into the TOML. This keeps the on-disk config clean of
 * secrets even though codex-providers.json stores the actual key.
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
    env: input.enabled ? { APIYI_API_KEY: '${APIYI_API_KEY}' } : {},
  }
}

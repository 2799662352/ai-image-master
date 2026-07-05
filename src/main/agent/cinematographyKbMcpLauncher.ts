import path from 'node:path'
import { getCodexResourceRoot } from './paths'

export interface CinematographyKbMcpPathOptions {
  appPath: string
  isPackaged: boolean
  resourcesPath?: string
}

/**
 * Resolve the absolute path to the vendored cinematography-kb-mcp entry
 * (index.js). Mirrors the `extraResources` mapping in electron-builder.yml.
 *
 * Packaged: <resourcesPath>/cinematography-kb-mcp/index.js
 * Dev:      <appPath>/resources/cinematography-kb-mcp/index.js
 *
 * Unlike apiyi-mcp this server is ZERO-dependency (Node built-ins only), so
 * there is no `dist/` build step and no `node_modules/` to vendor.
 */
export function getCinematographyKbMcpEntryPath(options: CinematographyKbMcpPathOptions): string {
  const root = getCodexResourceRoot(options)
  return path.join(root, 'cinematography-kb-mcp', 'index.js')
}

/**
 * Env scaffold seeded into `mcp_servers.cinematography_kb.env`.
 *
 * INTENTIONALLY EMPTY — the `DASHSCOPE_API_KEY` is NOT baked into the app / git
 * anymore (a DashScope key is not scoped to one KB; it can call any DashScope
 * API on the owner's account, so shipping it in source was a leak risk). We now
 * mirror the apiyi-mcp model: the key lives in 设置 → 运镜知识库, is kept in the
 * provider store under `cinematography-kb`, and is injected at codex spawn via
 * `-c mcp_servers.cinematography_kb.env.DASHSCOPE_API_KEY` — never persisted to
 * `~/.codex/config.toml`.
 *
 * The seed therefore only guarantees the entry's transport (command/args); the
 * env starts empty and the backfill pass never re-adds a secret (an EXTERNAL
 * `codex` CLI user who hand-types a key into the config env keeps it — the merge
 * only ADDS absent scaffold keys, and there are none). Tools still list without
 * a key; only the tool CALL reports the missing key.
 *
 * `query_sakuga_dataset` additionally reads `DASHVECTOR_API_KEY` (runtime `-c`
 * overlay, same as the DASHSCOPE key — never seeded here) and
 * `DASHVECTOR_ENDPOINT` (NOT a secret: the app's Sakuga-42M cluster host).
 * The endpoint will be baked into this scaffold once the DashVector cluster
 * exists (see docs/superpowers/plans/2026-07-05-sakuga-cloud-native-kb.md,
 * Task 2) so external codex CLI users get it for free; until then the tool
 * CALL reports the missing endpoint.
 */
export const CINEMATOGRAPHY_KB_ENV_SCAFFOLD: Readonly<Record<string, string>> = Object.freeze({})

export interface CinematographyKbMcpConfigEntry {
  command: string
  args: string[]
  enabled: boolean
  env: Record<string, string>
}

export interface CinematographyKbMcpConfigEntryInput {
  entryPath: string
  command: string
  extraEnv?: Record<string, string>
  enabled: boolean
}

/**
 * Build the TOML-serializable `mcp_servers.cinematography_kb` entry. `command`
 * comes from `resolveApiyiCommand` (system `node`, else Electron-as-Node) — the
 * same node-vs-electron decision the apiyi/catimation stdio servers use.
 */
export function buildCinematographyKbMcpConfigEntry(
  input: CinematographyKbMcpConfigEntryInput,
): CinematographyKbMcpConfigEntry {
  return {
    command: input.command,
    args: [input.entryPath],
    enabled: input.enabled,
    env: { ...CINEMATOGRAPHY_KB_ENV_SCAFFOLD, ...(input.extraEnv ?? {}) },
  }
}

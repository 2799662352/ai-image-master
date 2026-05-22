import { promises as fs } from 'node:fs'
import { parse as parseToml } from 'toml'
import * as iarnaToml from '@iarna/toml'
import { atomicWriteFile } from './codexConfigStore'
import { APIYI_MCP_ENV_SCAFFOLD, buildApiyiMcpConfigEntry } from './apiyiMcpLauncher'

export interface SeedApiyiMcpInput {
  personalConfigToml: string
  entryPath: string
  /**
   * Pre-resolved binary path that will spawn apiyi-mcp. Typically the system
   * `node` (via `resolveApiyiCommand` → `whichNode`), or Electron's
   * `process.execPath` as the packaged-app fallback. The caller is responsible
   * for the node-vs-electron choice (see `resolveApiyiCommand`); seed itself
   * is pure and just persists what it's handed.
   */
  command: string
  /**
   * Extra env vars layered on top of `APIYI_MCP_ENV_SCAFFOLD` for the seeded
   * entry — empty for the `node` path, `{ ELECTRON_RUN_AS_NODE: '1' }` for
   * the Electron fallback. Not used on the backfill path (existing user
   * config is sacred there).
   */
  extraEnv?: Record<string, string>
}

export type SeedAction = 'seeded' | 'backfilled' | 'skipped'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Backfill helper: compute the merged env block for an existing apiyi entry.
 * Returns `null` if every scaffold key is already present (no write needed),
 * otherwise returns the merged record with user-set values preserved.
 *
 * Rule: user-set values are sacred. We ONLY add keys that are absent. We do
 * NOT touch existing values, even if they look "wrong" (e.g., a stale
 * `gemini-3.5-flash` model id, a `bltcy.ai` base URL, an empty `""` key the
 * user is in the middle of typing). The user owns those values.
 *
 * Edge cases:
 *   - `existingEnv` is not an object (e.g., user wrote `env = "broken"`) →
 *     treat as `{}` and return the full scaffold as a fresh block.
 *   - Existing key with value `undefined` / `null` → preserve as-is (user
 *     intent unclear; safer not to second-guess).
 */
export function mergeEnvWithScaffold(
  existingEnv: unknown,
): Record<string, string> | null {
  const base = isPlainObject(existingEnv) ? existingEnv : {}
  const merged: Record<string, string> = {}
  for (const [key, val] of Object.entries(base)) {
    merged[key] = typeof val === 'string' ? val : String(val)
  }
  let changed = false
  for (const [key, scaffoldVal] of Object.entries(APIYI_MCP_ENV_SCAFFOLD)) {
    if (!(key in merged)) {
      merged[key] = scaffoldVal
      changed = true
    }
  }
  if (!isPlainObject(existingEnv)) changed = true
  return changed ? merged : null
}

/**
 * Boot-time convergence for `mcp_servers.apiyi`. Three outcomes:
 *
 *  - **'seeded'**     — entry didn't exist; write a disabled stub with the
 *    full APIYI_MCP_ENV_SCAFFOLD env block (base URL, model, timeouts) plus
 *    any caller-supplied `extraEnv`, and an empty `APIYI_API_KEY` slot for
 *    the user to fill in via the MCP JSON editor.
 *  - **'backfilled'** — entry exists, but its env block is missing one or
 *    more scaffold keys (e.g., legacy `env: {}` from an older seed, or a
 *    partial config the user wrote by hand). We **add** the missing keys
 *    with their scaffold defaults, **preserving every user-set value**, and
 *    write the merged result back. `command` / `args` / `enabled` /
 *    `tool_timeout_sec` are NEVER touched on this path.
 *  - **'skipped'**    — entry exists AND its env block already has every
 *    scaffold key (user is in steady state; nothing to do).
 *
 * Why backfill instead of "user config is sacred, never touch":
 *   The earlier no-touch design left existing users staring at the same
 *   broken JSON they had before the scaffold landed — they could never
 *   discover the right shape (apiyi.com base URL, sensible model id) without
 *   reading code. Backfill is a one-shot, additive-only migration that gets
 *   every existing user to parity with a fresh seed, without ever clobbering
 *   anything they explicitly chose.
 *
 * Safe to call on every app boot; idempotent. Once an entry has all scaffold
 * keys present, every subsequent call returns 'skipped' and never writes.
 * Malformed existing TOML is treated as empty (a console.warn is emitted,
 * the disk file is overwritten with a clean seeded version — preferable to
 * silently failing).
 */
export async function seedApiyiMcpEntry(input: SeedApiyiMcpInput): Promise<SeedAction> {
  let rawDoc: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(input.personalConfigToml, 'utf8')
    if (raw.trim()) {
      try {
        rawDoc = parseToml(raw) as Record<string, unknown>
      } catch (err) {
        console.warn(
          `[apiyi-mcp-seed] existing TOML at ${input.personalConfigToml} is malformed; rewriting as seed-only.`,
          err,
        )
        rawDoc = {}
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  const existingServers = isPlainObject(rawDoc.mcp_servers) ? rawDoc.mcp_servers : {}
  const existingApiyi = isPlainObject(existingServers.apiyi) ? existingServers.apiyi : null

  if (existingApiyi) {
    const mergedEnv = mergeEnvWithScaffold(existingApiyi.env)
    if (!mergedEnv) {
      return 'skipped'
    }
    const backfilledApiyi = { ...existingApiyi, env: mergedEnv }
    const nextServers = { ...existingServers, apiyi: backfilledApiyi }
    const nextDoc = { ...rawDoc, mcp_servers: nextServers }
    const serialized = iarnaToml.stringify(nextDoc as unknown as iarnaToml.JsonMap)
    await atomicWriteFile(input.personalConfigToml, serialized)
    return 'backfilled'
  }

  const seededEntry = buildApiyiMcpConfigEntry({
    entryPath: input.entryPath,
    command: input.command,
    extraEnv: input.extraEnv,
    enabled: false,
  })

  const nextServers = { ...existingServers, apiyi: seededEntry }
  const nextDoc = { ...rawDoc, mcp_servers: nextServers }

  const serialized = iarnaToml.stringify(nextDoc as unknown as iarnaToml.JsonMap)
  await atomicWriteFile(input.personalConfigToml, serialized)

  return 'seeded'
}

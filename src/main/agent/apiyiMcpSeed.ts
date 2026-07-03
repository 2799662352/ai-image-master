import { promises as fs } from 'node:fs'
import { parse as parseToml } from 'toml'
import * as iarnaToml from '@iarna/toml'
import { atomicWriteFile } from './codexConfigStore'
import { buildApiyiMcpConfigEntry } from './apiyiMcpLauncher'
import type { ApiyiMcpConfigEntry } from './apiyiMcpLauncher'

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
   * the Electron fallback.
   */
  extraEnv?: Record<string, string>
}

export type SeedAction = 'seeded' | 'repaired' | 'skipped'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Structural equality against the canonical entry: exactly the four canonical
 * fields (`command`/`args`/`enabled`/`env`), each matching value-for-value.
 * Any extra field, missing field, or divergent value → NOT canonical → the
 * seed overwrites. Used only to decide 'skipped' (no write) vs 'repaired'.
 */
function isCanonicalApiyiEntry(existing: unknown, canonical: ApiyiMcpConfigEntry): boolean {
  if (!isPlainObject(existing)) return false
  if (Object.keys(existing).sort().join(',') !== 'args,command,enabled,env') return false
  if (existing.command !== canonical.command) return false
  if (existing.enabled !== canonical.enabled) return false
  const args = existing.args
  if (!Array.isArray(args) || args.length !== 1 || args[0] !== canonical.args[0]) return false
  const env = existing.env
  if (!isPlainObject(env)) return false
  const canonKeys = Object.keys(canonical.env).sort()
  if (Object.keys(env).sort().join('\n') !== canonKeys.join('\n')) return false
  return canonKeys.every((k) => env[k] === canonical.env[k])
}

/**
 * Boot-time FORCE convergence for `mcp_servers.apiyi`. The entry is
 * app-managed (「预设」): on every boot it is overwritten with the canonical
 * form — freshly resolved `command`/`args`, the full env scaffold
 * (base URL / model / tokens / timeout, plus `ELECTRON_RUN_AS_NODE` on the
 * Electron fallback), and `enabled = true`. User edits to this entry do NOT
 * survive a restart. Three outcomes:
 *
 *  - **'seeded'**   — entry didn't exist; canonical entry written.
 *  - **'repaired'** — entry existed but differed from canonical in ANY way
 *    (stale paths, old `enabled = false` seeds, hand-edited env, extra
 *    fields); overwritten wholesale.
 *  - **'skipped'**  — entry already exactly canonical; nothing written.
 *
 * Why force instead of the earlier "sacred user config" backfill/repair:
 *   Field reality (v4.3.75 era support cases): users were stuck with entries
 *   that old seeds wrote as `enabled = false`, stale transports from moved
 *   installs, and empty `APIYI_API_KEY = ""` strings — none of which the
 *   additive backfill would ever fix, so "看着全对但 0 工具" persisted
 *   forever. apiyi is the app's own bundled default gateway, not a
 *   user-authored server; converging it unconditionally is the only shape
 *   that self-heals every historical bad state at once.
 *
 * Key policy: `APIYI_API_KEY` is NEVER part of the persisted entry. The ONLY
 * supported key source is 设置 → API易, injected at codex spawn via
 * `-c mcp_servers.apiyi.env.APIYI_API_KEY=...` (see `buildCodexLaunchArgs`).
 * A key hand-typed into the JSON editor is wiped at the next boot by design.
 *
 * Other servers and top-level config.toml keys are preserved untouched.
 * Malformed existing TOML is treated as empty (console.warn + clean rewrite).
 * Safe to call on every boot; idempotent once canonical.
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
  const existingApiyi = 'apiyi' in existingServers ? existingServers.apiyi : undefined

  const canonical = buildApiyiMcpConfigEntry({
    entryPath: input.entryPath,
    command: input.command,
    extraEnv: input.extraEnv,
    // Force ON. The runtime no-key guard (`-c mcp_servers.apiyi.enabled=false`
    // in buildCodexLaunchArgs) is what keeps a keyless apiyi dormant — the
    // persisted entry itself must never be the reason apiyi stays dead.
    enabled: true,
  })

  if (existingApiyi !== undefined && isCanonicalApiyiEntry(existingApiyi, canonical)) {
    return 'skipped'
  }

  const nextServers = { ...existingServers, apiyi: canonical }
  const nextDoc = { ...rawDoc, mcp_servers: nextServers }
  const serialized = iarnaToml.stringify(nextDoc as unknown as iarnaToml.JsonMap)
  await atomicWriteFile(input.personalConfigToml, serialized)

  return existingApiyi === undefined ? 'seeded' : 'repaired'
}

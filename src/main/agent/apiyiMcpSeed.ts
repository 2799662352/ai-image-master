import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
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
  /**
   * Injectable filesystem probe used by the stale-transport check. Defaults to
   * `fs.existsSync`; tests override it to simulate uninstalled/moved paths.
   */
  fileExists?: (p: string) => boolean
  /**
   * The app's own executable path (`process.execPath`). Used to POSITIVELY
   * identify an entry seeded in the Electron-as-Node fallback form
   * (`command === electronExecPath` + `env.ELECTRON_RUN_AS_NODE === '1'`) so
   * the electron→node upgrade never touches a user-customized command that
   * merely happens to carry the marker env. Optional: when absent, the
   * upgrade path is disabled (stale-transport repair still applies).
   */
  electronExecPath?: string
}

export type SeedAction = 'seeded' | 'backfilled' | 'repaired' | 'skipped'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Detect the "broken transport" shape that crashes codex 0.132+.
 *
 * Trigger: an existing `[mcp_servers.apiyi]` block where BOTH `command`
 * and `url` are absent (or both are non-string types). codex's
 * `McpServerConfig::deserialize` matches the final `else` branch and
 * aborts the entire config load with bare `"invalid transport"`.
 *
 * Historical cause: the v4.3.16 refactor renamed `SeedApiyiMcpInput.nodeBin`
 * → `SeedApiyiMcpInput.command`, but `src/main/index.ts` kept passing
 * `nodeBin: process.execPath`. With `command` undefined,
 * `buildApiyiMcpConfigEntry` produced an object with `command: undefined`
 * which `@iarna/toml.stringify` then dropped silently. New users who
 * first booted on v4.3.16/17 ended up with a command-less seed entry on
 * disk. v4.3.18 fixes the call site so no future user trips on this,
 * but anyone who already has the broken entry needs us to repair it.
 *
 * Returns `true` only when the entry looks salvageable as stdio — i.e.
 * neither transport field is set. If the user explicitly set
 * `url = ""`, `command = 42`, etc., we do NOT touch them (they're
 * obvious user intent we shouldn't overwrite).
 */
function isBrokenApiyiEntryMissingTransport(entry: Record<string, unknown>): boolean {
  const hasCommandKey = 'command' in entry
  const hasUrlKey = 'url' in entry
  // command/url completely absent → unambiguous: needs stdio repair.
  return !hasCommandKey && !hasUrlKey
}

/**
 * Stale stdio transport: the entry HAS a string `command`, but the command
 * and/or the first arg are absolute paths that no longer exist on disk
 * (uninstalled Node, app moved to a new install dir, old dev checkout path).
 * codex would fail the spawn every time; the entry can never heal on its own
 * because seeding is one-shot. Only absolute paths are probed — a bare
 * `node` resolves via PATH and existsSync cannot judge it, and `url` entries
 * are a different transport we must not touch.
 */
function isStaleStdioTransport(
  entry: Record<string, unknown>,
  fileExists: (p: string) => boolean,
): boolean {
  if (typeof entry.command !== 'string' || entry.command === '') return false
  if ('url' in entry) return false
  const commandStale = path.isAbsolute(entry.command) && !fileExists(entry.command)
  const arg0 =
    Array.isArray(entry.args) && typeof entry.args[0] === 'string' ? entry.args[0] : null
  const argStale = arg0 !== null && path.isAbsolute(arg0) && !fileExists(arg0)
  return commandStale || argStale
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
 * Boot-time convergence for `mcp_servers.apiyi`. Four outcomes:
 *
 *  - **'seeded'**     — entry didn't exist; write an ENABLED stub with the
 *    full APIYI_MCP_ENV_SCAFFOLD env block (base URL, model, timeouts) plus
 *    any caller-supplied `extraEnv`, and NO `APIYI_API_KEY` slot (it's
 *    injected at codex spawn from 设置 → API易, never written to disk).
 *  - **'repaired'**   — entry exists but is in the v4.3.16/17 "missing
 *    transport" broken state (`command` AND `url` both absent → codex
 *    aborts with `"invalid transport"`). We rebuild `command` + `args`
 *    from `buildApiyiMcpConfigEntry`, **preserving every user-set value**
 *    in `env`, `enabled`, `tool_timeout_sec`, `enabled_tools`, etc. Also
 *    backfills any missing scaffold env keys in the same pass (since
 *    we're already writing).
 *  - **'backfilled'** — entry exists with a valid transport, but its env
 *    block is missing one or more scaffold keys (e.g., legacy `env: {}`
 *    from an older seed, or a partial config the user wrote by hand). We
 *    **add** the missing env keys with their scaffold defaults,
 *    **preserving every user-set value**, and write the merged result
 *    back. `command` / `args` / `enabled` / `tool_timeout_sec` are NEVER
 *    touched on this path.
 *  - **'skipped'**    — entry exists, has a valid transport, AND its env
 *    block already has every scaffold key (user is in steady state;
 *    nothing to do).
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
/**
 * Read the apiyi-mcp API key that the user set DIRECTLY in `config.toml`
 * (`mcp_servers.apiyi.env.APIYI_API_KEY`). This is the SECOND supported key
 * source besides 设置 → API易 (which goes through localStorage → runtime `-c`
 * injection and never touches disk): the empty-tools card hint explicitly tells
 * users they can hand-edit `env.APIYI_API_KEY` in the MCP JSON editor.
 *
 * The launch-time "no key → keep apiyi dormant" guard MUST consult this so it
 * never disables an apiyi the user configured by hand (whose key is invisible
 * to the localStorage-fed `apiyiKey`). Returns '' when the file / entry / key
 * is missing, empty, non-string, or the TOML is unparseable — all treated as
 * "no config key". Never throws (a read/parse failure must not block spawn).
 */
export async function readApiyiConfigKey(personalConfigToml: string): Promise<string> {
  try {
    const raw = await fs.readFile(personalConfigToml, 'utf8')
    if (!raw.trim()) return ''
    let doc: Record<string, unknown>
    try {
      doc = parseToml(raw) as Record<string, unknown>
    } catch {
      return ''
    }
    const servers = isPlainObject(doc.mcp_servers) ? doc.mcp_servers : {}
    const apiyi = isPlainObject(servers.apiyi) ? servers.apiyi : null
    const env = apiyi && isPlainObject(apiyi.env) ? apiyi.env : null
    const key = env && typeof env.APIYI_API_KEY === 'string' ? env.APIYI_API_KEY : ''
    return key.trim()
  } catch {
    return ''
  }
}

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
    // Repair path: the v4.3.16/17 seed call site bug silently produced
    // entries with NO `command` (and no `url`) on disk, which codex
    // 0.132 rejects with bare `"invalid transport"`. We detect that
    // exact shape and rebuild `command` + `args` from the caller's
    // resolved binary, preserving every other user-set field. This is
    // additive: env gets backfilled in the same pass so the user lands
    // on a fully-converged entry after one boot.
    if (isBrokenApiyiEntryMissingTransport(existingApiyi)) {
      const repairedEnv = mergeEnvWithScaffold(existingApiyi.env) ?? existingApiyi.env
      const repairedApiyi: Record<string, unknown> = {
        ...existingApiyi,
        command: input.command,
        args: [input.entryPath],
        env: repairedEnv,
      }
      // Layer extraEnv on top of repaired env when provided (Electron
      // fallback's ELECTRON_RUN_AS_NODE flag). Only add keys the user
      // hasn't already set — same sacred-user-config principle as
      // mergeEnvWithScaffold.
      if (input.extraEnv && isPlainObject(repairedEnv)) {
        const envOut: Record<string, string> = { ...(repairedEnv as Record<string, string>) }
        for (const [k, v] of Object.entries(input.extraEnv)) {
          if (!(k in envOut)) envOut[k] = v
        }
        repairedApiyi.env = envOut
      }
      const nextServers = { ...existingServers, apiyi: repairedApiyi }
      const nextDoc = { ...rawDoc, mcp_servers: nextServers }
      const serialized = iarnaToml.stringify(nextDoc as unknown as iarnaToml.JsonMap)
      await atomicWriteFile(input.personalConfigToml, serialized)
      return 'repaired'
    }

    const fileExists = input.fileExists ?? existsSync
    // Upgrade trigger: the entry is OUR seeded Electron-as-Node fallback form
    // (command IS the app's own executable + marker env present) but THIS boot
    // resolved a real system node (extraEnv carries no marker). Converge to
    // the canonical node form — same shape as a fresh dev-machine seed.
    // resolveApiyiCommand's doc ("delete the entry and restart to re-seed")
    // becomes automatic. The command identity check keeps user-customized
    // commands sacred even when they carry the marker env.
    const resolvedIsSystemNode = !(input.extraEnv && 'ELECTRON_RUN_AS_NODE' in input.extraEnv)
    const entryIsSeededElectronFallback =
      typeof input.electronExecPath === 'string' &&
      existingApiyi.command === input.electronExecPath &&
      isPlainObject(existingApiyi.env) &&
      (existingApiyi.env as Record<string, unknown>).ELECTRON_RUN_AS_NODE === '1'
    const wantsUpgrade = resolvedIsSystemNode && entryIsSeededElectronFallback

    if (isStaleStdioTransport(existingApiyi, fileExists) || wantsUpgrade) {
      const mergedEnv =
        mergeEnvWithScaffold(existingApiyi.env) ??
        (isPlainObject(existingApiyi.env)
          ? ({ ...existingApiyi.env } as Record<string, string>)
          : {})
      const envOut: Record<string, string> = { ...mergedEnv }
      // Converge to the freshly resolved form: on the node path the electron
      // marker is meaningless (and misleading), so drop it; on the electron
      // path extraEnv re-adds it below.
      delete envOut.ELECTRON_RUN_AS_NODE
      for (const [k, v] of Object.entries(input.extraEnv ?? {})) {
        if (!(k in envOut)) envOut[k] = v
      }
      const repairedApiyi: Record<string, unknown> = {
        ...existingApiyi,
        command: input.command,
        args: [input.entryPath],
        env: envOut,
      }
      const nextServers = { ...existingServers, apiyi: repairedApiyi }
      const nextDoc = { ...rawDoc, mcp_servers: nextServers }
      await atomicWriteFile(
        input.personalConfigToml,
        iarnaToml.stringify(nextDoc as unknown as iarnaToml.JsonMap),
      )
      return 'repaired'
    }

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
    // Default ON, like the auto-injected key — the user shouldn't have to flip
    // a toggle. apiyi is the app's default codex gateway, so a key in 设置 →
    // API易 is the norm; that key is overlaid at spawn via `-c`, so a freshly
    // seeded entry works out of the box without any manual JSON editing.
    enabled: true,
  })

  const nextServers = { ...existingServers, apiyi: seededEntry }
  const nextDoc = { ...rawDoc, mcp_servers: nextServers }

  const serialized = iarnaToml.stringify(nextDoc as unknown as iarnaToml.JsonMap)
  await atomicWriteFile(input.personalConfigToml, serialized)

  return 'seeded'
}

import { promises as fs } from 'node:fs'
import { parse as parseToml } from 'toml'
import * as iarnaToml from '@iarna/toml'
import { atomicWriteFile } from './codexConfigStore'
import {
  CINEMATOGRAPHY_KB_ENV_SCAFFOLD,
  buildCinematographyKbMcpConfigEntry,
} from './cinematographyKbMcpLauncher'

export interface SeedCinematographyKbMcpInput {
  personalConfigToml: string
  entryPath: string
  /** Pre-resolved binary that spawns the server: system `node`, or Electron's
   * `process.execPath` (Electron-as-Node) in the packaged fallback. */
  command: string
  /** Extra env layered on the scaffold — `{}` for `node`,
   * `{ ELECTRON_RUN_AS_NODE: '1' }` for the Electron fallback. */
  extraEnv?: Record<string, string>
}

export type SeedAction = 'seeded' | 'backfilled' | 'repaired' | 'skipped'

const SERVER_KEY = 'cinematography_kb'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Shapes that must be rebuilt to THIS build's vendored Node entry:
 *  - the pre-internalization manual entry that spawned the Python wrapper
 *    (`command = "python"`, args ending in `cinematography-kb-mcp/server.py`),
 *  - a "missing transport" entry (no `command` AND no `url`) that codex rejects,
 *  - **a transport pointing somewhere other than this build** — a stale
 *    `command` (the node that got uninstalled / the Electron of a previous
 *    install) or a stale `args[0]` (the previous install directory).
 *
 * That last case is the one that bit a user on 2026-08-16: they reinstalled the
 * app from `D:\懒人猫平台\…` to `…\AppData\Local\Programs\…`, and this function
 * kept answering "healthy" because a `command` existed and it wasn't Python. So
 * node was handed a script that no longer existed, died before the handshake,
 * and codex reported `connection closed: initialize response` on every launch —
 * forever, since nothing ever re-checked. apiyi self-healed (it force-converges
 * every field each boot); this one had no such pass.
 *
 * Transport is APP-MANAGED, so converging it is safe. `env` is NOT — it stays
 * user territory and is merged additively by the caller (a hand-typed key or a
 * self-hosted DASHVECTOR_ENDPOINT must survive).
 */
function needsTransportRepair(
  entry: Record<string, unknown>,
  canonical: { command: string; entryPath: string },
): boolean {
  const hasCommand = 'command' in entry && typeof entry.command === 'string'
  const hasUrl = 'url' in entry && typeof entry.url === 'string'
  if (!hasCommand && !hasUrl) return true
  const args = Array.isArray(entry.args) ? entry.args : []
  const pointsAtPythonWrapper = args.some(
    (a) => typeof a === 'string' && /cinematography-kb-mcp[\\/]server\.py$/.test(a),
  )
  if (pointsAtPythonWrapper) return true
  // Diverged from this build → stale install path or stale interpreter.
  if (entry.command !== canonical.command) return true
  return args.length !== 1 || args[0] !== canonical.entryPath
}

/**
 * Merge scaffold env into an existing block, ADDING only absent keys.
 * User-set values are sacred and never overwritten (a user pointing
 * DASHVECTOR_ENDPOINT at their own cluster keeps it). Returns `null` when
 * nothing changed.
 *
 * Seed→skip idempotency: a fresh seed writes the scaffold env (non-empty since
 * the DashVector endpoint got baked), so the re-read env already contains every
 * scaffold key → the next merge returns `null` (skip). An ABSENT env
 * (`undefined`/`null`) gets the scaffold added → 'backfilled', which is how
 * pre-endpoint configs converge on boot.
 */
export function mergeEnvWithScaffold(existingEnv: unknown): Record<string, string> | null {
  const base = isPlainObject(existingEnv) ? existingEnv : {}
  const merged: Record<string, string> = {}
  for (const [key, val] of Object.entries(base)) {
    merged[key] = typeof val === 'string' ? val : String(val)
  }
  let changed = false
  for (const [key, scaffoldVal] of Object.entries(CINEMATOGRAPHY_KB_ENV_SCAFFOLD)) {
    if (!(key in merged)) {
      merged[key] = scaffoldVal
      changed = true
    }
  }
  // Normalize a present-but-non-object env (e.g. a stray string) into an object,
  // but leave an absent env alone when there is nothing to add.
  if (existingEnv != null && !isPlainObject(existingEnv)) changed = true
  return changed ? merged : null
}

/**
 * Boot-time convergence for `mcp_servers.cinematography_kb`. Idempotent and
 * best-effort; safe to call on every launch. Mirrors `seedApiyiMcpEntry`:
 *
 *  - 'seeded'     — entry absent → write ENABLED entry with the shared
 *    DASHSCOPE_API_KEY scaffold + Node command/args.
 *  - 'repaired'   — entry exists but is a legacy Python-wrapper / missing-
 *    transport shape → rebuild command/args to the vendored Node entry,
 *    preserving every user-set field, backfilling env in the same pass.
 *  - 'backfilled' — entry exists with a valid transport but is missing the
 *    shared key → add it, preserve everything else.
 *  - 'skipped'    — steady state; nothing to write.
 */
export async function seedCinematographyKbMcpEntry(
  input: SeedCinematographyKbMcpInput,
): Promise<SeedAction> {
  let rawDoc: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(input.personalConfigToml, 'utf8')
    if (raw.trim()) {
      try {
        rawDoc = parseToml(raw) as Record<string, unknown>
      } catch (err) {
        console.warn(
          `[cinematography-kb-mcp-seed] existing TOML at ${input.personalConfigToml} is malformed; rewriting as seed-only.`,
          err,
        )
        rawDoc = {}
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  const existingServers = isPlainObject(rawDoc.mcp_servers) ? rawDoc.mcp_servers : {}
  const existing = isPlainObject(existingServers[SERVER_KEY])
    ? (existingServers[SERVER_KEY] as Record<string, unknown>)
    : null

  if (existing) {
    if (needsTransportRepair(existing, { command: input.command, entryPath: input.entryPath })) {
      // Always resolve to a concrete object so the TOML serializer never sees an
      // `undefined` env. `mergeEnvWithScaffold` returns null when there is
      // nothing to add (empty scaffold); fall back to the user's existing env
      // (stringified) or an empty object.
      const merged = mergeEnvWithScaffold(existing.env)
      const envOut: Record<string, string> =
        merged ??
        (isPlainObject(existing.env)
          ? Object.fromEntries(
              Object.entries(existing.env as Record<string, unknown>).map(([k, v]) => [
                k,
                typeof v === 'string' ? v : String(v),
              ]),
            )
          : {})
      if (input.extraEnv) {
        for (const [k, v] of Object.entries(input.extraEnv)) {
          if (!(k in envOut)) envOut[k] = v
        }
      }
      const repaired: Record<string, unknown> = {
        ...existing,
        command: input.command,
        args: [input.entryPath],
        env: envOut,
      }
      const nextDoc = {
        ...rawDoc,
        mcp_servers: { ...existingServers, [SERVER_KEY]: repaired },
      }
      await atomicWriteFile(
        input.personalConfigToml,
        iarnaToml.stringify(nextDoc as unknown as iarnaToml.JsonMap),
      )
      return 'repaired'
    }

    const mergedEnv = mergeEnvWithScaffold(existing.env)
    if (!mergedEnv) return 'skipped'
    const nextDoc = {
      ...rawDoc,
      mcp_servers: { ...existingServers, [SERVER_KEY]: { ...existing, env: mergedEnv } },
    }
    await atomicWriteFile(
      input.personalConfigToml,
      iarnaToml.stringify(nextDoc as unknown as iarnaToml.JsonMap),
    )
    return 'backfilled'
  }

  const seededEntry = buildCinematographyKbMcpConfigEntry({
    entryPath: input.entryPath,
    command: input.command,
    extraEnv: input.extraEnv,
    enabled: true,
  })
  const nextDoc = {
    ...rawDoc,
    mcp_servers: { ...existingServers, [SERVER_KEY]: seededEntry },
  }
  await atomicWriteFile(
    input.personalConfigToml,
    iarnaToml.stringify(nextDoc as unknown as iarnaToml.JsonMap),
  )
  return 'seeded'
}

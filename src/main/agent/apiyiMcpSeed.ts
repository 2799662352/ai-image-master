import { promises as fs } from 'node:fs'
import { parse as parseToml } from 'toml'
import * as iarnaToml from '@iarna/toml'
import { atomicWriteFile } from './codexConfigStore'
import { buildApiyiMcpConfigEntry } from './apiyiMcpLauncher'

export interface SeedApiyiMcpInput {
  personalConfigToml: string
  entryPath: string
  nodeBin: string
}

export type SeedAction = 'seeded' | 'skipped' | 'migrated'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Boot-time convergence for `mcp_servers.apiyi`. Three outcomes:
 *
 *  - **'seeded'**   — entry didn't exist; write a disabled stub.
 *  - **'migrated'** — entry exists but its `env` is missing
 *    `ELECTRON_RUN_AS_NODE = "1"`. Patch ONLY the env (preserve
 *    `command`, `args`, `enabled`, `APIYI_API_KEY`, `GEMINI_MODEL`,
 *    everything the user / settings UI wrote).
 *  - **'skipped'**  — entry exists and already has
 *    `ELECTRON_RUN_AS_NODE = "1"` in its env. No write.
 *
 * The migration path is critical for v4.3.16+ users upgrading from an
 * earlier dev build that wrote the entry without `ELECTRON_RUN_AS_NODE`.
 * Without that env var Electron's binary launches as a GUI-subsystem
 * process and pollutes stdout, breaking MCP stdio framing — Codex sees
 * `tools=[]` even when APIYI_API_KEY is correct.
 *
 * Safe to call on every app boot; idempotent. Malformed existing TOML
 * is treated as empty (a console.warn is emitted, the disk file is
 * overwritten with a clean seeded version — preferable to silently
 * failing).
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

  // Migration: entry exists but env doesn't have ELECTRON_RUN_AS_NODE.
  if (existingApiyi) {
    const existingEnv = isPlainObject(existingApiyi.env) ? existingApiyi.env : {}
    if (existingEnv.ELECTRON_RUN_AS_NODE === '1') {
      return 'skipped'
    }
    const patchedEntry = {
      ...existingApiyi,
      env: { ELECTRON_RUN_AS_NODE: '1', ...existingEnv },
    }
    const nextServers = { ...existingServers, apiyi: patchedEntry }
    const nextDoc = { ...rawDoc, mcp_servers: nextServers }
    const serialized = iarnaToml.stringify(nextDoc as unknown as iarnaToml.JsonMap)
    await atomicWriteFile(input.personalConfigToml, serialized)
    return 'migrated'
  }

  const seededEntry = buildApiyiMcpConfigEntry({
    entryPath: input.entryPath,
    nodeBin: input.nodeBin,
    enabled: false,
  })

  const nextServers = { ...existingServers, apiyi: seededEntry }
  const nextDoc = { ...rawDoc, mcp_servers: nextServers }

  const serialized = iarnaToml.stringify(nextDoc as unknown as iarnaToml.JsonMap)
  await atomicWriteFile(input.personalConfigToml, serialized)

  return 'seeded'
}

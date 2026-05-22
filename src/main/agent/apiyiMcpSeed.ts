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

export type SeedAction = 'seeded' | 'skipped'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Boot-time stub for `mcp_servers.apiyi`. Two outcomes:
 *
 *  - **'seeded'**  — entry didn't exist; write a disabled stub whose env block
 *    is pre-filled with the APIYI_MCP_ENV_SCAFFOLD (base URL, model, timeouts,
 *    ELECTRON_RUN_AS_NODE, etc.) and an empty `APIYI_API_KEY` slot for the
 *    user to fill in via the MCP JSON editor.
 *  - **'skipped'** — entry exists in ANY shape; leave it alone (the user is
 *    the source of truth for env / enabled, edited via the MCP JSON editor).
 *
 * We do NOT migrate, patch, or overwrite an existing entry. The user's
 * config.toml is sacred once it exists. After a fresh seed, the only field
 * the user has to fill is `APIYI_API_KEY` — everything else (incl. the
 * `https://api.apiyi.com` base URL that makes a `sk-...` apiyi key work) is
 * already in place. They flip `enabled = true` after pasting the key.
 *
 * Safe to call on every app boot; idempotent. Malformed existing TOML is
 * treated as empty (a console.warn is emitted, the disk file is overwritten
 * with a clean seeded version — preferable to silently failing).
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
    return 'skipped'
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

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
 *  - **'seeded'**  — entry didn't exist; write a disabled stub with empty env.
 *  - **'skipped'** — entry exists in ANY shape; leave it alone (the user is
 *    the source of truth for env / enabled, edited via the MCP JSON editor).
 *
 * We do NOT migrate, patch, or overwrite an existing entry. The user's
 * config.toml is sacred once it exists. This also means the apiyi-mcp tool
 * won't work until the user manually edits the entry to add at minimum:
 *
 *   [mcp_servers.apiyi.env]
 *   APIYI_API_KEY = "sk-..."
 *   ELECTRON_RUN_AS_NODE = "1"   # required when command is electron.exe
 *   GEMINI_MODEL = "gemini-3.5-flash"
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

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
 * First-boot seed: ensure `mcp_servers.apiyi` exists in the personal
 * codex config.toml with `enabled: false`. Never overwrites an existing
 * `mcp_servers.apiyi` entry — respects manual user edits.
 *
 * Returns 'seeded' when we wrote, 'skipped' when the entry already existed.
 *
 * Safe to call on every app boot; idempotent. Malformed existing TOML is
 * treated as empty (a console.warn is emitted, the disk file is overwritten
 * with a clean seeded version — this is preferable to silently failing).
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
  if (isPlainObject(existingServers.apiyi)) {
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

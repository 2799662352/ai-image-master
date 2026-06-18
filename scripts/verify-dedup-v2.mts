// Verify the v2 historyDedup rule against the REAL dirty rows. Opens the
// PGlite data dir directly (app must be CLOSED). Read-only: never writes.
import { PGlite } from '@electric-sql/pglite'
import path from 'node:path'
import os from 'node:os'
import { dedupeRetryArtifactItems } from '../src/main/agent/historyDedup'

const dataDir = path.join(os.homedir(), 'AppData', 'Roaming', 'catimation-cyberpunk-master', 'pgdata')
const db = await PGlite.create(dataDir)

const { rows } = await db.query<{ id: string; items: unknown }>(
  `SELECT id, items FROM "AgentMessage" WHERE role = 'assistant' ORDER BY "createdAt" DESC LIMIT 300`,
)

let dirty = 0
let totalRemoved = 0
for (const row of rows) {
  const cleaned = dedupeRetryArtifactItems(row.items)
  if (cleaned === null) continue
  dirty++
  const removed = (row.items as unknown[]).length - cleaned.length
  totalRemoved += removed
  console.log(`${row.id}: ${(row.items as unknown[]).length} -> ${cleaned.length} (-${removed})`)
}
console.log(`\nscanned ${rows.length}, v2 rule would clean ${dirty} rows, removing ${totalRemoved} items`)

// Spotlight the forensic row from the live repro
const target = rows.find((r) => r.id === 'cmq7z96v60002ccn7zpsf7chw')
if (target) {
  const cleaned = dedupeRetryArtifactItems(target.items)
  if (cleaned) {
    console.log('\nforensic row cmq7z96v60002ccn7zpsf7chw after cleanup:')
    for (const it of cleaned) {
      const c = typeof (it as { content?: unknown }).content === 'string' ? (it as { content: string }).content : ''
      console.log(`  ${(it as { type: string }).type} len=${c.length} head="${c.slice(0, 40).replace(/\n/g, '\\n')}"`)
    }
  } else {
    console.log('\nforensic row: rule reports no change (unexpected)')
  }
}

await db.close()

// Timeline forensic: cadence and ids of the duplicated items.
import { PGlite } from '@electric-sql/pglite'
import path from 'node:path'
import os from 'node:os'

const dataDir = path.join(os.homedir(), 'AppData', 'Roaming', 'catimation-cyberpunk-master', 'pgdata')
const db = await PGlite.create(dataDir)
const { rows } = await db.query(
  `SELECT items FROM "AgentMessage" WHERE id = 'cmq7z96v60002ccn7zpsf7chw'`,
)
const items = rows[0].items
let prev = null
const lines = []
for (let i = 0; i < items.length; i++) {
  const it = items[i]
  const len = typeof it.content === 'string' ? it.content.length : (it.command ? `cmd` : '-')
  const dt = prev != null ? it.startedAt - prev : 0
  prev = it.startedAt
  lines.push(`[${String(i).padStart(3)}] ${new Date(it.startedAt).toISOString().slice(11, 23)} (+${String(dt).padStart(6)}ms) ${it.type.padEnd(9)} id=${String(it.id).slice(0, 24).padEnd(24)} len=${len} ended=${it.endedAt != null}`)
}
console.log(lines.slice(0, 30).join('\n'))
console.log('...')
console.log(lines.slice(-12).join('\n'))
const span = items[items.length - 1].startedAt - items[0].startedAt
console.log(`\ntotal span: ${(span / 1000).toFixed(1)}s, items: ${items.length}`)
await db.close()

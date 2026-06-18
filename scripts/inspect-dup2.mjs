// Replay historyDedup's rule against the real dirty row to see why it missed.
import { PGlite } from '@electric-sql/pglite'
import path from 'node:path'
import os from 'node:os'

const dataDir = path.join(os.homedir(), 'AppData', 'Roaming', 'catimation-cyberpunk-master', 'pgdata')
const db = await PGlite.create(dataDir)

const { rows } = await db.query(
  `SELECT id, items, "createdAt" FROM "AgentMessage" WHERE id = 'cmq7z96v60002ccn7zpsf7chw'`,
)
const row = rows[0]
if (!row) {
  console.log('row not found')
  process.exit(0)
}
console.log('createdAt:', row.createdAt)
const items = row.items
console.log('items:', items.length)

// dump first few items' shape
for (const i of [0, 1, 2, 3, 5, 7]) {
  const it = items[i]
  console.log(`item[${i}]`, JSON.stringify({ ...it, content: typeof it.content === 'string' ? it.content.slice(0, 60) : it.content, text: typeof it.text === 'string' ? it.text.slice(0, 60) : undefined }, null, 0))
}

// replicate historyDedup
const MIN = 8
const DEDUP = new Set(['text', 'reasoning'])
const contentOf = (it) => (it.type === 'text' || it.type === 'reasoning') && typeof it.content === 'string' ? it.content.trimEnd() : null
const isArr = Array.isArray(items) && items.every((v) => v && typeof v === 'object' && typeof v.type === 'string')
console.log('isTimelineItemArray:', isArr)

const keep = new Array(items.length).fill(true)
for (let i = 0; i < items.length; i++) {
  if (!DEDUP.has(items[i].type)) continue
  const earlier = contentOf(items[i])
  if (earlier === null || earlier.length < MIN) continue
  for (let j = i + 1; j < items.length; j++) {
    if (items[j].type !== items[i].type) continue
    const later = contentOf(items[j])
    if (later !== null && later.startsWith(earlier)) { keep[i] = false; break }
  }
}
const removed = keep.filter((k) => !k).length
console.log('would remove:', removed, 'of', items.length)

// also: check the last 6 items (what the final message looks like)
for (let i = items.length - 4; i < items.length; i++) {
  const it = items[i]
  const c = typeof it.content === 'string' ? it.content : ''
  console.log(`tail item[${i}] type=${it.type} len=${c.length} head="${c.slice(0, 50).replace(/\n/g, '\\n')}"`)
}
await db.close()

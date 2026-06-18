// One-off forensic: inspect recent assistant messages for duplicated text,
// both WITHIN a single text item and ACROSS items. Opens the PGlite dataDir
// directly (app must NOT be running).
import { PGlite } from '@electric-sql/pglite'
import path from 'node:path'
import os from 'node:os'

const dataDir = path.join(os.homedir(), 'AppData', 'Roaming', 'catimation-cyberpunk-master', 'pgdata')
const db = await PGlite.create(dataDir)

const { rows } = await db.query(`
  SELECT m.id, m."threadId", m."createdAt", m.items
  FROM "AgentMessage" m
  WHERE m.role = 'assistant'
  ORDER BY m."createdAt" DESC
  LIMIT 40
`)

function findInternalRepeat(text) {
  const paras = text.split(/\n+/).map((p) => p.trim()).filter((p) => p.length >= 20)
  const counts = new Map()
  for (const p of paras) counts.set(p, (counts.get(p) ?? 0) + 1)
  return [...counts.entries()].filter(([, c]) => c >= 2)
}

for (const row of rows) {
  const items = Array.isArray(row.items) ? row.items : []
  const textItems = items.filter((it) => it && (it.type === 'text' || it.type === 'reasoning'))
  const report = []

  for (let i = 0; i < textItems.length; i++) {
    for (let j = i + 1; j < textItems.length; j++) {
      const a = (textItems[i].text ?? textItems[i].content ?? '').trim()
      const b = (textItems[j].text ?? textItems[j].content ?? '').trim()
      if (!a || !b) continue
      if (a === b || (a.length >= 8 && b.startsWith(a)) || (b.length >= 8 && a.startsWith(b))) {
        report.push(`CROSS-ITEM dup: item[${i}](${textItems[i].type},${a.length}ch) vs item[${j}](${textItems[j].type},${b.length}ch)`)
      }
    }
  }

  for (let i = 0; i < textItems.length; i++) {
    const t = textItems[i].text ?? textItems[i].content ?? ''
    const dups = findInternalRepeat(t)
    if (dups.length > 0) {
      report.push(
        `INTERNAL repeat in item[${i}](${textItems[i].type},${t.length}ch): ` +
          dups.map(([p, c]) => `"${p.slice(0, 50)}..." x${c}`).join(' | '),
      )
    }
  }

  if (report.length > 0) {
    const created = row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt)
    console.log(`\n=== msg ${row.id} thread ${row.threadId} at ${created} items=${items.length} ===`)
    console.log('item types:', items.map((it) => it?.type).join(','))
    for (const r of report) console.log('  ' + r)
  }
}

console.log(`\nscanned ${rows.length} recent assistant messages`)
await db.close()

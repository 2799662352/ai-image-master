// One-off probe: spawn the bundled `codex app-server` and dump every feature
// flag (`experimentalFeature/list`) with its stage + default-enabled state.
//
// Purpose: discover the EXACT feature key for gated capabilities (memory,
// goals, personality, …) straight from the shipped 0.142.2 binary — no
// guessing from docs. Read-only; needs no OPENAI_API_KEY.
//
// Usage:  npx tsx scripts/probe-codex-features.ts

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CodexLocalBackend } from '../src/main/agent/CodexLocalBackend'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const resourceRoot = path.join(projectRoot, 'resources')

async function main(): Promise<void> {
  const backend = new CodexLocalBackend({ resourceRoot })
  await backend.start()
  console.log('[probe] app-server up — listing feature flags…\n')
  try {
    type FeatureRow = { name: string; stage: string; enabled: boolean; defaultEnabled: boolean }
    const all: FeatureRow[] = []
    let cursor: string | undefined
    do {
      const page = (await backend.experimentalFeatureList({ cursor, limit: 200 })) as unknown as {
        data?: FeatureRow[]
        nextCursor?: string
      }
      all.push(...(page.data ?? []))
      cursor = page.nextCursor
    } while (cursor)

    all.sort((a, b) => a.name.localeCompare(b.name))
    for (const f of all) {
      const mark = /memor|goal|personalit|project|doc|root|environ|workspace/i.test(f.name) ? ' <=' : ''
      console.log(
        `  ${f.name.padEnd(42)} stage=${String(f.stage).padEnd(18)} enabled=${String(f.enabled).padEnd(5)} default=${f.defaultEnabled}${mark}`,
      )
    }
    console.log(`\n[probe] ${all.length} features total.`)
    const memory = all.find((f) => /memor/i.test(f.name))
    console.log(
      memory
        ? `[probe] MEMORY KEY = "${memory.name}"  (stage=${memory.stage}, default=${memory.defaultEnabled})`
        : '[probe] no "memory" feature found in this binary.',
    )
  } finally {
    await backend.stop()
  }
}

main().catch((error) => {
  console.error('[probe] FAIL:', error instanceof Error ? error.message : error)
  process.exit(1)
})

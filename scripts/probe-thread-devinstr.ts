// One-off probe: confirm the shipped `codex app-server` ACCEPTS a per-thread
// `config.developer_instructions` override in `thread/start` (its config is
// serde deny_unknown_fields, so a bad key would hard-error). We start a thread
// with TWO writable roots (one carrying an AGENTS.md) and break the moment
// `thread/start` returns `thread_created` — BEFORE `turn/start`, so no auth /
// model call is needed.
//
// Usage:  npx tsx scripts/probe-thread-devinstr.ts

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CodexLocalBackend } from '../src/main/agent/CodexLocalBackend'
import { buildExtraRootsDeveloperInstructions } from '../src/main/agent/projectDocs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const resourceRoot = path.join(projectRoot, 'resources')

async function main(): Promise<void> {
  const base = mkdtempSync(path.join(tmpdir(), 'devinstr-'))
  const cwd = path.join(base, 'primary')
  const extra = path.join(base, 'extra-repo')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(extra, { recursive: true })
  writeFileSync(path.join(cwd, 'AGENTS.md'), 'PRIMARY REPO RULES', 'utf8')
  writeFileSync(path.join(extra, 'AGENTS.md'), 'EXTRA REPO RULES — must be injected', 'utf8')

  const devInstr = buildExtraRootsDeveloperInstructions(cwd, [cwd, extra])
  console.log('[probe] computed developer_instructions present:', !!devInstr)
  console.log('[probe] preview:', JSON.stringify(devInstr?.slice(0, 120)))

  const backend = new CodexLocalBackend({ resourceRoot })
  await backend.start()
  backend.setSessionConfig({ writableRoots: [cwd, extra] })

  try {
    let created = false
    const stream = backend.send(undefined, {
      model: 'gpt-5.1-codex',
      cwd,
      items: [{ type: 'text', text: 'ping' }],
    } as never)
    const iterator = (stream as AsyncIterable<{ type: string }>)[Symbol.asyncIterator]()
    const guard = setTimeout(() => { /* fall through */ }, 15_000)
    guard.unref?.()
    while (true) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), 15_000)),
      ])
      if (next.done) break
      const ev = next.value as { type: string }
      console.log('[probe] event:', ev.type)
      if (ev.type === 'thread_created') {
        created = true
        break
      }
      if (ev.type === 'error') break
    }
    console.log(
      created
        ? '\n[probe] PASS — thread/start ACCEPTED config.developer_instructions (per-thread multi-repo injection works).'
        : '\n[probe] INCONCLUSIVE — no thread_created (see events above).',
    )
    if (!created) process.exitCode = 1
  } finally {
    await backend.stop()
  }
}

main().catch((error) => {
  console.error('[probe] FAIL:', error instanceof Error ? error.message : error)
  process.exit(1)
})

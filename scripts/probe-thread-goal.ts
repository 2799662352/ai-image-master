// One-off probe: exercise the native `/goal` app-server surface against the
// SHIPPED codex binary (thread/goal/set|get|clear). Confirms:
//   1. set → returns a goal object with the documented fields
//   2. get → reads it back
//   3. set { status: 'paused' } → whether `paused` is an accepted SETTABLE
//      status (README enum omits it; TUI /goal pause implies it exists)
//   4. clear → removes it
// We materialize a thread via `send` (break on `thread_created`, BEFORE the
// model call) so no OPENAI_API_KEY is needed — goal ops are local SQLite.
//
// Usage:  npx tsx scripts/probe-thread-goal.ts

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CodexLocalBackend } from '../src/main/agent/CodexLocalBackend'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const resourceRoot = path.join(path.resolve(__dirname, '..'), 'resources')

async function materializeThread(backend: CodexLocalBackend, cwd: string): Promise<string | undefined> {
  const stream = backend.send(undefined, {
    model: 'gpt-5.1-codex',
    cwd,
    items: [{ type: 'text', text: 'ping' }],
  } as never)
  const it = (stream as AsyncIterable<{ type: string; threadId?: string }>)[Symbol.asyncIterator]()
  while (true) {
    const next = await Promise.race([
      it.next(),
      new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), 15_000)),
    ])
    if (next.done) return undefined
    const ev = next.value as { type: string; threadId?: string }
    if (ev.type === 'thread_created') return ev.threadId
    if (ev.type === 'error') return undefined
  }
}

async function main(): Promise<void> {
  const cwd = mkdtempSync(path.join(tmpdir(), 'goal-'))
  const backend = new CodexLocalBackend({ resourceRoot })
  await backend.start()
  backend.setSessionConfig({ writableRoots: [cwd] })

  try {
    const threadId = await materializeThread(backend, cwd)
    console.log('[probe] threadId:', threadId)
    if (!threadId) {
      console.log('[probe] INCONCLUSIVE — no thread_created')
      process.exitCode = 1
      return
    }

    const set = await backend.setThreadGoal({
      threadId,
      objective: 'Keep tests green while migrating',
      tokenBudget: 200000,
    })
    console.log('[probe] set →', JSON.stringify(set.goal))

    const got = await backend.getThreadGoal(threadId)
    console.log('[probe] get →', JSON.stringify(got.goal))

    // Does the binary accept `paused` as a settable status? (Decides whether
    // Option A can ship /goal pause|resume now.)
    let pausedAccepted = false
    try {
      const paused = await backend.setThreadGoal({ threadId, status: 'paused' as never })
      pausedAccepted = true
      console.log('[probe] set{status:paused} ACCEPTED →', JSON.stringify(paused.goal))
    } catch (err) {
      console.log('[probe] set{status:paused} REJECTED →', err instanceof Error ? err.message : String(err))
    }

    // Also probe `blocked` (documented) as a control.
    try {
      const blocked = await backend.setThreadGoal({ threadId, status: 'blocked' as never })
      console.log('[probe] set{status:blocked} ACCEPTED →', JSON.stringify(blocked.goal))
    } catch (err) {
      console.log('[probe] set{status:blocked} REJECTED →', err instanceof Error ? err.message : String(err))
    }

    const cleared = await backend.clearThreadGoal(threadId)
    console.log('[probe] clear →', JSON.stringify(cleared))

    const afterClear = await backend.getThreadGoal(threadId)
    console.log('[probe] get after clear →', JSON.stringify(afterClear.goal))

    console.log(
      `\n[probe] PASS — set/get/clear round-trip OK. pause settable = ${pausedAccepted}.`,
    )
  } finally {
    await backend.stop()
  }
}

main().catch((error) => {
  console.error('[probe] FAIL:', error instanceof Error ? error.message : error)
  process.exit(1)
})

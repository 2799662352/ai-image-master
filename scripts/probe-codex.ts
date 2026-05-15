// Standalone probe: spawns the bundled `codex app-server`, runs ONE turn, prints
// events, and exits 0 on success. Requires OPENAI_API_KEY in the environment.
//
// Usage:
//   $env:OPENAI_API_KEY = "sk-..."   # PowerShell
//   npm run codex:probe
//
// This is the manual verification gate before Task 7 (dev-startup verification).
// Runs under bare Node via `tsx` — does NOT require Electron at runtime; it
// uses CodexLocalBackend's `resourceRoot` option to bypass `app.getAppPath()`.

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CodexLocalBackend } from '../src/main/agent/CodexLocalBackend'
import type { AgentStreamEvent } from '../src/types/agent'

const PROBE_TIMEOUT_MS = 30_000
const PROBE_PROMPT = 'reply with the literal word READY and nothing else'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
// CodexLocalBackend's `resourceRoot` is the directory passed to `resolveCodexBinary`,
// i.e. the parent of the `codex/<platform>-<arch>/` subtree. In dev that's
// `<projectRoot>/resources` (matches `getCodexResourceRoot()` for `isPackaged=false`).
const resourceRoot = path.join(projectRoot, 'resources')

async function runProbe(events: AgentStreamEvent[]): Promise<void> {
  const backend = new CodexLocalBackend({ resourceRoot })
  await backend.start()
  console.log('[probe] backend started')
  try {
    for await (const event of backend.send(undefined, {
      model: 'gpt-5-codex',
      cwd: projectRoot,
      items: [{ type: 'text', text: PROBE_PROMPT }],
      content: PROBE_PROMPT,
      attachments: [],
    })) {
      console.log('[probe]', event.type, event.delta ?? '')
      events.push(event)
      if (event.type === 'turn_completed' || event.type === 'error' || event.type === 'cancelled') break
    }
  } finally {
    await backend.stop()
  }
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error('[probe] OPENAI_API_KEY is required to run the Codex probe.')
    console.error('[probe] PowerShell: $env:OPENAI_API_KEY = "sk-..."')
    process.exit(2)
  }

  const events: AgentStreamEvent[] = []
  let timeoutHandle: NodeJS.Timeout | undefined

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      const tail = events.slice(-5)
      console.error(`[probe] TIMEOUT after ${PROBE_TIMEOUT_MS}ms`)
      console.error('[probe] last events (up to 5):', JSON.stringify(tail, null, 2))
      reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`))
    }, PROBE_TIMEOUT_MS)
    timeoutHandle.unref?.()
  })

  try {
    await Promise.race([runProbe(events), timeoutPromise])
  } catch (error) {
    console.error('[probe] FAILED:', error instanceof Error ? error.message : error)
    if (timeoutHandle) clearTimeout(timeoutHandle)
    process.exit(1)
  }

  if (timeoutHandle) clearTimeout(timeoutHandle)

  const sawCompleted = events.some((e) => e.type === 'turn_completed')
  const sawReady = events.some(
    (e) => e.type === 'message_delta' && (e.delta ?? '').toLowerCase().includes('ready'),
  )
  if (!sawCompleted || !sawReady) {
    console.error('[probe] FAILED — expected turn_completed and a message containing READY')
    console.error('[probe] events:', JSON.stringify(events, null, 2))
    process.exit(1)
  }
  console.log('[probe] OK')
}

main().catch((error) => {
  console.error('[probe] unexpected error:', error)
  process.exit(1)
})

// Offline smoke for the EXPERIMENTAL collaborationMode surface against the
// REAL bundled codex binary (no OPENAI_API_KEY needed — read-only RPCs only).
//
// What this answers before we build UI on top:
//   1. Does the bundled binary accept `capabilities: { experimentalApi: true }`
//      at initialize? (older/newer schema drift would fail the handshake)
//   2. Does `collaborationMode/list` exist + return presets on this binary,
//      and what are their exact names/masks?
//   3. Control: WITHOUT the capability, is the RPC properly rejected with the
//      "requires experimentalApi capability" error (so our gating matches)?
//
// Usage:  npx tsx scripts/smoke-collaboration-mode.ts

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CodexLocalBackend } from '../src/main/agent/CodexLocalBackend'

const SMOKE_TIMEOUT_MS = 45_000

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const resourceRoot = path.join(path.resolve(__dirname, '..'), 'resources')

async function probe(experimentalApi: boolean): Promise<void> {
  // Deliberately NO catimationMcp here: a dead-port MCP makes codex retry the
  // rmcp transport and can stall thread/turn start (see smoke-codex-start.ts),
  // which would mask what this probe measures. Config parsing of the full prod
  // arg set is already covered by smoke-codex-start.ts.
  const backend = new CodexLocalBackend({
    resourceRoot,
    experimentalApi,
  })

  const t0 = Date.now()
  await backend.start()
  console.log(`[smoke] ✅ initialize OK with experimentalApi=${experimentalApi} (${Date.now() - t0}ms)`)

  try {
    const result = await backend.listCollaborationModes()
    console.log(`[smoke] ${experimentalApi ? '✅' : '⚠️ UNEXPECTED'} collaborationMode/list →`,
      JSON.stringify(result, null, 2))
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (experimentalApi) {
      throw new Error(`collaborationMode/list failed even WITH the capability: ${msg}`)
    }
    console.log(`[smoke] ✅ control: rejected without capability — "${msg}"`)
  }

  if (experimentalApi) {
    await probeTurnStartParam(backend)
  }
  await backend.stop()
}

/**
 * Parse-level check that `turn/start` PARSES the `collaborationMode` param on
 * this binary — WITHOUT ever running a turn (a valid payload could start a
 * real model call if the local CODEX_HOME happens to be authenticated). We
 * send a deliberately malformed `mode: "bogus"`: if the binary knows the
 * field, serde rejects at deserialization with an "unknown variant" error
 * that proves the field (and its enum) is wired; if the binary did NOT know
 * the field at all, deny_unknown_fields would instead complain about
 * `collaborationMode` itself being unknown.
 */
async function probeTurnStartParam(backend: CodexLocalBackend): Promise<void> {
  const input = {
    model: 'gpt-5.2-codex',
    cwd: process.cwd(),
    items: [{ type: 'text' as const, text: 'smoke: ignore' }],
    collaborationMode: {
      mode: 'bogus',
      settings: { model: 'gpt-5.2-codex', reasoning_effort: null, developer_instructions: null },
    },
  }
  try {
    const iterator = backend.send(undefined, input as never)[Symbol.asyncIterator]()
    await Promise.race([
      (async () => { await iterator.next(); await iterator.next() })(),
      new Promise<never>((_r, reject) => setTimeout(() => reject(new Error('turn/start probe timed out')), 15_000)),
    ])
    throw new Error('turn/start unexpectedly ACCEPTED mode:"bogus" — field may be ignored, not parsed')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (/unknown variant/i.test(msg)) {
      console.log(`[smoke] ✅ turn/start parses collaborationMode (rejected bogus enum: "${msg.slice(0, 140)}")`)
      return
    }
    if (/unknown field.*collaborationMode/i.test(msg)) {
      throw new Error(`binary does NOT know turn/start.collaborationMode: ${msg}`)
    }
    throw error instanceof Error ? error : new Error(msg)
  }
}

async function main(): Promise<void> {
  let timeout: NodeJS.Timeout | undefined
  const guard = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`smoke timed out after ${SMOKE_TIMEOUT_MS}ms`)), SMOKE_TIMEOUT_MS)
    timeout.unref?.()
  })
  try {
    await Promise.race([(async () => {
      await probe(true)
      await probe(false)
    })(), guard])
    if (timeout) clearTimeout(timeout)
    console.log('\n[smoke] PASS — experimentalApi capability + collaborationMode/list verified on bundled binary.')
  } catch (error) {
    if (timeout) clearTimeout(timeout)
    console.error('\n[smoke] FAIL:', error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('[smoke] unexpected error:', error)
  process.exit(1)
})

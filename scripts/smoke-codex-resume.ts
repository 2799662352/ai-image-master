// Standalone CLI smoke for the `thread/resume` CRASH-CONTINUITY fix (the path
// behind "闪退后同一对话无法连续对话") against the REAL bundled `codex app-server`.
//
// This is a thin wrapper over the shared `evals/harness/resumeClient` runners so
// the wire logic has a SINGLE source of truth — the same code the repeatable
// eval (`evals/scenarios/thread_resume_recall.eval.ts`) exercises. Everything
// talks raw JSON-RPC over WebSocket, so it INDEPENDENTLY verifies the wire
// method names/shapes against the binary and reads the model's reply straight
// from `item/completed#agentMessage` (gateway-agnostic).
//
// Two tiers, picked automatically:
//
//   CORE  (always, OFFLINE — no API key needed)
//     A: spawn → initialize → thread/start → start an unauthenticated turn so
//     Codex persists session metadata + the user message; kill A.
//     B: spawn (same CODEX_HOME) → thread/resume{threadId}. PASS only when the
//     exact persisted thread is reopened by the fresh generation.
//
//   MEMORY (only when OPENAI_API_KEY / SMOKE_CODEX_API_KEY is set — needs network)
//     A: thread/start → turn "remember SECRET=…" (PERSISTS the rollout); kill A;
//     B: spawn → thread/resume RESOLVES → turn "what was SECRET?".
//     PASS = B's reply echoes the secret → context truly preserved across restart.
//
// Usage:
//   npx tsx scripts/smoke-codex-resume.ts                                  # CORE only
//   $env:OPENAI_API_KEY="sk-..."; $env:SMOKE_CODEX_BASE_URL="https://api.apiyi.com/v1"
//     $env:SMOKE_CODEX_MODEL="gpt-5.5"; npx tsx scripts/smoke-codex-resume.ts   # + MEMORY

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { runResumeCore, runResumeRecall } from '../evals/harness/resumeClient'
import { resolveCodexBinary } from '../src/main/agent/paths'
import type { CodexProviderConfig } from '../src/main/agent/codexLaunch'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const resourceRoot = path.join(projectRoot, 'resources')
const SECRET = 'BANANA-42'

function log(msg: string): void {
  console.log(`[resume-smoke] ${msg}`)
}

async function main(): Promise<void> {
  log('Codex thread/resume end-to-end smoke')
  const binaryPath = resolveCodexBinary(resourceRoot)

  // ── CORE (offline) ──
  const core = await runResumeCore({
    binaryPath,
    cwd: projectRoot,
    log,
  })
  log('CORE ✅ PASS — thread/resume reopened the persisted thread from disk')

  // ── MEMORY (online) ──
  const apiKey = (process.env.SMOKE_CODEX_API_KEY || process.env.OPENAI_API_KEY || '').trim()
  if (!apiKey) {
    log('MEMORY tier ⏭️ SKIPPED — set OPENAI_API_KEY (+ SMOKE_CODEX_BASE_URL/MODEL) to verify real context recall')
    log('DONE')
    return
  }

  log('API key detected → running MEMORY tier (real turns)')
  const provider: CodexProviderConfig = {
    id: 'smoke',
    name: 'Smoke Provider',
    baseUrl: process.env.SMOKE_CODEX_BASE_URL || 'https://api.apiyi.com/v1',
    envKey: process.env.SMOKE_CODEX_ENV_KEY || 'OPENAI_API_KEY',
    model: process.env.SMOKE_CODEX_MODEL || 'gpt-5.5',
    wireApi: 'responses',
  }
  const memory = await runResumeRecall({
    binaryPath,
    provider,
    apiKey,
    model: provider.model!,
    cwd: projectRoot,
    secret: SECRET,
    log,
  })
  if (!memory.recalled) {
    throw new Error(`MEMORY ❌ FAIL — answer did not contain ${memory.secret} (context not preserved)`)
  }
  log(`MEMORY ✅ PASS — model recalled ${memory.secret} after restart+resume (context preserved end-to-end)`)
  log('DONE')
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(__filename)
) {
  main().catch((error) => {
    console.error('[resume-smoke] FAIL:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
}

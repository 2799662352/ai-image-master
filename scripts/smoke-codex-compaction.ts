// ONLINE smoke that PROVES real context compaction happens end-to-end.
//
// Unlike scripts/smoke-codex-start.ts (offline handshake only), this spawns the
// REAL bundled `codex app-server` with the FULL production launch args, then
// temporarily pins `model_auto_compact_token_limit` VERY LOW and feeds a big
// context so Codex auto-compacts. It listens on the live `send()` stream and
// prints, with timestamps:
//
//   1. the `contextCompaction` item  → item/started  → item/completed
//   2. every `thread/tokenUsage/updated` (contextUsage / contextWindow / last)
//   3. the BEFORE→AFTER drop in contextUsage — the "回落" that proves history
//      was actually summarized + dropped, not just re-counted.
//
// This REQUIRES a working model turn, so it needs credentials. It is deliberately
// NOT wired into `npm test` (no key in CI). Run it by hand:
//
//   # PowerShell
//   $env:SMOKE_CODEX_API_KEY   = "sk-..."                       # provider key
//   $env:SMOKE_CODEX_BASE_URL  = "https://api.apiyi.com/v1"     # OpenAI-compatible gateway (or https://api.openai.com/v1)
//   $env:SMOKE_CODEX_MODEL     = "gpt-5.1"                       # a model the gateway serves
//   npx tsx scripts/smoke-codex-compaction.ts
//
// Optional tuning:
//   SMOKE_AUTO_COMPACT_LIMIT   auto-compact token threshold   (default 12000)
//   SMOKE_CONTEXT_WINDOW       declared model context window   (default 40000; limit must be < 90% of this)
//   SMOKE_BLOB_CHARS           size of the padding blob        (default 80000 chars ≈ ~20k tokens)
//   SMOKE_MAX_TRIGGER_TURNS    trivial turns to run after the blob (default 3)

import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CodexLocalBackend } from '../src/main/agent/CodexLocalBackend'
import type { CodexProviderConfig } from '../src/main/agent/codexLaunch'
import type { AgentInput } from '../src/main/agent/types'
import type { AgentStreamEvent, AgentTokenUsage } from '../src/types/agent'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const resourceRoot = path.join(projectRoot, 'resources')

const SMOKE_TIMEOUT_MS = 240_000

function reqEnv(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) {
    throw new Error(
      `missing required env ${name}. See the header of this file for the full list ` +
        `(SMOKE_CODEX_API_KEY / SMOKE_CODEX_BASE_URL / SMOKE_CODEX_MODEL).`,
    )
  }
  return v
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function ts(): string {
  return new Date().toISOString().slice(11, 23) // HH:MM:SS.mmm
}

function log(msg: string): void {
  console.log(`[${ts()}] ${msg}`)
}

function fmtUsage(u: AgentTokenUsage): string {
  const parts = [
    `contextUsage=${u.contextUsage ?? '—'}`,
    `contextWindow=${u.contextWindow ?? '—'}`,
    `cumIn=${u.inputTokens}`,
    `cumOut=${u.outputTokens}`,
  ]
  if (u.last) parts.push(`last(in=${u.last.inputTokens},out=${u.last.outputTokens})`)
  return parts.join(' ')
}

interface TurnResult {
  threadId: string
  sawCompactionStart: boolean
  sawCompactionComplete: boolean
  peakContextUsage: number
  lastContextUsage: number | undefined
  // contextUsage reading immediately BEFORE the contextCompaction item started
  // (the occupancy that tripped the auto-compact threshold).
  preCompactionUsage: number | undefined
  // Lowest contextUsage observed AFTER compaction started, i.e. the trough right
  // after history was summarized + dropped, BEFORE the model re-ingests context.
  troughAfterCompaction: number | undefined
}

async function main(): Promise<void> {
  const apiKey = reqEnv('SMOKE_CODEX_API_KEY')
  const baseUrl = reqEnv('SMOKE_CODEX_BASE_URL')
  const model = reqEnv('SMOKE_CODEX_MODEL')
  const autoCompactLimit = numEnv('SMOKE_AUTO_COMPACT_LIMIT', 12_000)
  const contextWindow = numEnv('SMOKE_CONTEXT_WINDOW', 40_000)
  const blobChars = numEnv('SMOKE_BLOB_CHARS', 80_000)
  const maxTriggerTurns = numEnv('SMOKE_MAX_TRIGGER_TURNS', 3)

  // Codex clamps auto_compact_token_limit to 90% of the context window
  // (openai/codex protocol/src/openai_models.rs). Warn if the config would be
  // silently clamped so the operator isn't confused when it fires "too early".
  const clampCeil = Math.floor((contextWindow * 9) / 10)
  if (autoCompactLimit > clampCeil) {
    log(
      `⚠️ SMOKE_AUTO_COMPACT_LIMIT=${autoCompactLimit} exceeds 90% of window (${clampCeil}); ` +
        `codex will clamp the effective trigger to ${clampCeil}.`,
    )
  }

  const cwd = await makeTempCwd()
  log(`workspace cwd (no AGENTS.md, keeps baseline small): ${cwd}`)

  // Custom provider table. envKey=OPENAI_API_KEY so buildCodexSpawnEnv forwards
  // the key (it only sets OPENAI_API_KEY). extraTopLevelConfig is emitted LAST
  // in buildCodexLaunchArgs → appendProviderArgs, so these two `-c` overrides
  // WIN over the hardcoded production 272000/220000 (codex `-c` is last-wins;
  // verified against openai/codex config loader layering).
  const provider: CodexProviderConfig = {
    id: 'smoke',
    name: 'smoke gateway',
    baseUrl,
    envKey: 'OPENAI_API_KEY',
    model,
    wireApi: 'responses',
    extraTopLevelConfig: {
      model_context_window: contextWindow,
      model_auto_compact_token_limit: autoCompactLimit,
    },
  }

  log(
    `spawning codex with model_auto_compact_token_limit=${autoCompactLimit}, ` +
      `model_context_window=${contextWindow}, model="${model}" via ${baseUrl}`,
  )

  // NOTE: leave sessionConfig.writableRoots EMPTY. The bundled `codex
  // app-server` (0.142.2) rejects the `--add-dir` flag that buildCodexLaunchArgs
  // emits per writable root — the app keeps launch roots empty and scopes the
  // workspace PER-THREAD via `input.cwd` (threadStartParams.cwd) instead. We run
  // sandbox_mode=danger-full-access anyway, so no root allow-listing is needed.
  const backend = new CodexLocalBackend({
    resourceRoot,
    provider,
    getApiKey: () => apiKey,
    connectTimeoutMs: 15_000,
  })

  await backend.start()
  log('✅ app-server spawned + initialize OK')

  try {
    // ── Turn 1: dump a large blob so the running context blows past the limit ──
    const blob = buildBlob(blobChars)
    log(`\n──── TURN 1: seeding ~${blobChars} chars of context (limit=${autoCompactLimit}) ────`)
    const t1 = await runTurn(backend, undefined, model, cwd, [
      `Here is some reference material. Acknowledge with a single word "SEEDED" and nothing else.\n\n${blob}`,
    ])
    const threadId = t1.threadId
    log(`TURN 1 done. peak contextUsage this turn = ${t1.peakContextUsage}`)

    let compacted = t1.sawCompactionComplete
    let peakBefore = t1.peakContextUsage
    // The "回落" is measured ACROSS the compaction boundary: the occupancy that
    // tripped the threshold vs. the trough right after history was dropped. Both
    // come from the SAME turn that ran the compaction (a later settled turn just
    // climbs back up as context is re-ingested, hiding the drop).
    let preCompaction: number | undefined = t1.preCompactionUsage
    let trough: number | undefined = t1.troughAfterCompaction

    // ── Trigger turns: trivial prompts. Auto-compaction fires at the start of a
    //    turn once prior context > limit, streaming the contextCompaction item
    //    on THAT turn's live stream. ─────────────────────────────────────────
    for (let i = 1; i <= maxTriggerTurns && !compacted; i++) {
      log(`\n──── TURN ${1 + i}: trivial prompt to trigger auto-compaction ────`)
      const t = await runTurn(backend, threadId, model, cwd, [`Reply with the single word "PING${i}".`])
      peakBefore = Math.max(peakBefore, t.peakContextUsage)
      if (t.sawCompactionComplete) {
        compacted = true
        // Fall back to the running peak if no explicit pre-start reading landed.
        preCompaction = t.preCompactionUsage ?? peakBefore
        trough = t.troughAfterCompaction
      }
    }

    // ── Verdict ──────────────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(66))
    if (compacted) {
      const before = preCompaction ?? peakBefore
      const dropTxt =
        before > 0 && trough != null
          ? `${before} → ${trough} (Δ -${Math.max(0, before - trough)} tokens)`
          : `before=${before}, trough=${trough ?? '—'}`
      log(`✅ REAL COMPACTION CONFIRMED — contextCompaction item started→completed observed.`)
      log(`   contextUsage 回落 (across compaction boundary): ${dropTxt}`)
      console.log('═'.repeat(66))
      console.log('\n[smoke] PASS — auto-compaction fired and context dropped.')
    } else {
      log(`❌ No contextCompaction observed after ${maxTriggerTurns} trigger turns.`)
      log(`   peak contextUsage reached ${peakBefore} vs limit ${autoCompactLimit}.`)
      log(`   → lower SMOKE_AUTO_COMPACT_LIMIT or raise SMOKE_BLOB_CHARS and re-run.`)
      console.log('═'.repeat(66))
      throw new Error('compaction not triggered')
    }
  } finally {
    await backend.stop()
    log('✅ stopped cleanly')
  }
}

/**
 * Drive one turn, printing compaction + token-usage events as they stream.
 * Returns the observed threadId plus compaction/usage summary for this turn.
 */
async function runTurn(
  backend: CodexLocalBackend,
  threadId: string | undefined,
  model: string,
  cwd: string,
  texts: string[],
): Promise<TurnResult> {
  const input: AgentInput = {
    content: texts.join('\n'),
    attachments: [],
    model,
    cwd,
    items: texts.map((text) => ({ type: 'text' as const, text })),
  }

  let resolvedThreadId = threadId ?? ''
  let sawStart = false
  let sawComplete = false
  let peak = 0
  let lastContextUsage: number | undefined
  let preCompactionUsage: number | undefined
  let troughAfterCompaction: number | undefined

  for await (const event of backend.send(threadId, input)) {
    const e = event as AgentStreamEvent
    switch (e.type) {
      case 'thread_created':
        resolvedThreadId = e.threadId ?? resolvedThreadId
        break
      case 'item_started':
        if (e.itemType === 'activity' && (e.payload as { kind?: string }).kind === 'contextCompaction') {
          sawStart = true
          // Snapshot the occupancy that tripped the threshold (last reading so far).
          if (preCompactionUsage == null) preCompactionUsage = lastContextUsage
          log('   🗜️  contextCompaction item/started (compaction BEGAN)')
        }
        break
      case 'item_completed':
        if (e.itemType === 'activity' && (e.final as { kind?: string }).kind === 'contextCompaction') {
          sawComplete = true
          log('   ✅ contextCompaction item/completed (history summarized + dropped)')
        }
        break
      case 'token_usage_updated': {
        const cu = e.usage.contextUsage
        if (typeof cu === 'number') {
          peak = Math.max(peak, cu)
          lastContextUsage = cu
          // After compaction began, the first readings are the post-summary trough
          // (before the model re-ingests context and climbs back up).
          if (sawStart) {
            troughAfterCompaction =
              troughAfterCompaction == null ? cu : Math.min(troughAfterCompaction, cu)
          }
        }
        log(`   📊 tokenUsage: ${fmtUsage(e.usage)}`)
        break
      }
      case 'error':
        log(`   ⛔ error: ${(e as { error?: string }).error ?? 'unknown'}`)
        break
      default:
        break
    }
  }

  return {
    threadId: resolvedThreadId,
    sawCompactionStart: sawStart,
    sawCompactionComplete: sawComplete,
    peakContextUsage: peak,
    lastContextUsage,
    preCompactionUsage,
    troughAfterCompaction,
  }
}

/** Build a large but cheap-to-tokenize filler blob (numbered lines). */
function buildBlob(chars: number): string {
  const line = 'The quick brown fox jumps over the lazy dog while counting tokens. '
  let out = ''
  let n = 0
  while (out.length < chars) {
    out += `${String(n).padStart(6, '0')}: ${line}\n`
    n++
  }
  return out
}

async function makeTempCwd(): Promise<string> {
  const { promises: fs } = await import('node:fs')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-compaction-smoke-'))
  return dir
}

async function withTimeout(): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`smoke timed out after ${SMOKE_TIMEOUT_MS}ms`)), SMOKE_TIMEOUT_MS)
    timer.unref?.()
  })
  try {
    await Promise.race([main(), guard])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

withTimeout()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n[smoke] FAIL:', error instanceof Error ? error.message : error)
    process.exit(1)
  })

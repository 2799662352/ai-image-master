import { describe, expect, it } from 'vitest'
import { hasCodexBinary, hasEvalCreds, resolveCodexBinaryPath, resolveEvalConfig } from '../harness/env'
import { runResumeCore, runResumeRecall } from '../harness/resumeClient'

/**
 * Crash-continuity eval for `thread/resume` — the fix behind
 * "codex 闪退后，同一对话无法连续对话". A conversation thread minted by one
 * `codex app-server` generation must survive that process dying and be
 * re-openable by a FRESH generation so the user keeps chatting in-context.
 *
 * Two tiers (each self-skips when its prerequisites are absent):
 *
 *   CORE   (offline; needs only the bundled binary)
 *     Proves `thread/resume` is a WIRED RPC on the shipped binary that fails
 *     GRACEFULLY for a thread that was never persisted (zero-turn threads aren't
 *     written to disk) — i.e. the safe-fallback the fix relies on. A "method not
 *     found" / hang would fail; a graceful domain error or a resolve both pass.
 *
 *   MEMORY (live; needs eval creds — auto-uses the app's saved provider key)
 *     The true end-to-end proof: turn 1 plants a secret token, the app-server is
 *     killed, a fresh app-server resumes the SAME thread from disk, and turn 2
 *     must recall the token. PASS iff the reply echoes it → context preserved.
 */

describe.skipIf(!hasCodexBinary())('thread/resume wiring (offline)', () => {
  it(
    'is a wired RPC that resolves or fails gracefully after an app-server restart',
    async () => {
      const result = await runResumeCore({
        binaryPath: resolveCodexBinaryPath(),
        cwd: process.cwd(),
        log: (m) => console.log(`[resume-core] ${m}`),
      })
      // Either outcome proves the method exists and didn't hang; runResumeCore
      // throws only when the binary lacks thread/resume entirely.
      expect(['resolved', 'graceful-error']).toContain(result.resumeOutcome)
    },
    120_000,
  )
})

describe.skipIf(!hasEvalCreds())('thread/resume context recall (live)', () => {
  it(
    'recalls a secret planted before a simulated crash, after resuming on a fresh app-server',
    async () => {
      const config = resolveEvalConfig()
      const result = await runResumeRecall({
        binaryPath: config.binaryPath,
        provider: config.provider,
        apiKey: config.apiKey,
        model: config.model,
        cwd: process.cwd(),
        log: (m) => console.log(`[resume-memory] ${m}`),
      })
      expect(
        result.recalled,
        `model did not echo ${result.secret} after restart+resume — context lost.\n` +
          `recall answer: ${JSON.stringify(result.recallAnswer.slice(0, 200))}`,
      ).toBe(true)
    },
    300_000,
  )
})

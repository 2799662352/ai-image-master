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
 *     Starts an unauthenticated turn to persist session metadata, kills the
 *     first app-server, then requires a fresh generation to resume the exact
 *     same thread id from disk.
 *
 *   MEMORY (live; needs eval creds — auto-uses the app's saved provider key)
 *     The true end-to-end proof: turn 1 plants a secret token, the app-server is
 *     killed, a fresh app-server resumes the SAME thread from disk, and turn 2
 *     must recall the token. PASS iff the reply echoes it → context preserved.
 */

describe.skipIf(!hasCodexBinary())('thread/resume wiring (offline)', () => {
  it(
    'restores the same persisted thread after an app-server restart',
    async () => {
      const result = await runResumeCore({
        binaryPath: resolveCodexBinaryPath(),
        cwd: process.cwd(),
        log: (m) => console.log(`[resume-core] ${m}`),
      })
      expect(result.rolloutPersisted).toBe(true)
      expect(result.resumeOutcome).toBe('resolved')
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

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { migrateLegacyCodexSessions } from '../codexSessionMigration'

describe('migrateLegacyCodexSessions', () => {
  let tmp: string
  let legacy: string
  let target: string

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'codex-sess-mig-'))
    legacy = path.join(tmp, 'codex-runtime', 'sessions')
    target = path.join(tmp, 'home', '.codex', 'sessions')
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  async function seedRollout(root: string, rel: string, contents: string): Promise<void> {
    const abs = path.join(root, rel)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, contents, 'utf8')
  }

  it('copies orphaned rollouts into the pinned home preserving the YYYY/MM/DD structure', async () => {
    const rel = path.join('2026', '06', '29', 'rollout-2026-06-29T10-00-00-abc.jsonl')
    await seedRollout(legacy, rel, '{"line":1}\n')

    const result = await migrateLegacyCodexSessions({
      legacySessionsDir: legacy,
      targetSessionsDir: target,
    })

    expect(result).toEqual({ moved: 1, skipped: 0 })
    expect(await readFile(path.join(target, rel), 'utf8')).toBe('{"line":1}\n')
  })

  it('never clobbers a rollout that already exists in the pinned home', async () => {
    const rel = path.join('2026', '06', '29', 'rollout-2026-06-29T10-00-00-abc.jsonl')
    await seedRollout(legacy, rel, 'LEGACY\n')
    await seedRollout(target, rel, 'CANONICAL\n')

    const result = await migrateLegacyCodexSessions({
      legacySessionsDir: legacy,
      targetSessionsDir: target,
    })

    expect(result).toEqual({ moved: 0, skipped: 1 })
    // The pre-existing canonical copy must win — we only ADD orphaned rollouts.
    expect(await readFile(path.join(target, rel), 'utf8')).toBe('CANONICAL\n')
  })

  it('ignores non-rollout files and is a no-op when the legacy dir is missing', async () => {
    // Stray file that is not a codex rollout — must not be copied.
    await seedRollout(legacy, path.join('2026', '06', 'notes.txt'), 'junk')

    const withJunk = await migrateLegacyCodexSessions({
      legacySessionsDir: legacy,
      targetSessionsDir: target,
    })
    expect(withJunk).toEqual({ moved: 0, skipped: 0 })

    const missing = await migrateLegacyCodexSessions({
      legacySessionsDir: path.join(tmp, 'does-not-exist'),
      targetSessionsDir: target,
    })
    expect(missing).toEqual({ moved: 0, skipped: 0 })
  })

  it('is a no-op when legacy and target resolve to the same directory', async () => {
    const rel = path.join('2026', '06', '29', 'rollout-x.jsonl')
    await seedRollout(legacy, rel, 'X\n')

    const result = await migrateLegacyCodexSessions({
      legacySessionsDir: legacy,
      targetSessionsDir: path.join(legacy, '..', 'sessions'),
    })

    expect(result).toEqual({ moved: 0, skipped: 0 })
  })
})

/**
 * Edit-and-resend server-side context branch (codex 0.145 `thread/fork` +
 * `lastTurnId`, upstream openai/codex PR #33201/#33207/#33211 semantics):
 *
 *   - Editing message N forks the codex thread THROUGH the previous user
 *     turn (inclusive), so the fork's server context matches the truncated
 *     UI exactly; the old thread stays on disk untouched.
 *   - Editing the FIRST message drops the codex mapping entirely — the next
 *     send starts a brand-new codex thread (upstream: "start a new session").
 *   - Any failure (no turn mapping, fork RPC error, unsupported backend)
 *     degrades to the legacy same-thread resend WITHOUT throwing, plus a
 *     warning notice so the user knows the model may still remember dropped
 *     turns.
 *   - In every path where the edit point is located, DB rows at/after it are
 *     deleted so a thread reload can never resurrect the truncated tail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentManager } from '../AgentManager'
import type { AgentInput, IAgentBackend } from '../types'
import type { AgentStreamEvent } from '../../../types/agent'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-branch-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

type BranchRow = { id: string; role: string; items: unknown[] }

function userRow(id: string, turnId?: string): BranchRow {
  return {
    id,
    role: 'user',
    items: [
      {
        type: 'text',
        id: `${id}-t`,
        startedAt: 1,
        content: `text of ${id}`,
        ...(turnId
          ? { codexReconcile: { codexItemId: `${id}-echo`, clientId: id, turnId, localImages: [], textElements: [] } }
          : {}),
      },
    ],
  }
}

function assistantRow(id: string): BranchRow {
  return { id, role: 'assistant', items: [{ type: 'text', id: `${id}-t`, startedAt: 1, content: 'reply' }] }
}

function makeHarness(opts: {
  rows: BranchRow[]
  codexThreadId?: string | null
  forkImpl?: () => Promise<{ id: string; title: string; updatedAtIso: string }>
  withForkApi?: boolean
}) {
  const deleteCalls: Array<{ threadId: string; ids: string[] }> = []
  const sinkEvents: AgentStreamEvent[] = []
  const fork = vi.fn(
    opts.forkImpl
      ?? (async () => ({ id: 'codex-forked', title: 'fork', updatedAtIso: '' })),
  )
  const unsubscribe = vi.fn(async () => undefined)
  const setCodexThreadId = vi.fn(async () => undefined)
  const backend: IAgentBackend = {
    async start() { },
    async stop() { },
    isHealthy() { return true },
    async cancel() { },
    async *send(_threadId: string | undefined, _input: AgentInput): AsyncIterable<AgentStreamEvent> { },
    ...(opts.withForkApi === false ? {} : { forkThread: fork as never }),
    unsubscribeThread: unsubscribe,
  }
  const store = {
    listMessagesForBranch: vi.fn(async () => opts.rows),
    deleteMessages: vi.fn(async (threadId: string, ids: string[]) => {
      deleteCalls.push({ threadId, ids })
    }),
    getCodexThreadId: vi.fn(async () => opts.codexThreadId ?? null),
    setCodexThreadId,
  }
  const manager = new AgentManager({
    userDataDir: tmpDir,
    backend,
    store: store as never,
    attachments: { ingest: async () => [] } as never,
    eventSink: (event) => sinkEvents.push(event),
  })
  return { manager, store, fork, unsubscribe, setCodexThreadId, deleteCalls, sinkEvents }
}

function noticeKinds(events: AgentStreamEvent[]): string[] {
  return events
    .filter((e): e is Extract<AgentStreamEvent, { type: 'notice' }> => e.type === 'notice')
    .map((e) => e.notice.kind)
}

describe('AgentManager.branchThreadBeforeMessage', () => {
  it('forks through the previous user turn, re-points the mapping, and truncates DB rows', async () => {
    const h = makeHarness({
      rows: [
        userRow('m1', 'turn-1'),
        assistantRow('m2'),
        userRow('m3', 'turn-2'),
        assistantRow('m4'),
      ],
      codexThreadId: 'codex-src',
    })

    const result = await h.manager.branchThreadBeforeMessage('db-t1', 'm3')

    expect(result).toEqual({ branched: true, mode: 'fork' })
    expect(h.fork).toHaveBeenCalledTimes(1)
    // fork(codexThreadId, overrides, lastTurnId) — branch point is the turn
    // of the LAST KEPT user message (m1), not the edited one's own turn.
    expect(h.fork.mock.calls[0][0]).toBe('codex-src')
    expect(h.fork.mock.calls[0][2]).toBe('turn-1')
    // Old source thread released; conversation re-pointed at the fork.
    expect(h.unsubscribe).toHaveBeenCalledWith('codex-src')
    expect(h.setCodexThreadId).toHaveBeenCalledWith('db-t1', 'codex-forked')
    // DB follows UI semantics: edited row + everything after is gone.
    expect(h.deleteCalls).toEqual([{ threadId: 'db-t1', ids: ['m3', 'm4'] }])
    expect(noticeKinds(h.sinkEvents)).toEqual([])
  })

  it('editing the FIRST user message drops the codex mapping (fresh-thread semantics) without forking', async () => {
    const h = makeHarness({
      rows: [userRow('m1', 'turn-1'), assistantRow('m2')],
      codexThreadId: 'codex-src',
    })

    const result = await h.manager.branchThreadBeforeMessage('db-t1', 'm1')

    expect(result).toEqual({ branched: true, mode: 'fresh' })
    expect(h.fork).not.toHaveBeenCalled()
    expect(h.deleteCalls).toEqual([{ threadId: 'db-t1', ids: ['m1', 'm2'] }])
  })

  it('degrades (no throw + warning notice) when the previous user row has no turn mapping', async () => {
    const h = makeHarness({
      rows: [userRow('m1' /* no turnId — legacy row */), assistantRow('m2'), userRow('m3', 'turn-9')],
      codexThreadId: 'codex-src',
    })

    const result = await h.manager.branchThreadBeforeMessage('db-t1', 'm3')

    expect(result.branched).toBe(false)
    expect(h.fork).not.toHaveBeenCalled()
    // DB truncation still follows the UI even in degrade.
    expect(h.deleteCalls).toEqual([{ threadId: 'db-t1', ids: ['m3'] }])
    expect(noticeKinds(h.sinkEvents)).toContain('editBranchDegraded')
  })

  it('degrades with a warning notice when the fork RPC fails, still truncating DB rows', async () => {
    const h = makeHarness({
      rows: [userRow('m1', 'turn-1'), assistantRow('m2'), userRow('m3', 'turn-2')],
      codexThreadId: 'codex-src',
      forkImpl: async () => {
        throw new Error('fork exploded')
      },
    })

    const result = await h.manager.branchThreadBeforeMessage('db-t1', 'm3')

    expect(result.branched).toBe(false)
    expect(h.setCodexThreadId).not.toHaveBeenCalled()
    expect(h.deleteCalls).toEqual([{ threadId: 'db-t1', ids: ['m3'] }])
    expect(noticeKinds(h.sinkEvents)).toContain('editBranchDegraded')
  })

  it('treats a codex-mapping-less thread as fresh (nothing server-side to branch)', async () => {
    const h = makeHarness({
      rows: [userRow('m1', 'turn-1'), assistantRow('m2'), userRow('m3', 'turn-2')],
      codexThreadId: null,
    })

    const result = await h.manager.branchThreadBeforeMessage('db-t1', 'm3')

    expect(result).toEqual({ branched: true, mode: 'fresh' })
    expect(h.fork).not.toHaveBeenCalled()
    expect(h.deleteCalls).toEqual([{ threadId: 'db-t1', ids: ['m3'] }])
  })

  it('degrades without touching the DB when the message row cannot be located', async () => {
    const h = makeHarness({
      rows: [userRow('m1', 'turn-1')],
      codexThreadId: 'codex-src',
    })

    const result = await h.manager.branchThreadBeforeMessage('db-t1', 'renderer-local-id')

    expect(result.branched).toBe(false)
    expect(h.fork).not.toHaveBeenCalled()
    expect(h.deleteCalls).toEqual([])
  })

  it('degrades when the backend has no forkThread API', async () => {
    const h = makeHarness({
      rows: [userRow('m1', 'turn-1'), userRow('m3', 'turn-2')],
      codexThreadId: 'codex-src',
      withForkApi: false,
    })

    const result = await h.manager.branchThreadBeforeMessage('db-t1', 'm3')

    expect(result.branched).toBe(false)
    expect(h.deleteCalls).toEqual([{ threadId: 'db-t1', ids: ['m3'] }])
    expect(noticeKinds(h.sinkEvents)).toContain('editBranchDegraded')
  })
})

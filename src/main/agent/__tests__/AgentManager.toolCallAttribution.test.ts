/**
 * Which conversation owns an MCP tool call — `AgentManager.resolveToolCallThread`.
 *
 * Background (2026-11, a user's tool-call log): 718 of 1,512 image calls
 * reached the renderer with no owner, and the renderer drew them into
 * whichever chat was open. Plain parallel chats were fine (five at once, zero
 * strays); the unowned calls came from codex threads the manager had no entry
 * for. This file pins every way a running codex thread can be "ours" without
 * being a conversation's live binding — and that anything else resolves to
 * NOTHING rather than to a guess.
 */

import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentManager } from '../AgentManager'
import type { AgentStreamEvent } from '../types'
import type { CodexToolCaller, ToolThreadResolution } from '../../mcp/toolCaller'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-tool-attr-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

type Internals = {
  rememberCodexThread(db: string, codex: string): void
  forgetCodexThread(db: string): void
  noteDelegatedAgents(event: AgentStreamEvent): void
}

interface FakeStore {
  findThreadIdByCodexThreadId: ReturnType<typeof vi.fn>
  setCodexThreadId: ReturnType<typeof vi.fn>
  getCodexThreadId: ReturnType<typeof vi.fn>
  deleteThread: ReturnType<typeof vi.fn>
}

/** A store whose reverse lookup answers from `rows` (codex id → db thread id). */
function fakeStore(rows: Record<string, string> = {}): FakeStore {
  return {
    findThreadIdByCodexThreadId: vi.fn(async (codexId: string) => rows[codexId] ?? null),
    setCodexThreadId: vi.fn().mockResolvedValue(undefined),
    getCodexThreadId: vi.fn().mockResolvedValue(null),
    deleteThread: vi.fn().mockResolvedValue(undefined),
  }
}

function makeManager(store?: FakeStore): { manager: AgentManager; internals: Internals } {
  const backend = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    cancel: vi.fn(),
    // Cold backend: `deleteThread` then skips the codex-side RPC.
    isHealthy: vi.fn().mockReturnValue(false),
    onMcpNotification: vi.fn(),
  }
  const manager = new AgentManager({
    userDataDir: tmpDir,
    backend: backend as never,
    ...(store ? { store: store as never } : {}),
  })
  return { manager, internals: manager as unknown as Internals }
}

const caller = (threadId: string | undefined, ...ancestorThreadIds: string[]): CodexToolCaller => ({
  ...(threadId ? { threadId } : {}),
  ancestorThreadIds,
})

/** Asserts the answer came back synchronously (no database round trip). */
function sync(
  value: ToolThreadResolution | undefined | Promise<ToolThreadResolution | undefined>,
): ToolThreadResolution | undefined {
  expect(value instanceof Promise, 'expected a synchronous answer').toBe(false)
  return value as ToolThreadResolution | undefined
}

function spawnCompleted(parentCodexThread: string, childThreadId: string): AgentStreamEvent {
  return {
    type: 'item_completed',
    threadId: parentCodexThread,
    itemId: 'call_spawn',
    itemType: 'activity',
    final: {
      kind: 'collabAgentToolCall',
      status: 'success',
      delegation: { tool: 'spawnAgent', prompt: 'p', model: 'm', agents: [{ threadId: childThreadId }] },
    },
  } as AgentStreamEvent
}

describe('resolveToolCallThread — in memory', () => {
  it('the conversation\'s current codex thread: live, synchronous', () => {
    const { manager, internals } = makeManager(fakeStore())
    internals.rememberCodexThread('db-A', 'codex-A')

    expect(sync(manager.resolveToolCallThread(caller('codex-A')))).toEqual({ threadId: 'db-A', via: 'live' })
  })

  it('a sub-agent the conversation was seen spawning', () => {
    const { manager, internals } = makeManager(fakeStore())
    internals.rememberCodexThread('db-A', 'codex-A')
    internals.noteDelegatedAgents(spawnCompleted('codex-A', 'child-1'))

    expect(sync(manager.resolveToolCallThread(caller('child-1')))).toEqual({ threadId: 'db-A', via: 'subagent' })
  })

  it('two conversations stay apart', () => {
    const { manager, internals } = makeManager(fakeStore())
    internals.rememberCodexThread('db-A', 'codex-A')
    internals.rememberCodexThread('db-B', 'codex-B')

    expect(sync(manager.resolveToolCallThread(caller('codex-A')))?.threadId).toBe('db-A')
    expect(sync(manager.resolveToolCallThread(caller('codex-B')))?.threadId).toBe('db-B')
  })

  it('answers undefined, synchronously, when there is no store to ask', () => {
    const { manager } = makeManager()

    expect(sync(manager.resolveToolCallThread(caller('codex-stranger', 'codex-other')))).toBeUndefined()
  })
})

/**
 * Measured on codex 0.169.0: forking a thread and unsubscribing from the source
 * does NOT stop a turn running on the source — it keeps calling tools under its
 * OLD id. The manager re-points the conversation at the fork on a model rebind
 * and on edit-and-resend, so before this the old id matched no conversation.
 */
describe('resolveToolCallThread — a thread the conversation was re-pointed away from', () => {
  it('still belongs to that conversation after a fork replaces it', () => {
    const { manager, internals } = makeManager(fakeStore())
    internals.rememberCodexThread('db-A', 'codex-old')
    internals.rememberCodexThread('db-A', 'codex-fork')

    expect(sync(manager.resolveToolCallThread(caller('codex-old')))).toEqual({ threadId: 'db-A', via: 'retired' })
    expect(sync(manager.resolveToolCallThread(caller('codex-fork')))).toEqual({ threadId: 'db-A', via: 'live' })
  })

  it('still belongs to that conversation after its thread is forgotten (reset / poisoned)', () => {
    const { manager, internals } = makeManager(fakeStore())
    internals.rememberCodexThread('db-A', 'codex-old')
    internals.forgetCodexThread('db-A')

    expect(sync(manager.resolveToolCallThread(caller('codex-old')))).toEqual({ threadId: 'db-A', via: 'retired' })
  })

  it('keeps the whole chain when a conversation is re-pointed several times', () => {
    const { manager, internals } = makeManager(fakeStore())
    for (const id of ['c1', 'c2', 'c3', 'c4']) internals.rememberCodexThread('db-A', id)

    for (const id of ['c1', 'c2', 'c3']) {
      expect(sync(manager.resolveToolCallThread(caller(id))), id).toEqual({ threadId: 'db-A', via: 'retired' })
    }
  })

  it('re-registering the same thread does not retire it', () => {
    const { manager, internals } = makeManager(fakeStore())
    internals.rememberCodexThread('db-A', 'codex-A')
    internals.rememberCodexThread('db-A', 'codex-A')

    expect(sync(manager.resolveToolCallThread(caller('codex-A')))).toEqual({ threadId: 'db-A', via: 'live' })
  })

  it('a retired thread that goes live again is live, for whoever holds it now', () => {
    const { manager, internals } = makeManager(fakeStore())
    internals.rememberCodexThread('db-A', 'codex-x')
    internals.rememberCodexThread('db-A', 'codex-y') // codex-x retired from db-A
    internals.rememberCodexThread('db-B', 'codex-x') // …and now db-B's live thread

    expect(sync(manager.resolveToolCallThread(caller('codex-x')))).toEqual({ threadId: 'db-B', via: 'live' })
    // …and once db-B moves on, codex-x is db-B's past, not db-A's.
    internals.rememberCodexThread('db-B', 'codex-z')
    expect(sync(manager.resolveToolCallThread(caller('codex-x')))).toEqual({ threadId: 'db-B', via: 'retired' })
  })

  // Goal and settings notifications use `resolveDbThreadId`. A superseded
  // thread's goal state must not be shown as the conversation's current one.
  it('does not leak into resolveDbThreadId', () => {
    const { manager, internals } = makeManager(fakeStore())
    internals.rememberCodexThread('db-A', 'codex-old')
    internals.rememberCodexThread('db-A', 'codex-fork')

    expect(manager.resolveDbThreadId('codex-old')).toBeUndefined()
    expect(manager.resolveDbThreadId('codex-fork')).toBe('db-A')
  })

  it('is bounded: the oldest entries fall out, the newest stay', () => {
    const { manager, internals } = makeManager(fakeStore())
    for (let i = 0; i < 2000; i++) internals.rememberCodexThread('db-A', `c${i}`)

    // c1998 was retired last; c0 two thousand re-points ago.
    expect(sync(manager.resolveToolCallThread(caller('c1998')))).toEqual({ threadId: 'db-A', via: 'retired' })
    const oldest = manager.resolveToolCallThread(caller('c0'))
    // Not in memory any more → falls through to the store (which knows nothing).
    expect(oldest instanceof Promise).toBe(true)
  })
})

/**
 * A sub-agent's thread is minted by codex, not by us. We learn it from the
 * parent's delegation item — but only if the parent's events passed through
 * us. `_meta` always names the parent, so that is the dependable route.
 */
describe('resolveToolCallThread — through an ancestor', () => {
  it('an unknown child resolves to its parent\'s conversation', () => {
    const { manager, internals } = makeManager(fakeStore())
    internals.rememberCodexThread('db-A', 'codex-parent')

    expect(sync(manager.resolveToolCallThread(caller('child-x', 'codex-parent')))).toEqual({
      threadId: 'db-A',
      via: 'ancestor',
    })
  })

  it('remembers the child, so later it resolves on its own and is known to resolveDbThreadId', () => {
    const { manager, internals } = makeManager(fakeStore())
    internals.rememberCodexThread('db-A', 'codex-parent')
    manager.resolveToolCallThread(caller('child-x', 'codex-parent'))

    expect(sync(manager.resolveToolCallThread(caller('child-x')))).toEqual({ threadId: 'db-A', via: 'subagent' })
    expect(manager.resolveDbThreadId('child-x')).toBe('db-A')
  })

  it('tries the nearest ancestor first, then further up', () => {
    const { manager, internals } = makeManager(fakeStore())
    internals.rememberCodexThread('db-root', 'codex-root')

    // grandchild → (unknown child) → root
    expect(sync(manager.resolveToolCallThread(caller('grandchild', 'child-unknown', 'codex-root')))).toEqual({
      threadId: 'db-root',
      via: 'ancestor',
    })
  })

  it('a child of a RETIRED parent still resolves to the parent\'s conversation', () => {
    const { manager, internals } = makeManager(fakeStore())
    internals.rememberCodexThread('db-A', 'codex-old')
    internals.rememberCodexThread('db-A', 'codex-fork')

    expect(sync(manager.resolveToolCallThread(caller('child-of-old', 'codex-old')))).toEqual({
      threadId: 'db-A',
      via: 'ancestor',
    })
  })

  it('the caller\'s own thread wins over its ancestors', () => {
    const { manager, internals } = makeManager(fakeStore())
    internals.rememberCodexThread('db-A', 'codex-A')
    internals.rememberCodexThread('db-B', 'codex-B')

    expect(sync(manager.resolveToolCallThread(caller('codex-A', 'codex-B')))).toEqual({ threadId: 'db-A', via: 'live' })
  })

  it('a caller that names only a session resolves through it', () => {
    const { manager, internals } = makeManager(fakeStore())
    internals.rememberCodexThread('db-A', 'codex-A')

    expect(sync(manager.resolveToolCallThread(caller(undefined, 'codex-A')))).toEqual({
      threadId: 'db-A',
      via: 'ancestor',
    })
  })
})

/**
 * The live map is only filled when a conversation is sent to, or opened, in
 * this process. A codex thread that is persisted on a conversation but not in
 * the map must still be attributed — from the database, read-only.
 */
describe('resolveToolCallThread — from the database', () => {
  it('finds the conversation that persisted the caller\'s codex thread', async () => {
    const store = fakeStore({ 'codex-cold': 'db-cold' })
    const { manager } = makeManager(store)

    await expect(manager.resolveToolCallThread(caller('codex-cold'))).resolves.toEqual({
      threadId: 'db-cold',
      via: 'persisted',
    })
  })

  it('asks the database once, then answers from memory', async () => {
    const store = fakeStore({ 'codex-cold': 'db-cold' })
    const { manager } = makeManager(store)
    await manager.resolveToolCallThread(caller('codex-cold'))

    expect(sync(manager.resolveToolCallThread(caller('codex-cold')))).toEqual({ threadId: 'db-cold', via: 'persisted' })
    expect(store.findThreadIdByCodexThreadId).toHaveBeenCalledTimes(1)
  })

  it('finds an ancestor in the database when the caller itself is unknown', async () => {
    const store = fakeStore({ 'codex-cold-parent': 'db-cold' })
    const { manager } = makeManager(store)

    await expect(manager.resolveToolCallThread(caller('child-x', 'codex-cold-parent'))).resolves.toEqual({
      threadId: 'db-cold',
      via: 'ancestor',
    })
    // Own thread first, then the ancestor.
    expect(store.findThreadIdByCodexThreadId.mock.calls.map((c) => c[0])).toEqual(['child-x', 'codex-cold-parent'])
    // …and the child is remembered.
    expect(sync(manager.resolveToolCallThread(caller('child-x')))).toEqual({ threadId: 'db-cold', via: 'subagent' })
  })

  it('does not go to the database when memory already has the answer', () => {
    const store = fakeStore({ 'codex-A': 'db-WRONG' })
    const { manager, internals } = makeManager(store)
    internals.rememberCodexThread('db-A', 'codex-A')

    expect(sync(manager.resolveToolCallThread(caller('codex-A')))?.threadId).toBe('db-A')
    expect(store.findThreadIdByCodexThreadId).not.toHaveBeenCalled()
  })

  it('a thread nobody owns resolves to nothing — never to a guess', async () => {
    const store = fakeStore({ 'codex-other': 'db-other' })
    const { manager, internals } = makeManager(store)
    internals.rememberCodexThread('db-A', 'codex-A')

    await expect(manager.resolveToolCallThread(caller('codex-stranger', 'stranger-parent'))).resolves.toBeUndefined()
  })

  // An unowned caller can issue hundreds of tool calls in a row.
  it('does not re-query for a thread it was just told is unknown', async () => {
    const store = fakeStore()
    const { manager } = makeManager(store)

    for (let i = 0; i < 20; i++) await manager.resolveToolCallThread(caller('codex-stranger'))

    expect(store.findThreadIdByCodexThreadId).toHaveBeenCalledTimes(1)
  })

  it('…but asks again once that verdict is stale, so a thread registered later is found', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T00:00:00Z'))
    const rows: Record<string, string> = {}
    const store = fakeStore(rows)
    const { manager } = makeManager(store)

    await expect(manager.resolveToolCallThread(caller('codex-late'))).resolves.toBeUndefined()
    rows['codex-late'] = 'db-late'

    vi.setSystemTime(new Date('2026-11-20T00:00:20Z'))
    await expect(manager.resolveToolCallThread(caller('codex-late'))).resolves.toBeUndefined()
    expect(store.findThreadIdByCodexThreadId).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date('2026-11-20T00:01:00Z'))
    await expect(manager.resolveToolCallThread(caller('codex-late'))).resolves.toEqual({
      threadId: 'db-late',
      via: 'persisted',
    })
  })

  it('a thread that becomes live is found at once, whatever the "unknown" verdict said', async () => {
    const store = fakeStore()
    const { manager, internals } = makeManager(store)
    await manager.resolveToolCallThread(caller('codex-new'))

    internals.rememberCodexThread('db-new', 'codex-new')

    expect(sync(manager.resolveToolCallThread(caller('codex-new')))).toEqual({ threadId: 'db-new', via: 'live' })
  })

  // A database hiccup is not evidence that nobody owns the thread.
  it('a failing lookup resolves to nothing for THIS call and is retried on the next', async () => {
    const store = fakeStore()
    store.findThreadIdByCodexThreadId
      .mockRejectedValueOnce(new Error('P1017 Server has closed the connection'))
      .mockResolvedValueOnce('db-cold')
    const { manager } = makeManager(store)

    await expect(manager.resolveToolCallThread(caller('codex-cold'))).resolves.toBeUndefined()
    await expect(manager.resolveToolCallThread(caller('codex-cold'))).resolves.toEqual({
      threadId: 'db-cold',
      via: 'persisted',
    })
  })
})

describe('resolveToolCallThread — a deleted conversation owns nothing', () => {
  it('drops its live thread, its retired threads and its sub-agents', async () => {
    const store = fakeStore()
    const { manager, internals } = makeManager(store)
    internals.rememberCodexThread('db-A', 'codex-old')
    internals.rememberCodexThread('db-A', 'codex-live')
    internals.noteDelegatedAgents(spawnCompleted('codex-live', 'child-1'))
    internals.rememberCodexThread('db-B', 'codex-B')
    internals.rememberCodexThread('db-B', 'codex-B2')

    await manager.deleteThread('db-A')

    for (const id of ['codex-old', 'codex-live', 'child-1']) {
      await expect(Promise.resolve(manager.resolveToolCallThread(caller(id))), id).resolves.toBeUndefined()
    }
    // Another conversation's entries are untouched.
    expect(sync(manager.resolveToolCallThread(caller('codex-B')))).toEqual({ threadId: 'db-B', via: 'retired' })
    expect(sync(manager.resolveToolCallThread(caller('codex-B2')))).toEqual({ threadId: 'db-B', via: 'live' })
  })
})

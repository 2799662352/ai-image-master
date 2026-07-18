import { describe, expect, it, vi } from 'vitest'
import { ThreadStore } from '../ThreadStore'

describe('ThreadStore', () => {
  it('creates a thread and message through Prisma-compatible methods', async () => {
    const prisma = {
      agentThread: {
        create: vi.fn().mockResolvedValue({ id: 'thread_1', title: 'Test', model: 'gpt-5.4' }),
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
      agentMessage: { create: vi.fn().mockResolvedValue({ id: 'msg_1' }) },
      agentToolCall: { create: vi.fn() },
      agentArtifact: { create: vi.fn() },
    } as any
    const store = new ThreadStore(prisma)
    const thread = await store.createThread({ title: 'Test', model: 'gpt-5.4' })
    await store.addMessage({ threadId: thread.id, role: 'user', items: [{ type: 'text', text: 'hello' }] })
    expect(prisma.agentThread.create).toHaveBeenCalledWith({ data: { title: 'Test', model: 'gpt-5.4' } })
    expect(prisma.agentMessage.create).toHaveBeenCalledWith({
      data: { threadId: 'thread_1', role: 'user', items: [{ type: 'text', text: 'hello' }] },
    })
  })
})

describe('ThreadStore.attachCodexReconcile', () => {
  const RECONCILE = {
    codexItemId: 'item-1',
    clientId: 'msg_1',
    localImages: ['C:/uploads/a.png'],
    textElements: [{ byteRange: { start: 0, end: 4 }, placeholder: 'Foo' }],
  }

  function makePrisma(row: unknown) {
    return {
      agentMessage: {
        findUnique: vi.fn().mockResolvedValue(row),
        update: vi.fn().mockResolvedValue(undefined),
      },
    } as any
  }

  it('folds the reconcile block onto the FIRST item of the row', async () => {
    const prisma = makePrisma({
      items: [
        { type: 'text', id: 'i1', startedAt: 1, content: 'hello' },
        { type: 'attachment', id: 'i2', startedAt: 1, attachments: [] },
      ],
    })
    const store = new ThreadStore(prisma)
    await store.attachCodexReconcile('msg_1', RECONCILE)
    expect(prisma.agentMessage.update).toHaveBeenCalledWith({
      where: { id: 'msg_1' },
      data: {
        items: [
          { type: 'text', id: 'i1', startedAt: 1, content: 'hello', codexReconcile: RECONCILE },
          { type: 'attachment', id: 'i2', startedAt: 1, attachments: [] },
        ],
      },
    })
  })

  it('no-ops when the row is missing or has no items', async () => {
    for (const row of [null, { items: [] }, { items: 'not-an-array' }]) {
      const prisma = makePrisma(row)
      const store = new ThreadStore(prisma)
      await store.attachCodexReconcile('msg_1', RECONCILE)
      expect(prisma.agentMessage.update).not.toHaveBeenCalled()
    }
  })
})

describe('ThreadStore.setThreadModel', () => {
  it('updates the persisted thread model after confirmed selection', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    const prisma = {
      agentThread: { update },
    } as any
    const store = new ThreadStore(prisma)

    await store.setThreadModel('thread_1', 'grok-4.5')

    expect(update).toHaveBeenCalledWith({
      where: { id: 'thread_1' },
      data: { model: 'grok-4.5' },
    })
  })

  it('only touches the target thread, never other rows', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    const prisma = {
      agentThread: { update },
    } as any
    const store = new ThreadStore(prisma)

    await store.setThreadModel('thread_target', 'gpt-5.5')

    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({
      where: { id: 'thread_target' },
      data: { model: 'gpt-5.5' },
    })
  })

  it('reads only the target thread model for transaction rollback', async () => {
    const findUnique = vi.fn().mockResolvedValue({ model: 'thread-old-model' })
    const store = new ThreadStore({
      agentThread: { findUnique },
    } as any)

    await expect(store.getThreadModelSnapshot('thread_target')).resolves.toEqual({
      exists: true,
      model: 'thread-old-model',
    })
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'thread_target' },
      select: { model: true },
    })
  })

  it('distinguishes a missing thread from an existing thread with no model', async () => {
    const findUnique = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ model: null })
    const store = new ThreadStore({
      agentThread: { findUnique },
    } as any)

    await expect(store.getThreadModelSnapshot('missing')).resolves.toEqual({
      exists: false,
    })
    await expect(store.getThreadModelSnapshot('legacy')).resolves.toEqual({
      exists: true,
      model: null,
    })
  })
})

describe('ThreadStore per-thread routing (Plan B)', () => {
  it('persists the thread→channel routing binding scoped to the target thread', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    const store = new ThreadStore({ agentThread: { update } } as any)

    await store.setThreadRouting('thread_1', {
      model: 'grok-4.5',
      gatewayId: 'rightcode',
      modelProvider: 'rightcode-grok',
    })

    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({
      where: { id: 'thread_1' },
      data: {
        model: 'grok-4.5',
        gatewayId: 'rightcode',
        modelProvider: 'rightcode-grok',
      },
    })
  })

  it('reads the routing snapshot, preserving missing-vs-unbound identity', async () => {
    const findUnique = vi.fn()
      .mockResolvedValueOnce({
        model: 'grok-4.5',
        gatewayId: 'rightcode',
        modelProvider: 'rightcode-grok',
      })
      .mockResolvedValueOnce({ model: 'gpt-5.5', gatewayId: null, modelProvider: null })
      .mockResolvedValueOnce(null)
    const store = new ThreadStore({ agentThread: { findUnique } } as any)

    // Bound thread: full routing comes back verbatim.
    await expect(store.getThreadRoutingSnapshot('bound')).resolves.toEqual({
      exists: true,
      model: 'grok-4.5',
      gatewayId: 'rightcode',
      modelProvider: 'rightcode-grok',
    })
    // Legacy thread (pre-migration rows): nulls signal "derive from the
    // active gateway + thread model" fallback, NOT an error.
    await expect(store.getThreadRoutingSnapshot('legacy')).resolves.toEqual({
      exists: true,
      model: 'gpt-5.5',
      gatewayId: null,
      modelProvider: null,
    })
    // Deleted thread stays distinguishable from an unbound one.
    await expect(store.getThreadRoutingSnapshot('missing')).resolves.toEqual({
      exists: false,
    })
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'bound' },
      select: { model: true, gatewayId: true, modelProvider: true },
    })
  })
})

describe('ThreadStore.listThreads', () => {
  it('orders by lastMessageAt desc then updatedAt desc, and surfaces lastMessageAt + manualTitle', async () => {
    const fakeRows = [
      {
        id: 't1',
        title: 'First',
        createdAt: new Date('2026-05-01T00:00:00Z'),
        updatedAt: new Date('2026-05-07T10:00:00Z'),
        lastMessageAt: new Date('2026-05-07T10:00:00Z'),
        manualTitle: false,
      },
    ]
    const findMany = vi.fn().mockResolvedValue(fakeRows)
    const prisma = {
      agentThread: { findMany },
      agentMessage: { create: vi.fn() },
      agentToolCall: { create: vi.fn() },
      agentArtifact: { create: vi.fn() },
    } as any
    const store = new ThreadStore(prisma)
    const result = await store.listThreads()
    expect(findMany).toHaveBeenCalledWith({
      orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
    })
    expect(result[0]).toMatchObject({
      id: 't1',
      title: 'First',
      lastMessageAt: fakeRows[0].lastMessageAt,
      manualTitle: false,
    })
  })
})

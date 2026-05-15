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

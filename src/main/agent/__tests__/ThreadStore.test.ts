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
    await store.addMessage({ threadId: thread.id, role: 'user', contentJson: { text: 'hello' } })
    expect(prisma.agentThread.create).toHaveBeenCalledWith({ data: { title: 'Test', model: 'gpt-5.4' } })
    expect(prisma.agentMessage.create).toHaveBeenCalledWith({ data: { threadId: 'thread_1', role: 'user', contentJson: { text: 'hello' } } })
  })
})

import type { Prisma, PrismaClient } from '@prisma/client'

export class ThreadStore {
  constructor(private readonly prisma: PrismaClient) {}

  async createThread(input: { title: string; model: string }) {
    return this.prisma.agentThread.create({ data: input })
  }

  async listThreads() {
    // Order by lastMessageAt so empty threads (no messages yet) sink to the
    // bottom; fall back to updatedAt for rows whose lastMessageAt is still
    // null (Prisma sorts nulls to the end of `desc` by default).
    return this.prisma.agentThread.findMany({
      orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
    })
  }

  async addMessage(input: { threadId: string; role: string; items: Prisma.InputJsonValue }) {
    return this.prisma.agentMessage.create({ data: input })
  }

  async addToolCall(input: {
    messageId: string
    toolName: string
    paramsJson: Prisma.InputJsonValue
    status: string
  }) {
    return this.prisma.agentToolCall.create({ data: input })
  }

  async addArtifact(input: {
    threadId: string
    messageId?: string
    type: string
    uri: string
    metadata: Prisma.InputJsonValue
  }) {
    return this.prisma.agentArtifact.create({ data: input })
  }

  async loadThread(threadId: string) {
    return this.prisma.agentThread.findUnique({
      where: { id: threadId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          include: { toolCalls: true },
        },
        artifacts: true,
        attachments: true,
      },
    })
  }

  async openThread(threadId: string) {
    return this.prisma.agentThread.findUnique({
      where: { id: threadId },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
      },
    })
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    await this.prisma.agentThread.update({
      where: { id: threadId },
      data: { title, manualTitle: true },
    })
  }

  async renameThreadIfNotManual(threadId: string, title: string): Promise<void> {
    await this.prisma.agentThread.updateMany({
      where: { id: threadId, manualTitle: false },
      data: { title },
    })
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.prisma.agentThread.delete({ where: { id: threadId } })
  }

  async updateLastMessageAt(threadId: string): Promise<void> {
    await this.prisma.agentThread.update({
      where: { id: threadId },
      data: { lastMessageAt: new Date() },
    })
  }
}

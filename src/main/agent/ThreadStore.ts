import type { Prisma, PrismaClient } from '@prisma/client'

export class ThreadStore {
  constructor(private readonly prisma: PrismaClient) {}

  async createThread(input: { title: string; model: string }) {
    return this.prisma.agentThread.create({ data: input })
  }

  async listThreads() {
    return this.prisma.agentThread.findMany({ orderBy: { updatedAt: 'desc' } })
  }

  async addMessage(input: { threadId: string; role: string; contentJson: Prisma.InputJsonValue }) {
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
}

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

  /**
   * Stores the confirmed model for an existing Agent thread — e.g. after a
   * Gateway/model switch mid-conversation. Scoped to the target thread only
   * via `where: { id: threadId }`, matching {@link renameThread}.
   */
  async setThreadModel(threadId: string, model: string): Promise<void> {
    await this.prisma.agentThread.update({
      where: { id: threadId },
      data: { model },
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

  /**
   * Persist the Codex-protocol thread UUID for a DB thread so a later app
   * restart can `thread/resume` the same on-disk rollout (keeping conversation
   * memory) instead of starting a fresh, amnesiac codex thread. `updateMany`
   * (not `update`) so a stale/just-deleted thread id is a no-op rather than a
   * throw — this runs best-effort inside the streaming hot path.
   */
  async setCodexThreadId(threadId: string, codexThreadId: string): Promise<void> {
    await this.prisma.agentThread.updateMany({
      where: { id: threadId },
      data: { codexThreadId },
    })
  }

  /**
   * Fold the rollout's canonical userMessage echo (localImage paths +
   * text_elements, see `CodexUserMessageReconcile`) onto a persisted user
   * message row. Stored as a `codexReconcile` field on the row's FIRST
   * timeline item — row-level metadata, not a new visible item, so no
   * renderer switch has to learn a new item type. No-op when the row is gone
   * or empty: reconcile is a best-effort enhancement over DB-authoritative
   * data, never a reason to throw inside the streaming hot path.
   */
  async attachCodexReconcile(messageId: string, reconcile: Prisma.InputJsonValue): Promise<void> {
    const row = await this.prisma.agentMessage.findUnique({
      where: { id: messageId },
      select: { items: true },
    })
    if (!row || !Array.isArray(row.items) || row.items.length === 0) return
    const [first, ...rest] = row.items as Prisma.JsonArray
    if (!first || typeof first !== 'object' || Array.isArray(first)) return
    const items = [{ ...first, codexReconcile: reconcile }, ...rest] as Prisma.InputJsonValue
    await this.prisma.agentMessage.update({ where: { id: messageId }, data: { items } })
  }

  /** Read the persisted Codex thread UUID for a DB thread (null if none yet). */
  async getCodexThreadId(threadId: string): Promise<string | null> {
    const row = await this.prisma.agentThread.findUnique({
      where: { id: threadId },
      select: { codexThreadId: true },
    })
    return row?.codexThreadId ?? null
  }
}

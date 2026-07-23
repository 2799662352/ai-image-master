import type { Prisma, PrismaClient } from '@prisma/client'

import type {
  AgentThreadModelSnapshot,
  AgentThreadRoutingSnapshot,
} from '../../types/agent'

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

  /**
   * Reads one thread's confirmed model while preserving missing-vs-unset
   * identity for turn admission and transaction rollback.
   */
  async getThreadModelSnapshot(
    threadId: string,
  ): Promise<AgentThreadModelSnapshot> {
    const row = await this.prisma.agentThread.findUnique({
      where: { id: threadId },
      select: { model: true },
    })
    return row
      ? { exists: true, model: row.model ?? null }
      : { exists: false }
  }

  /**
   * Persists the thread→Gateway/Channel routing binding (Plan B per-thread
   * provider routing) together with the confirmed model, so re-opening this
   * thread later routes its turns to the same provider regardless of what the
   * GLOBAL selection has moved to since. Scoped to the target thread only.
   */
  async setThreadRouting(
    threadId: string,
    routing: { model: string; gatewayId: string; modelProvider: string },
  ): Promise<void> {
    await this.prisma.agentThread.update({
      where: { id: threadId },
      data: routing,
    })
  }

  /**
   * Reads one thread's routing binding. Pre-migration rows come back with
   * null gatewayId/modelProvider — the caller derives a fallback from the
   * active gateway + the persisted model (migration兜底), never throws.
   */
  async getThreadRoutingSnapshot(
    threadId: string,
  ): Promise<AgentThreadRoutingSnapshot> {
    const row = await this.prisma.agentThread.findUnique({
      where: { id: threadId },
      select: { model: true, gatewayId: true, modelProvider: true },
    })
    return row
      ? {
          exists: true,
          model: row.model ?? null,
          gatewayId: row.gatewayId ?? null,
          modelProvider: row.modelProvider ?? null,
        }
      : { exists: false }
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

  /**
   * Lean, ordered view of a thread's message rows for edit-and-resend
   * branching: `items` is included because the codex turn mapping lives in
   * the first item's `codexReconcile.turnId`. Ordered by createdAt asc to
   * match both the renderer timeline and `loadThread`.
   */
  async listMessagesForBranch(threadId: string) {
    return this.prisma.agentMessage.findMany({
      where: { threadId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, role: true, items: true },
    })
  }

  /**
   * Hard-delete message rows (edit-and-resend truncation: DB follows the
   * renderer's UI semantics — rows at/after the edit point must not
   * resurrect on the next thread reload). Scoped to the thread so a stale
   * renderer id can never delete another conversation's rows; AgentToolCall
   * children go with them via the schema's onDelete: Cascade.
   */
  async deleteMessages(threadId: string, messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return
    await this.prisma.agentMessage.deleteMany({
      where: { threadId, id: { in: messageIds } },
    })
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

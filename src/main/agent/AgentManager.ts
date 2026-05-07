import { CodexLocalBackend } from './CodexLocalBackend'
import type { BrowserWindow } from 'electron'
import type { AgentSendMessagePayload } from '../../types/agent'
import type { AttachmentService } from './AttachmentService'
import type { ThreadStore } from './ThreadStore'
import type { AgentInput, IAgentBackend } from './types'

export class AgentManager {
  private backend: IAgentBackend

  constructor(
    private win: BrowserWindow,
    private readonly store: ThreadStore,
    private readonly attachments: AttachmentService,
  ) {
    this.backend = new CodexLocalBackend()
  }

  setWindow(win: BrowserWindow): void {
    this.win = win
  }

  async start(): Promise<void> {
    await this.backend.start()
  }

  async stop(): Promise<void> {
    await this.backend.stop()
  }

  async sendMessage(payload: AgentSendMessagePayload): Promise<{ threadId: string }> {
    const thread = payload.threadId
      ? { id: payload.threadId }
      : await this.store.createThread({
          title: payload.content.slice(0, 40) || 'New Agent Thread',
          model: 'gpt-5.4',
        })
    const savedAttachments = await this.attachments.ingest(thread.id, payload.attachments ?? [])
    const items: AgentInput['items'] = [
      { type: 'text', text: payload.content },
      ...savedAttachments
        .filter((item) => item.mime.startsWith('image/'))
        .map((item) => ({ type: 'localImage' as const, path: item.localPath })),
    ]

    const input: AgentInput = {
      ...payload,
      model: 'gpt-5.4',
      cwd: process.cwd(),
      items,
    }

    void this.forwardEvents(thread.id, input).catch((error: unknown) => {
      this.win.webContents.send('agent:event', {
        type: 'error',
        threadId: thread.id,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    return { threadId: thread.id }
  }

  async cancel(threadId: string): Promise<void> {
    await this.backend.cancel(threadId)
  }

  async listThreads() {
    return this.store.listThreads()
  }

  async loadThread(threadId: string) {
    return this.store.loadThread(threadId)
  }

  private async forwardEvents(threadId: string, input: AgentInput): Promise<void> {
    for await (const event of this.backend.send(threadId, input)) {
      if (this.win.isDestroyed()) return
      this.win.webContents.send('agent:event', event)
    }
  }
}

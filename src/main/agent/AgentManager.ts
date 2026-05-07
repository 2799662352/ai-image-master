import { readFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { CodexLocalBackend } from './CodexLocalBackend'
import type { BrowserWindow } from 'electron'
import type { AgentSendMessagePayload, AgentStreamEvent } from '../../types/agent'
import type { AttachmentService } from './AttachmentService'
import type { ThreadStore } from './ThreadStore'
import type { AgentInput, IAgentBackend } from './types'

const CODEX_API_KEY_FILE = 'codex-agent.json'
const EMPTY_KEY_ERROR = '请在设置页填写 Codex Agent API Key'

export interface AgentManagerOptions {
  /** Directory used to persist the Codex API key JSON. Inject in tests. */
  userDataDir: string
  /** Window used as the default destination for `agent:event` broadcasts. */
  win?: BrowserWindow
  /** Persistence layer for threads/messages. Required for full sendMessage flow. */
  store?: ThreadStore
  /** Attachment ingest pipeline. Required for full sendMessage flow. */
  attachments?: AttachmentService
  /**
   * Test seam for receiving `AgentStreamEvent`s instead of broadcasting to a
   * BrowserWindow. When omitted, events are sent to `win.webContents` (if
   * present and not destroyed).
   */
  eventSink?: (event: AgentStreamEvent) => void
}

export class AgentManager {
  private backend: IAgentBackend
  private win: BrowserWindow | undefined
  private readonly store: ThreadStore | undefined
  private readonly attachments: AttachmentService | undefined
  private readonly eventSink: ((event: AgentStreamEvent) => void) | undefined
  private readonly codexApiKeyPath: string
  private codexApiKey = ''

  constructor(opts: AgentManagerOptions) {
    this.win = opts.win
    this.store = opts.store
    this.attachments = opts.attachments
    this.eventSink = opts.eventSink
    this.codexApiKeyPath = path.join(opts.userDataDir, CODEX_API_KEY_FILE)
    this.loadCodexApiKey()
    this.backend = new CodexLocalBackend({ getApiKey: () => this.codexApiKey })
  }

  setWindow(win: BrowserWindow): void {
    this.win = win
  }

  getCodexApiKey(): string {
    return this.codexApiKey
  }

  async setCodexApiKey(key: string): Promise<void> {
    const trimmed = key.trim()
    const tmpPath = `${this.codexApiKeyPath}.tmp`
    await fs.writeFile(tmpPath, JSON.stringify({ openaiApiKey: trimmed }), 'utf8')
    await fs.rename(tmpPath, this.codexApiKeyPath)
    this.codexApiKey = trimmed
  }

  async start(): Promise<void> {
    await this.backend.start()
  }

  async stop(): Promise<void> {
    await this.backend.stop()
  }

  async sendMessage(payload: AgentSendMessagePayload): Promise<{ threadId: string }> {
    if (!this.codexApiKey) {
      const threadId = payload.threadId ?? 'pending'
      this.emitEvent({ type: 'error', threadId, error: EMPTY_KEY_ERROR })
      return { threadId }
    }

    if (!this.store || !this.attachments) {
      throw new Error('AgentManager.sendMessage called without store/attachments')
    }

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
      this.emitEvent({
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
    if (!this.store) throw new Error('AgentManager.listThreads called without store')
    return this.store.listThreads()
  }

  async loadThread(threadId: string) {
    if (!this.store) throw new Error('AgentManager.loadThread called without store')
    return this.store.loadThread(threadId)
  }

  private loadCodexApiKey(): void {
    try {
      const raw = readFileSync(this.codexApiKeyPath, 'utf8')
      const parsed = JSON.parse(raw) as { openaiApiKey?: unknown }
      this.codexApiKey = typeof parsed?.openaiApiKey === 'string' ? parsed.openaiApiKey : ''
    } catch {
      this.codexApiKey = ''
    }
  }

  private emitEvent(event: AgentStreamEvent): void {
    if (this.eventSink) {
      this.eventSink(event)
      return
    }
    const win = this.win
    if (!win || win.isDestroyed()) return
    win.webContents.send('agent:event', event)
  }

  private async forwardEvents(threadId: string, input: AgentInput): Promise<void> {
    for await (const event of this.backend.send(threadId, input)) {
      if (!this.eventSink && this.win?.isDestroyed()) return
      this.emitEvent(event)
    }
  }
}

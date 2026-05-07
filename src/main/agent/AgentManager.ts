import { readFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { CodexLocalBackend } from './CodexLocalBackend'
import type { BrowserWindow } from 'electron'
import type { AgentSendMessagePayload, AgentStreamEvent } from '../../types/agent'
import type { AttachmentService } from './AttachmentService'
import type { ThreadStore } from './ThreadStore'
import type { AgentInput, IAgentBackend } from './types'
import { ThreadTitleSummarizer } from './ThreadTitleSummarizer'

const CODEX_API_KEY_FILE = 'codex-agent.json'
const EMPTY_KEY_ERROR = '请在设置页填写 Codex Agent API Key'

/**
 * Default Codex provider config. Points at API易 (apiyi), an
 * OpenAI-compatible Responses API gateway. Hardcoded for MVP — eventually we
 * should expose this via the same settings page that hosts the API key.
 *
 * `gpt-4.1-mini` is a model APIYI documents as supported on the Responses
 * endpoint. Codex's older default `gpt-5.4` does not exist there.
 */
const DEFAULT_AGENT_MODEL = 'gpt-4.1-mini'
const DEFAULT_PROVIDER = {
  id: 'apiyi',
  name: 'API Yi',
  baseUrl: 'https://api.apiyi.com/v1',
  envKey: 'OPENAI_API_KEY',
} as const

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
  /**
   * Test seam for injecting a fake backend. When omitted, a real
   * `CodexLocalBackend` is constructed.
   */
  backend?: IAgentBackend
}

export class AgentManager {
  private backend: IAgentBackend
  private win: BrowserWindow | undefined
  private readonly store: ThreadStore | undefined
  private readonly attachments: AttachmentService | undefined
  private readonly eventSink: ((event: AgentStreamEvent) => void) | undefined
  private readonly codexApiKeyPath: string
  private codexApiKey = ''
  private summarizer?: ThreadTitleSummarizer
  private readonly firstTurnDoneByThread = new Map<string, boolean>()
  /**
   * Maps our DB thread row id (a Prisma CUID like `cm6abc...`) to the
   * Codex-protocol thread id (a UUID like `urn:uuid:...` returned by
   * `thread/start`). Codex's app-server validates wire ids as UUIDs, so we
   * must never leak DB cuids into `turn/start`. Mapping is in-memory only;
   * an app restart resets it (acceptable for MVP, since Codex itself doesn't
   * resume threads across app-server lifetimes).
   */
  private readonly codexThreadIdByDbThreadId = new Map<string, string>()

  constructor(opts: AgentManagerOptions) {
    this.win = opts.win
    this.store = opts.store
    this.attachments = opts.attachments
    this.eventSink = opts.eventSink
    this.codexApiKeyPath = path.join(opts.userDataDir, CODEX_API_KEY_FILE)
    this.loadCodexApiKey()
    this.backend = opts.backend ?? new CodexLocalBackend({
      getApiKey: () => this.codexApiKey,
      provider: DEFAULT_PROVIDER,
    })
    if (this.store) {
      this.summarizer = new ThreadTitleSummarizer(this.store, this.backend, DEFAULT_AGENT_MODEL)
    }
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

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    if (!this.codexApiKey) {
      return { ok: false, error: '请先填写 API Key' }
    }
    // Build a fresh, isolated backend so we never disturb the long-lived one.
    // Re-uses the production resourceRoot resolution path inside CodexLocalBackend
    // (app.getAppPath / process.resourcesPath) — the only thing we tighten is
    // the connect timeout so a misconfigured key fails fast instead of waiting
    // the full production budget.
    const backend = new CodexLocalBackend({
      getApiKey: () => this.codexApiKey,
      connectTimeoutMs: 8_000,
      provider: DEFAULT_PROVIDER,
    })
    const TEST_TIMEOUT_MS = 15_000

    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        backend.start(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Test connection timeout')), TEST_TIMEOUT_MS)
          timer.unref?.()
        }),
      ])
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      if (timer) clearTimeout(timer)
      await backend.stop().catch(() => { /* ignore */ })
    }
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

    const model = payload.model?.trim() || DEFAULT_AGENT_MODEL
    const thread = payload.threadId
      ? { id: payload.threadId }
      : await this.store.createThread({
          title: payload.content.slice(0, 40) || 'New Agent Thread',
          model,
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
      model,
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
    const codexThreadId = this.codexThreadIdByDbThreadId.get(threadId)
    await this.backend.cancel(codexThreadId ?? threadId)
  }

  async listThreads() {
    if (!this.store) throw new Error('AgentManager.listThreads called without store')
    return this.store.listThreads()
  }

  async loadThread(threadId: string) {
    if (!this.store) throw new Error('AgentManager.loadThread called without store')
    return this.store.loadThread(threadId)
  }

  async openThread(threadId: string) {
    if (!this.store) throw new Error('AgentManager.openThread called without store')
    return this.store.openThread(threadId)
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    if (!this.store) throw new Error('AgentManager.renameThread called without store')
    return this.store.renameThread(threadId, title)
  }

  async deleteThread(threadId: string): Promise<void> {
    if (!this.store) throw new Error('AgentManager.deleteThread called without store')
    return this.store.deleteThread(threadId)
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

  private async forwardEvents(dbThreadId: string, input: AgentInput): Promise<void> {
    const codexThreadId = this.codexThreadIdByDbThreadId.get(dbThreadId)
    for await (const event of this.backend.send(codexThreadId, input)) {
      if (event.type === 'thread_created' && event.threadId) {
        this.codexThreadIdByDbThreadId.set(dbThreadId, event.threadId)
      }
      if (!this.eventSink && this.win?.isDestroyed()) return
      // Renderer's chat store filters events by its DB threadId. Always rewrite
      // so codex-side UUIDs never leak into the UI layer.
      this.emitEvent({ ...event, threadId: dbThreadId })
      if (event.type === 'turn_completed') {
        if (dbThreadId && !this.firstTurnDoneByThread.get(dbThreadId)) {
          this.firstTurnDoneByThread.set(dbThreadId, true)
          this.summarizer?.maybeSummarize(dbThreadId).catch((err: unknown) => {
            console.warn('[AgentManager] thread title summarization failed:', err)
          })
        }
      }
    }
  }
}

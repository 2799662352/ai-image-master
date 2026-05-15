import type { ThreadStore } from './ThreadStore'
import type { IAgentBackend, AgentInput } from './types'

const SUMMARIZE_PROMPT =
  'Summarize this conversation in 4–6 Chinese words. No punctuation. Reply with the title only.'
const MAX_RETRIES = 3
const MAX_TITLE_LEN = 40

function normalizeJsonPayload(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return raw
    }
  }
  return raw
}

function messageItemsPayload(m: { items?: unknown; contentJson?: unknown }): unknown {
  if (m.items !== undefined && m.items !== null) return normalizeJsonPayload(m.items)
  const legacy = (m as { contentJson?: unknown }).contentJson
  if (legacy !== undefined && legacy !== null) return normalizeJsonPayload(legacy)
  return []
}

export class ThreadTitleSummarizer {
  private readonly retryCountByThread = new Map<string, number>()

  constructor(
    private readonly store: ThreadStore,
    private readonly backend: IAgentBackend,
    private readonly model: string,
  ) {}

  private async loadThreadForSummary(threadId: string) {
    const s = this.store as ThreadStore & {
      openThread?: (id: string) => ReturnType<ThreadStore['openThread']>
      loadThread?: (id: string) => ReturnType<ThreadStore['loadThread']>
    }
    if (typeof s.openThread === 'function') return s.openThread(threadId)
    if (typeof s.loadThread === 'function') return s.loadThread(threadId)
    return null
  }

  async maybeSummarize(threadId: string): Promise<void> {
    const startRetries = this.retryCountByThread.get(threadId) ?? 0
    if (startRetries >= MAX_RETRIES) return

    const thread = await this.loadThreadForSummary(threadId)
    if (!thread) return
    if (thread.manualTitle) return

    const messages = thread.messages ?? []
    if (messages.length < 2) return

    const firstUser = messages.find((m) => m.role === 'user')
    const firstAssistant = messages.find((m) => m.role === 'assistant')
    if (!firstUser || !firstAssistant) return

    const userText = JSON.stringify(messageItemsPayload(firstUser))
    const assistantText = JSON.stringify(messageItemsPayload(firstAssistant))
    const context = `User: ${userText.slice(0, 200)}\nAssistant: ${assistantText.slice(0, 200)}`
    const fullPrompt = `${context}\n\n${SUMMARIZE_PROMPT}`

    const input: AgentInput = {
      content: fullPrompt,
      model: this.model,
      cwd: process.cwd(),
      items: [{ type: 'text', text: fullPrompt }],
      attachments: [],
    }

    let attempt = startRetries
    while (attempt < MAX_RETRIES) {
      try {
        let title = ''
        for await (const event of this.backend.send(undefined, input)) {
          if (event.type === 'item_delta' && event.itemType === 'text') {
            const patch = event.patch
            if (
              patch.kind === 'appendText' &&
              patch.field === 'content' &&
              typeof patch.text === 'string'
            ) {
              title += patch.text
            }
          }
        }

        title = title.trim().slice(0, MAX_TITLE_LEN)
        if (title.length > 0) {
          await this.store.renameThreadIfNotManual(threadId, title)
        }
        this.retryCountByThread.delete(threadId)
        return
      } catch {
        attempt += 1
        this.retryCountByThread.set(threadId, attempt)
      }
    }
  }
}

import type { ThreadStore } from './ThreadStore'
import type { IAgentBackend } from './types'

/** Pinned from upstream codex-rs `tui/src/app/thread_title.rs` @ rust-v0.161.0. */
export const THREAD_TITLE_MAX_CHARS = 36
export const THREAD_TITLE_PROMPT_MAX_BYTES = 960
export const THREAD_TITLE_TIMEOUT_MS = 30_000
export const THREAD_TITLE_SOURCE = 'thread_title'

const THREAD_TITLE_INSTRUCTIONS =
  `Generate a concise, single-line task title of at most ${THREAD_TITLE_MAX_CHARS} characters `
  + 'and under five words where possible. Start with an imperative verb. Capitalize only the first '
  + "word unless the user's language, proper nouns, acronyms, or code terms require otherwise. "
  + "Preserve ticket references exactly. Write in the user's language. Do not use quotes, "
  + 'markdown, or trailing punctuation. Do not answer the request.'

const QUOTE_CHARACTERS = new Set(['"', "'", '`', '“', '”', '‘', '’'])
/** Upstream trims `. ? !`; the full-width forms cover Chinese titles. */
const TRAILING_PUNCTUATION = /[.?!。？！]+$/u
const CODE_FENCE = /^```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/u

/** Bounds the whole prompt to 960 UTF-8 bytes without splitting a character. */
export function threadTitlePrompt(userMessage: string): string {
  const prefix = `${THREAD_TITLE_INSTRUCTIONS}\n\nUser prompt:\n`
  let remainingBytes = THREAD_TITLE_PROMPT_MAX_BYTES - Buffer.byteLength(prefix, 'utf8')
  let kept = ''
  for (const character of userMessage.trim()) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (bytes > remainingBytes) break
    kept += character
    remainingBytes -= bytes
  }
  return prefix + kept
}

export function threadTitleOutputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: THREAD_TITLE_MAX_CHARS },
    },
    required: ['title'],
    additionalProperties: false,
  }
}

export function parseThreadTitle(response: string): string | null {
  const trimmed = response.trim()
  const body = CODE_FENCE.exec(trimmed)?.[1]?.trim() ?? trimmed
  if (body.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return null
    }
    const title = parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).title
      : undefined
    return typeof title === 'string' ? normalizeTitle(title) : null
  }
  // Gateways that ignore `outputSchema` answer in plain text (openai/codex#44502).
  // A line past the limit means the model answered the request instead.
  const firstLine = body.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length > 0)
  if (!firstLine || Array.from(firstLine).length > THREAD_TITLE_MAX_CHARS) return null
  return normalizeTitle(firstLine)
}

function normalizeTitle(raw: string): string | null {
  const characters = Array.from(raw.trim())
  let start = 0
  let end = characters.length
  while (start < end && QUOTE_CHARACTERS.has(characters[start])) start += 1
  while (end > start && QUOTE_CHARACTERS.has(characters[end - 1])) end -= 1
  const title = characters
    .slice(start, end)
    .join('')
    .split(/\s+/u)
    .filter((word) => word.length > 0)
    .join(' ')
    .replace(TRAILING_PUNCTUATION, '')
    .trimEnd()
  if (!title) return null
  return Array.from(title).slice(0, THREAD_TITLE_MAX_CHARS).join('')
}

export interface ThreadTitleModel {
  model: string
  effort?: string
}

/**
 * The channel's `memoriesModel` is the model it pins for background side
 * requests: a slug its endpoint is known to serve, usually its cheapest tier
 * (see `gatewayModelRouting`). It stands in for upstream's dedicated title
 * model (gpt-5.6-luna, first-party OpenAI auth only), which upstream runs at
 * low effort; the conversation-model fallback keeps its default effort.
 */
export function resolveThreadTitleModel(
  channel: { memoriesModel?: string } | undefined,
  conversationModel: string,
): ThreadTitleModel {
  const pinned = channel?.memoriesModel?.trim()
  return pinned ? { model: pinned, effort: 'low' } : { model: conversationModel }
}

export interface ThreadTitleRequest extends ThreadTitleModel {
  /** Our DB thread row id. */
  threadId: string
  /** Text of the thread's first user message. */
  userMessage: string
  /** Omitted = the process-active provider, same as the conversation. */
  modelProvider?: string
  cwd: string
}

export class ThreadTitleGenerator {
  private readonly inFlight = new Set<string>()

  constructor(
    private readonly store: Pick<ThreadStore, 'renameThreadIfNotManual'>,
    private readonly backend: Pick<IAgentBackend, 'runTemporaryStructuredTurn'>,
    private readonly log: (line: string) => void = (line) => console.info(line),
  ) {}

  /** Makes a single attempt and never throws; resolves the saved title or `null`. */
  async generate(request: ThreadTitleRequest): Promise<string | null> {
    const userMessage = request.userMessage.trim()
    if (!userMessage || !this.backend.runTemporaryStructuredTurn || this.inFlight.has(request.threadId)) {
      return null
    }
    this.inFlight.add(request.threadId)
    const startedAt = Date.now()
    try {
      const result = await this.backend.runTemporaryStructuredTurn({
        threadSource: THREAD_TITLE_SOURCE,
        model: request.model,
        ...(request.modelProvider ? { modelProvider: request.modelProvider } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
        cwd: request.cwd,
        prompt: threadTitlePrompt(userMessage),
        outputSchema: threadTitleOutputSchema(),
        timeoutMs: THREAD_TITLE_TIMEOUT_MS,
      })
      const title = parseThreadTitle(result.text)
      const usage = result.usage
      this.log(
        `[thread-title] model=${request.model} effort=${request.effort ?? 'default'} `
        + `provider=${request.modelProvider ?? 'active'} `
        + `input=${usage?.inputTokens ?? '?'} cached=${usage?.cachedInputTokens ?? 0} `
        + `output=${usage?.outputTokens ?? '?'} reasoning=${usage?.reasoningTokens ?? 0} `
        + `${Date.now() - startedAt}ms ${title ? 'saved' : 'unusable response'}`,
      )
      if (!title) return null
      await this.store.renameThreadIfNotManual(request.threadId, title)
      return title
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log(`[thread-title] model=${request.model} failed after ${Date.now() - startedAt}ms: ${detail}`)
      return null
    } finally {
      this.inFlight.delete(request.threadId)
    }
  }
}

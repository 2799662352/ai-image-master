import { describe, expect, it } from 'vitest'
import {
  THREAD_TITLE_MAX_CHARS,
  THREAD_TITLE_PROMPT_MAX_BYTES,
  THREAD_TITLE_SOURCE,
  ThreadTitleGenerator,
  parseThreadTitle,
  resolveThreadTitleModel,
  threadTitleOutputSchema,
  threadTitlePrompt,
  type ThreadTitleRequest,
} from '../threadTitle'
import type { TemporaryStructuredTurnRequest, TemporaryStructuredTurnResult } from '../types'

const OFFICIAL_INSTRUCTIONS =
  'Generate a concise, single-line task title of at most 36 characters and under five words where possible. '
  + 'Start with an imperative verb. Capitalize only the first word unless the user\'s language, proper nouns, '
  + 'acronyms, or code terms require otherwise. Preserve ticket references exactly. Write in the user\'s language. '
  + 'Do not use quotes, markdown, or trailing punctuation. Do not answer the request.'

describe('threadTitlePrompt', () => {
  it('wraps the trimmed first user message with the upstream title instructions', () => {
    expect(threadTitlePrompt('  帮我把登录页的报错修好  ')).toBe(
      `${OFFICIAL_INSTRUCTIONS}\n\nUser prompt:\n帮我把登录页的报错修好`,
    )
  })

  it('caps the whole prompt at 960 UTF-8 bytes without splitting a character', () => {
    const prompt = threadTitlePrompt('修复😀'.repeat(400))
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(THREAD_TITLE_PROMPT_MAX_BYTES)
    expect(prompt).not.toContain('\uFFFD')
    expect(prompt.endsWith('修') || prompt.endsWith('复') || prompt.endsWith('😀')).toBe(true)
    // A lone high surrogate would mean an emoji got cut in half.
    expect(/[\uD800-\uDBFF]$/.test(prompt)).toBe(false)
  })
})

describe('parseThreadTitle', () => {
  it('reads the title out of the structured JSON response', () => {
    expect(parseThreadTitle('{"title":"修复登录页报错"}')).toBe('修复登录页报错')
  })

  it('normalizes quotes, whitespace and trailing punctuation like upstream', () => {
    expect(parseThreadTitle('{"title":"  “Fix   the login\\tbug.”  "}')).toBe('Fix the login bug')
    expect(parseThreadTitle('{"title":"修复登录页。"}')).toBe('修复登录页')
  })

  it('truncates to 36 characters, counting code points', () => {
    const title = parseThreadTitle(JSON.stringify({ title: '修'.repeat(50) }))
    expect(title).toBe('修'.repeat(THREAD_TITLE_MAX_CHARS))
  })

  it('accepts a fenced JSON block from models that ignore the output schema', () => {
    expect(parseThreadTitle('```json\n{"title":"整理发布流程"}\n```')).toBe('整理发布流程')
  })

  it('falls back to a short plain-text line from gateways that ignore the output schema', () => {
    expect(parseThreadTitle('整理发布流程\n')).toBe('整理发布流程')
  })

  it('rejects empty titles, broken JSON and long plain-text answers', () => {
    expect(parseThreadTitle('{"title":"  "}')).toBeNull()
    expect(parseThreadTitle('{"title":')).toBeNull()
    expect(parseThreadTitle('{"name":"x"}')).toBeNull()
    expect(parseThreadTitle('   ')).toBeNull()
    expect(parseThreadTitle('当然可以!下面是修复登录页报错的完整步骤,首先打开开发者工具查看控制台,然后定位到抛出异常的那一行代码再逐步排查。')).toBeNull()
  })
})

describe('threadTitleOutputSchema', () => {
  it('constrains the response to one nonempty title within the display limit', () => {
    expect(threadTitleOutputSchema()).toEqual({
      type: 'object',
      properties: { title: { type: 'string', minLength: 1, maxLength: 36 } },
      required: ['title'],
      additionalProperties: false,
    })
  })
})

describe('resolveThreadTitleModel', () => {
  it("runs the channel's pinned background model at low effort", () => {
    expect(resolveThreadTitleModel({ memoriesModel: 'qwen3.8-flash' }, 'qwen3.8-max'))
      .toEqual({ model: 'qwen3.8-flash', effort: 'low' })
  })

  it('falls back to the conversation model at its default effort when the channel pins none', () => {
    expect(resolveThreadTitleModel({}, 'grok-4.6')).toEqual({ model: 'grok-4.6' })
    expect(resolveThreadTitleModel(undefined, 'claude-sonnet-5')).toEqual({ model: 'claude-sonnet-5' })
  })
})

function request(overrides: Partial<ThreadTitleRequest> = {}): ThreadTitleRequest {
  return {
    threadId: 'thread-1',
    userMessage: '帮我把登录页的报错修好',
    model: 'qwen3.8-flash',
    cwd: 'D:/work',
    ...overrides,
  }
}

function makeBackend(result: TemporaryStructuredTurnResult | Error) {
  const calls: TemporaryStructuredTurnRequest[] = []
  return {
    calls,
    backend: {
      async runTemporaryStructuredTurn(req: TemporaryStructuredTurnRequest) {
        calls.push(req)
        if (result instanceof Error) throw result
        return result
      },
    },
  }
}

function makeStore() {
  const renames: Array<{ threadId: string; title: string }> = []
  return {
    renames,
    store: {
      async renameThreadIfNotManual(threadId: string, title: string) {
        renames.push({ threadId, title })
      },
    },
  }
}

describe('ThreadTitleGenerator', () => {
  it('runs one temporary structured turn and saves the parsed title', async () => {
    const { backend, calls } = makeBackend({
      text: '{"title":"修复登录页报错"}',
      usage: { inputTokens: 1200, outputTokens: 9 },
    })
    const { store, renames } = makeStore()
    const generator = new ThreadTitleGenerator(store, backend, () => undefined)

    await expect(generator.generate(request({ modelProvider: 'apiyi-qwen', effort: 'low' })))
      .resolves.toBe('修复登录页报错')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      threadSource: THREAD_TITLE_SOURCE,
      model: 'qwen3.8-flash',
      modelProvider: 'apiyi-qwen',
      effort: 'low',
      cwd: 'D:/work',
      prompt: threadTitlePrompt('帮我把登录页的报错修好'),
      outputSchema: threadTitleOutputSchema(),
      timeoutMs: 30_000,
    })
    expect(renames).toEqual([{ threadId: 'thread-1', title: '修复登录页报错' }])
  })

  it('leaves provider and effort unset when the request has none', async () => {
    const { backend, calls } = makeBackend({ text: '{"title":"修复登录页报错"}' })
    const generator = new ThreadTitleGenerator(makeStore().store, backend, () => undefined)

    await generator.generate(request())

    expect('modelProvider' in calls[0]).toBe(false)
    expect('effort' in calls[0]).toBe(false)
  })

  it('omits modelProvider when the conversation runs on the active channel', async () => {
    const { backend, calls } = makeBackend({ text: '{"title":"x"}' })
    const generator = new ThreadTitleGenerator(makeStore().store, backend, () => undefined)

    await generator.generate(request())

    expect('modelProvider' in calls[0]).toBe(false)
  })

  it('does nothing for an empty message or a backend without the capability', async () => {
    const { backend, calls } = makeBackend({ text: '{"title":"x"}' })
    const { store, renames } = makeStore()

    await expect(new ThreadTitleGenerator(store, backend, () => undefined).generate(request({ userMessage: '  ' })))
      .resolves.toBeNull()
    await expect(new ThreadTitleGenerator(store, {}, () => undefined).generate(request())).resolves.toBeNull()

    expect(calls).toHaveLength(0)
    expect(renames).toEqual([])
  })

  it('makes a single attempt and keeps the existing title when the request fails', async () => {
    const { backend, calls } = makeBackend(new Error('temporary structured turn timed out after 30000ms'))
    const { store, renames } = makeStore()
    const logs: string[] = []

    await expect(new ThreadTitleGenerator(store, backend, (line) => logs.push(line)).generate(request()))
      .resolves.toBeNull()

    expect(calls).toHaveLength(1)
    expect(renames).toEqual([])
    expect(logs.join('\n')).toMatch(/timed out/)
  })

  it('keeps the existing title when the response is not a usable title', async () => {
    const { backend } = makeBackend({ text: '{"title":""}' })
    const { store, renames } = makeStore()

    await expect(new ThreadTitleGenerator(store, backend, () => undefined).generate(request())).resolves.toBeNull()
    expect(renames).toEqual([])
  })

  it('ignores a second request for a thread whose title is still generating', async () => {
    const calls: TemporaryStructuredTurnRequest[] = []
    let finish: ((value: TemporaryStructuredTurnResult) => void) | undefined
    const backend = {
      runTemporaryStructuredTurn(req: TemporaryStructuredTurnRequest) {
        calls.push(req)
        return new Promise<TemporaryStructuredTurnResult>((resolve) => { finish = resolve })
      },
    }
    const generator = new ThreadTitleGenerator(makeStore().store, backend, () => undefined)

    const first = generator.generate(request())
    await expect(generator.generate(request())).resolves.toBeNull()
    finish?.({ text: '{"title":"x"}' })
    await first

    expect(calls).toHaveLength(1)
  })

  it('logs the token usage of each attempt so the cost stays visible', async () => {
    const { backend } = makeBackend({
      text: '{"title":"x"}',
      usage: { inputTokens: 1234, cachedInputTokens: 1000, outputTokens: 7, reasoningTokens: 0 },
    })
    const logs: string[] = []

    await new ThreadTitleGenerator(makeStore().store, backend, (line) => logs.push(line)).generate(request())

    expect(logs.join('\n')).toMatch(/input=1234/)
    expect(logs.join('\n')).toMatch(/cached=1000/)
    expect(logs.join('\n')).toMatch(/output=7/)
    expect(logs.join('\n')).toMatch(/model=qwen3\.8-flash/)
  })
})

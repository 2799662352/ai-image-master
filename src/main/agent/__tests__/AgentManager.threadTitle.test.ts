/**
 * Auto thread titles follow the upstream TUI: one hidden request per NEW
 * thread, started as soon as codex has accepted the first user message (in
 * parallel with the main turn), fed only that message's text. Threads that
 * already exist — including every thread after an app restart — never get an
 * automatic title again.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentManager } from '../AgentManager'
import { THREAD_TITLE_SOURCE, threadTitlePrompt } from '../threadTitle'
import type {
  AgentInput,
  IAgentBackend,
  TemporaryStructuredTurnRequest,
  TemporaryStructuredTurnResult,
} from '../types'
import type { AgentStreamEvent } from '../../../types/agent'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-title-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const RECONCILED: AgentStreamEvent = {
  type: 'user_message_reconciled',
  threadId: 'codex-t',
  reconcile: { codexItemId: 'item-1', clientId: 'msg_row_1', localImages: [], textElements: [] },
}

interface TitleBackend extends IAgentBackend {
  titleRequests: TemporaryStructuredTurnRequest[]
  sends: Array<{ threadId: string | undefined; input: AgentInput }>
}

function makeBackend(
  turns: Array<AgentStreamEvent[] | ((emit: () => void) => AsyncIterable<AgentStreamEvent>)>,
  titleResult: TemporaryStructuredTurnResult = { text: '{"title":"修复登录页报错"}' },
): TitleBackend {
  const titleRequests: TemporaryStructuredTurnRequest[] = []
  const sends: Array<{ threadId: string | undefined; input: AgentInput }> = []
  let turnIndex = 0
  return {
    titleRequests,
    sends,
    async start() { },
    async stop() { },
    isHealthy() { return true },
    async cancel() { },
    async *send(threadId: string | undefined, input: AgentInput): AsyncIterable<AgentStreamEvent> {
      sends.push({ threadId, input })
      const turn = turns[turnIndex++] ?? []
      if (typeof turn === 'function') {
        yield* turn(() => undefined)
        return
      }
      for (const event of turn) yield event
    },
    async runTemporaryStructuredTurn(request: TemporaryStructuredTurnRequest) {
      titleRequests.push(request)
      return titleResult
    },
  }
}

function makeManager(backend: IAgentBackend, renames: Array<{ threadId: string; title: string }>): AgentManager {
  let messageCount = 0
  return new AgentManager({
    userDataDir: tmpDir,
    backend,
    store: {
      createThread: async () => ({ id: 'thread-1' }),
      addMessage: async () => ({ id: `msg_row_${++messageCount}` }),
      updateLastMessageAt: async () => undefined,
      renameThreadIfNotManual: async (threadId: string, title: string) => {
        renames.push({ threadId, title })
      },
    } as never,
    attachments: { ingest: async () => [] } as never,
    eventSink: () => undefined,
  })
}

async function settle(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r))
}

describe('AgentManager automatic thread titles', () => {
  it('titles a new thread from its first message on the channel background model', async () => {
    const backend = makeBackend([[
      { type: 'thread_created', threadId: 'codex-t' },
      RECONCILED,
      { type: 'turn_completed', threadId: 'codex-t' },
    ]])
    const renames: Array<{ threadId: string; title: string }> = []
    const mgr = makeManager(backend, renames)
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({ content: '帮我把登录页的报错修好', model: 'gpt-5.6-sol', attachments: [] })
    await settle()

    expect(backend.titleRequests).toHaveLength(1)
    const [request] = backend.titleRequests
    expect(request.threadSource).toBe(THREAD_TITLE_SOURCE)
    expect(request.prompt).toBe(threadTitlePrompt('帮我把登录页的报错修好'))
    // apiyi-standard (the default channel) pins gpt-5.5 for background work.
    expect(request.model).toBe('gpt-5.5')
    expect(request.effort).toBe('low')
    expect('modelProvider' in request).toBe(false)
    expect(request.cwd).toBe(backend.sends[0].input.cwd)
    expect(renames).toEqual([{ threadId: 'thread-1', title: '修复登录页报错' }])
  })

  it('starts the title as soon as the user message is accepted, without waiting for the turn', async () => {
    let finishTurn: (() => void) | undefined
    const turnDone = new Promise<void>((resolve) => { finishTurn = resolve })
    const backend = makeBackend([
      async function* longTurn() {
        yield { type: 'thread_created', threadId: 'codex-t' } as AgentStreamEvent
        yield RECONCILED
        await turnDone
        yield { type: 'turn_completed', threadId: 'codex-t' } as AgentStreamEvent
      },
    ])
    const mgr = makeManager(backend, [])
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({ content: '整理一下发布流程', attachments: [] })
    await settle()

    expect(backend.titleRequests).toHaveLength(1)
    finishTurn?.()
    await settle()
    expect(backend.titleRequests).toHaveLength(1)
  })

  it('falls back to the end of the first turn when codex never echoes the user message', async () => {
    const backend = makeBackend([[
      { type: 'thread_created', threadId: 'codex-t' },
      { type: 'turn_completed', threadId: 'codex-t' },
    ]])
    const mgr = makeManager(backend, [])
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({ content: '整理一下发布流程', attachments: [] })
    await settle()

    expect(backend.titleRequests).toHaveLength(1)
  })

  it('titles a thread only once, even across later turns', async () => {
    const turn = (): AgentStreamEvent[] => [RECONCILED, { type: 'turn_completed', threadId: 'codex-t' }]
    const backend = makeBackend([
      [{ type: 'thread_created', threadId: 'codex-t' }, ...turn()],
      turn(),
    ])
    const mgr = makeManager(backend, [])
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({ content: '第一条', attachments: [] })
    await settle()
    await mgr.sendMessage({ threadId: 'thread-1', content: '第二条', attachments: [] })
    await settle()

    expect(backend.sends).toHaveLength(2)
    expect(backend.titleRequests).toHaveLength(1)
    expect(backend.titleRequests[0].prompt).toBe(threadTitlePrompt('第一条'))
  })

  it('never re-titles an existing thread (e.g. the first turn after an app restart)', async () => {
    const backend = makeBackend([[RECONCILED, { type: 'turn_completed', threadId: 'codex-t' }]])
    const renames: Array<{ threadId: string; title: string }> = []
    const mgr = makeManager(backend, renames)
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({ threadId: 'thread-old', content: '继续', attachments: [] })
    await settle()

    expect(backend.sends).toHaveLength(1)
    expect(backend.titleRequests).toEqual([])
    expect(renames).toEqual([])
  })
})

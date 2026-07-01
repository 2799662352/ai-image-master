import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentManager } from '../AgentManager'
import type { AgentInput, IAgentBackend } from '../types'
import type { AgentStreamEvent } from '../../../types/agent'

// Codex mints a UUID thread id via thread/start; our DB rows are CUIDs. The
// manager translates between the two, and `steer` must reach the backend with
// the *codex* id it recorded from the `thread_created` event.
const CODEX_UUID = '11111111-2222-3333-4444-555555555555'

interface SteerCall {
  threadId: string
  input: AgentInput
}

function makeSteerableBackend(script: AgentStreamEvent[]): IAgentBackend & {
  sendCalls: Array<string | undefined>
  steerCalls: SteerCall[]
} {
  const sendCalls: Array<string | undefined> = []
  const steerCalls: SteerCall[] = []
  return {
    sendCalls,
    steerCalls,
    async start() {},
    async stop() {},
    isHealthy() { return true },
    async cancel() {},
    async steer(threadId: string, input: AgentInput) {
      steerCalls.push({ threadId, input })
      return 'turn-1'
    },
    async *send(threadId: string | undefined) {
      sendCalls.push(threadId)
      for (const e of script) yield e
    },
  } as unknown as IAgentBackend & { sendCalls: Array<string | undefined>; steerCalls: SteerCall[] }
}

function flushMicrotasks(times = 20): Promise<void> {
  let p: Promise<void> = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => undefined)
  return p
}

const persistStubs = {
  addMessage: async () => ({ id: 'msg-stub' }),
  updateLastMessageAt: async () => undefined,
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-steer-test-'))
  await fs.writeFile(
    path.join(tmpDir, 'codex-agent.json'),
    JSON.stringify({ openaiApiKey: 'sk-test' }),
    'utf8',
  )
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('AgentManager.steer (turn/steer)', () => {
  it('appends to the active turn: calls backend.steer with the codex thread id and persists the user message', async () => {
    const added: Array<{ role: string }> = []
    const fakeStore = {
      ...persistStubs,
      createThread: async () => ({ id: 'db-1' }),
      addMessage: async (m: { role: string }) => {
        added.push(m)
        return { id: 'msg-1' }
      },
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    // thread_created maps CODEX_UUID -> db-1 so steer can resolve it later.
    const backend = makeSteerableBackend([
      { type: 'thread_created', threadId: CODEX_UUID },
      { type: 'turn_completed', threadId: CODEX_UUID, turnId: 'turn-1' },
    ])

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: () => {},
      backend,
    })

    const first = await mgr.sendMessage({ content: 'start', attachments: [] })
    await flushMicrotasks()

    const result = await mgr.steer({ threadId: first.threadId, content: 'actually, do X', attachments: [] })

    expect(backend.steerCalls).toHaveLength(1)
    expect(backend.steerCalls[0].threadId).toBe(CODEX_UUID)
    // The steered text rides through as a plain text input item.
    const textItem = backend.steerCalls[0].input.items.find((i) => i.type === 'text') as
      | { type: 'text'; text: string }
      | undefined
    expect(textItem?.text).toContain('actually, do X')
    // The interjection is persisted as a user message row.
    expect(added.some((m) => m.role === 'user')).toBe(true)
    expect(result.threadId).toBe(first.threadId)
  })

  it('is a no-op (no backend.steer) when called without a threadId', async () => {
    const backend = makeSteerableBackend([])
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: { ...persistStubs, createThread: async () => ({ id: 'db-x' }) } as any,
      attachments: { ingest: async () => [] } as any,
      eventSink: () => {},
      backend,
    })

    const result = await mgr.steer({ content: 'orphan', attachments: [] })

    expect(backend.steerCalls).toHaveLength(0)
    expect(result.threadId).toBe('pending')
  })

  it('emits an error event when the backend does not support steering', async () => {
    const events: AgentStreamEvent[] = []
    // A backend WITHOUT a steer method (optional on IAgentBackend).
    const backend = {
      async start() {},
      async stop() {},
      isHealthy() { return true },
      async cancel() {},
      async *send() {},
    } as unknown as IAgentBackend

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: { ...persistStubs, createThread: async () => ({ id: 'db-y' }) } as any,
      attachments: { ingest: async () => [] } as any,
      eventSink: (e) => events.push(e),
      backend,
    })

    const result = await mgr.steer({ threadId: 'db-y', content: 'hi', attachments: [] })

    expect(result.threadId).toBe('db-y')
    expect(events.some((e) => e.type === 'error')).toBe(true)
  })
})

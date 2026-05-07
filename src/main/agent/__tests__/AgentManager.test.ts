import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentManager } from '../AgentManager'
import type { AgentInput, IAgentBackend } from '../types'
import type { AgentStreamEvent } from '../../../types/agent'

interface BackendCall {
  threadId: string | undefined
  input: AgentInput
}

function makeStubBackend(
  scriptPerCall: Array<AgentStreamEvent[]>,
): IAgentBackend & { calls: BackendCall[]; cancelCalls: string[] } {
  const calls: BackendCall[] = []
  const cancelCalls: string[] = []
  const backend = {
    calls,
    cancelCalls,
    async start() {},
    async stop() {},
    isHealthy() { return true },
    async cancel(threadId: string) { cancelCalls.push(threadId) },
    async *send(threadId: string | undefined, input: AgentInput) {
      const idx = calls.length
      calls.push({ threadId, input })
      const events = scriptPerCall[idx] ?? []
      for (const e of events) yield e
    },
  } satisfies IAgentBackend & { calls: BackendCall[]; cancelCalls: string[] }
  return backend
}

function flushMicrotasks(times = 5): Promise<void> {
  let p: Promise<void> = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => undefined)
  return p
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-mgr-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('AgentManager codex api key', () => {
  it('returns empty string when codex-agent.json is absent', () => {
    const mgr = new AgentManager({ userDataDir: tmpDir })
    expect(mgr.getCodexApiKey()).toBe('')
  })

  it('loads codex api key from disk on construction', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'codex-agent.json'),
      JSON.stringify({ openaiApiKey: 'sk-stored' }),
      'utf8',
    )
    const mgr = new AgentManager({ userDataDir: tmpDir })
    expect(mgr.getCodexApiKey()).toBe('sk-stored')
  })

  it('returns empty string when codex-agent.json is malformed', async () => {
    await fs.writeFile(path.join(tmpDir, 'codex-agent.json'), 'not json {{{', 'utf8')
    const mgr = new AgentManager({ userDataDir: tmpDir })
    expect(mgr.getCodexApiKey()).toBe('')
  })

  it('returns empty string when codex-agent.json has no openaiApiKey field', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'codex-agent.json'),
      JSON.stringify({ other: 'value' }),
      'utf8',
    )
    const mgr = new AgentManager({ userDataDir: tmpDir })
    expect(mgr.getCodexApiKey()).toBe('')
  })

  it('setCodexApiKey atomically writes to disk and updates the cache', async () => {
    const mgr = new AgentManager({ userDataDir: tmpDir })
    await mgr.setCodexApiKey('  sk-new  ')

    expect(mgr.getCodexApiKey()).toBe('sk-new')

    const onDisk = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'codex-agent.json'), 'utf8'),
    )
    expect(onDisk.openaiApiKey).toBe('sk-new')

    const entries = await fs.readdir(tmpDir)
    expect(entries).not.toContain('codex-agent.json.tmp')
  })

  it('a second AgentManager construction reads back what setCodexApiKey wrote', async () => {
    const writer = new AgentManager({ userDataDir: tmpDir })
    await writer.setCodexApiKey('sk-persist')

    const reader = new AgentManager({ userDataDir: tmpDir })
    expect(reader.getCodexApiKey()).toBe('sk-persist')
  })
})

describe('AgentManager sendMessage empty-key gate', () => {
  it('emits error event and does not start backend when sendMessage called with empty key', async () => {
    const events: AgentStreamEvent[] = []
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      eventSink: (event) => events.push(event),
    })

    const result = await mgr.sendMessage({
      threadId: 't1',
      content: 'hi',
      attachments: [],
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'error',
      threadId: 't1',
      error: '请在设置页填写 Codex Agent API Key',
    })
    expect(result.threadId).toBe('t1')
  })

  it('uses a placeholder threadId when sendMessage called without threadId and key is empty', async () => {
    const events: AgentStreamEvent[] = []
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      eventSink: (event) => events.push(event),
    })

    await mgr.sendMessage({ content: 'hi', attachments: [] })

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('error')
    expect(events[0]?.error).toBe('请在设置页填写 Codex Agent API Key')
    expect(typeof events[0]?.threadId).toBe('string')
    expect(events[0]?.threadId.length).toBeGreaterThan(0)
  })

  it('does not invoke store/attachments when key is empty', async () => {
    let createCalls = 0
    let ingestCalls = 0
    const fakeStore = {
      createThread: async () => {
        createCalls += 1
        return { id: 'should-not-happen' }
      },
    } as any
    const fakeAttachments = {
      ingest: async () => {
        ingestCalls += 1
        return []
      },
    } as any

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: () => {},
    })

    await mgr.sendMessage({ threadId: 't-empty', content: 'hi', attachments: [] })

    expect(createCalls).toBe(0)
    expect(ingestCalls).toBe(0)
  })
})

describe('AgentManager codex thread id mapping (regression: invalid thread id)', () => {
  // Codex's app-server requires that thread ids passed to turn/start are UUIDs
  // it itself generated via thread/start. Our DB row ids are CUIDs and must
  // never leak into the wire protocol. AgentManager is responsible for the
  // translation in both directions.
  const CODEX_UUID = '11111111-2222-3333-4444-555555555555'

  beforeEach(async () => {
    await fs.writeFile(
      path.join(tmpDir, 'codex-agent.json'),
      JSON.stringify({ openaiApiKey: 'sk-test' }),
      'utf8',
    )
  })

  it('passes undefined to backend.send on first turn (lets backend create codex thread)', async () => {
    const events: AgentStreamEvent[] = []
    const fakeStore = {
      createThread: async () => ({ id: 'cm-db-id-1' }),
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't1' },
      ],
    ])

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: (e) => events.push(e),
      backend,
    })

    await mgr.sendMessage({ content: 'hi', attachments: [] })
    await flushMicrotasks(20)

    expect(backend.calls).toHaveLength(1)
    expect(backend.calls[0].threadId).toBeUndefined()
  })

  it('rewrites event.threadId from codex UUID to DB cuid before forwarding to renderer', async () => {
    const events: AgentStreamEvent[] = []
    const fakeStore = {
      createThread: async () => ({ id: 'cm-db-id-2' }),
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        { type: 'message_delta', threadId: CODEX_UUID, turnId: 't1', delta: 'hello' },
        { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't1' },
      ],
    ])

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: (e) => events.push(e),
      backend,
    })

    await mgr.sendMessage({ content: 'hi', attachments: [] })
    await flushMicrotasks(20)

    expect(events).toHaveLength(3)
    for (const e of events) expect(e.threadId).toBe('cm-db-id-2')
  })

  it('on a second sendMessage with same DB threadId, passes the cached codex UUID to backend.send', async () => {
    const events: AgentStreamEvent[] = []
    const fakeStore = {
      createThread: async () => ({ id: 'cm-db-id-3' }),
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't1' },
      ],
      [{ type: 'turn_completed', threadId: CODEX_UUID, turnId: 't2' }],
    ])

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: (e) => events.push(e),
      backend,
    })

    const r1 = await mgr.sendMessage({ content: 'first', attachments: [] })
    await flushMicrotasks(20)
    expect(r1.threadId).toBe('cm-db-id-3')
    expect(backend.calls[0].threadId).toBeUndefined()

    await mgr.sendMessage({ threadId: 'cm-db-id-3', content: 'second', attachments: [] })
    await flushMicrotasks(20)

    expect(backend.calls).toHaveLength(2)
    expect(backend.calls[1].threadId).toBe(CODEX_UUID)
  })

  it('forwards payload.model through to backend.send when caller selects a model', async () => {
    const fakeStore = {
      createThread: async (args: { model: string }) => ({ id: 'cm-db-id-5', _model: args.model }),
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't1' },
      ],
    ])
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: () => {},
      backend,
    })

    await mgr.sendMessage({ content: 'hi', attachments: [], model: 'o3-pro' })
    await flushMicrotasks(20)

    expect(backend.calls).toHaveLength(1)
    expect(backend.calls[0].input.model).toBe('o3-pro')
  })

  it('falls back to default model when payload omits model', async () => {
    const fakeStore = { createThread: async () => ({ id: 'cm-db-id-6' }) } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't1' },
      ],
    ])
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: () => {},
      backend,
    })

    await mgr.sendMessage({ content: 'hi', attachments: [] })
    await flushMicrotasks(20)

    expect(backend.calls[0].input.model).toBe('gpt-4.1-mini')
  })

  it('cancel(dbThreadId) translates to backend.cancel(codexThreadId) when mapping exists', async () => {
    const fakeStore = {
      createThread: async () => ({ id: 'cm-db-id-4' }),
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't1' },
      ],
    ])

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: () => {},
      backend,
    })

    await mgr.sendMessage({ content: 'first', attachments: [] })
    await flushMicrotasks(20)

    await mgr.cancel('cm-db-id-4')
    expect(backend.cancelCalls).toEqual([CODEX_UUID])
  })
})

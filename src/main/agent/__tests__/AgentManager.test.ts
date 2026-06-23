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
  scriptPerCall: Array<AgentStreamEvent[] | Error>,
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
      if (events instanceof Error) throw events
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
  it('reports maximum-permission Codex defaults in session status', () => {
    const mgr = new AgentManager({ userDataDir: tmpDir })

    expect(mgr.getSessionStatus()).toMatchObject({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      webSearch: 'live',
      writableRoots: [],
    })
  })

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

  // v4.3 moved Codex API key persistence from `codex-agent.json` (single key)
  // to `codex-providers.json` (per-provider keys, custom providers list, and
  // the active provider id). `setCodexApiKey` is now a thin alias that sets
  // the API key for the currently-active provider, so both layouts (legacy
  // file present, and the new file written by setCodexApiKey) need to round-
  // trip through getCodexApiKey().
  it('setCodexApiKey atomically writes to disk and updates the cache', async () => {
    const mgr = new AgentManager({ userDataDir: tmpDir })
    await mgr.setCodexApiKey('  sk-new  ')

    expect(mgr.getCodexApiKey()).toBe('sk-new')

    const onDisk = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'codex-providers.json'), 'utf8'),
    )
    // Default active provider is `apiyi` — see codexProviders.ts.
    expect(onDisk.apiKeys.apiyi).toBe('sk-new')
    expect(onDisk.selectedProviderId).toBe('apiyi')

    const entries = await fs.readdir(tmpDir)
    expect(entries.some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('a second AgentManager construction reads back what setCodexApiKey wrote', async () => {
    const writer = new AgentManager({ userDataDir: tmpDir })
    await writer.setCodexApiKey('sk-persist')

    const reader = new AgentManager({ userDataDir: tmpDir })
    expect(reader.getCodexApiKey()).toBe('sk-persist')
  })
})

// Regression — a v4.3.0-rc shipped with `provider: DEFAULT_PROVIDER` (an
// undefined identifier left over from the pre-multi-provider refactor) inside
// testConnection. The IPC call surfaced as `ReferenceError: DEFAULT_PROVIDER
// is not defined`, blocking the "测试 Codex 连接" button entirely. These
// tests pin testConnection to the *currently active* provider and exercise
// both the empty-key short-circuit and the resolution path.
describe('AgentManager testConnection provider resolution', () => {
  it('returns the "please fill in API key" error and never references DEFAULT_PROVIDER when key is empty', async () => {
    const mgr = new AgentManager({ userDataDir: tmpDir })
    const result = await mgr.testConnection()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/API Key/i)
    // The bug we are guarding against is a ReferenceError at module evaluation
    // time. If testConnection threw, vitest would surface it instead of the
    // structured error object above, so reaching this line proves the fix.
  })

  it('uses the currently selected provider for the probe backend (not a hard-coded default)', async () => {
    // Stub backend bypasses the real CodexLocalBackend constructor and its
    // restartCodex hook so we can swap active providers freely. testConnection
    // ignores opts.backend and builds its own fresh CodexLocalBackend, which
    // is exactly the path we want to exercise.
    const stub = makeStubBackend([])
    const mgr = new AgentManager({ userDataDir: tmpDir, backend: stub })

    // Provision a key for rightcode before switching, so testConnection's
    // empty-key short-circuit doesn't fire after the swap.
    await mgr.setProviderApiKey('rightcode', 'sk-rightcode')
    await mgr.setActiveProvider('rightcode')
    expect(mgr.getCodexApiKey()).toBe('sk-rightcode')

    // Monkey-patch CodexLocalBackend.prototype.start so the test isolates the
    // constructor + provider plumbing without spawning an actual Codex
    // process. testConnection wraps `backend.start()` in try/catch and
    // returns { ok: false, error: msg }, so we get a clean assertion target.
    const { CodexLocalBackend } = await import('../CodexLocalBackend')
    const realStart = CodexLocalBackend.prototype.start
    const sentinel = new Error('STOP-PROBE')
    CodexLocalBackend.prototype.start = async function () {
      ;(globalThis as Record<string, unknown>).__capturedProvider = (
        this as unknown as { currentProvider?: { id?: string } }
      ).currentProvider
      throw sentinel
    }
    try {
      const result = await mgr.testConnection()
      expect(result.ok).toBe(false)
      expect(result.error).toBe('STOP-PROBE')
      const captured = (globalThis as Record<string, unknown>).__capturedProvider as
        | { id?: string }
        | undefined
      expect(captured?.id).toBe('rightcode')
    } finally {
      CodexLocalBackend.prototype.start = realStart
      delete (globalThis as Record<string, unknown>).__capturedProvider
    }
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

  // Shared no-op persistence hooks. Real flow requires addMessage +
  // updateLastMessageAt to exist on the store; tests that don't care about
  // persistence still need them defined to avoid "is not a function" crashes.
  const persistStubs = {
    addMessage: async () => ({ id: 'msg-stub' }),
    updateLastMessageAt: async () => undefined,
  }

  it('passes undefined to backend.send on first turn (lets backend create codex thread)', async () => {
    const events: AgentStreamEvent[] = []
    const fakeStore = {
      ...persistStubs,
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
      ...persistStubs,
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
      ...persistStubs,
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

  it('retries on a new Codex thread when cached thread encryption is rejected', async () => {
    const events: AgentStreamEvent[] = []
    const fakeStore = {
      ...persistStubs,
      createThread: async () => ({ id: 'cm-db-id-recover' }),
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const recoveredUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't1' },
      ],
      new Error('{"error":{"code":"invalid_encrypted_content","message":"encrypted content could not be decrypted"}}'),
      [
        { type: 'thread_created', threadId: recoveredUuid },
        { type: 'turn_completed', threadId: recoveredUuid, turnId: 't2' },
      ],
    ])

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: (e) => events.push(e),
      backend,
    })

    await mgr.sendMessage({ content: 'first', attachments: [] })
    await flushMicrotasks(20)
    await mgr.sendMessage({ threadId: 'cm-db-id-recover', content: 'second', attachments: [] })
    await flushMicrotasks(30)

    expect(backend.calls).toHaveLength(3)
    expect(backend.calls[1].threadId).toBe(CODEX_UUID)
    expect(backend.calls[2].threadId).toBeUndefined()
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0)
  })

  it('retries when encrypted content rejection arrives as a streamed error event', async () => {
    const events: AgentStreamEvent[] = []
    const fakeStore = {
      ...persistStubs,
      createThread: async () => ({ id: 'cm-db-id-stream-error' }),
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const recoveredUuid = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        {
          type: 'error',
          threadId: CODEX_UUID,
          turnId: 't1',
          error: '{"error":{"code":"invalid_encrypted_content","message":"encrypted content could not be decrypted"}}',
        },
      ],
      [
        { type: 'thread_created', threadId: recoveredUuid },
        { type: 'turn_completed', threadId: recoveredUuid, turnId: 't2' },
      ],
    ])

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: (e) => events.push(e),
      backend,
    })

    await mgr.sendMessage({ content: 'first', attachments: [] })
    await flushMicrotasks(30)

    expect(backend.calls).toHaveLength(2)
    expect(backend.calls[0].threadId).toBeUndefined()
    expect(backend.calls[1].threadId).toBeUndefined()
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0)
    expect(events).toContainEqual({ type: 'turn_completed', threadId: 'cm-db-id-stream-error', turnId: 't2' })
  })

  it('retries on the "missing recognized prefix" encrypted-content variant (apiyi validation_error)', async () => {
    // Live repro 2026-06-11: apiyi's Responses emulation rejects replayed
    // reasoning blocks whose encrypted_content it didn't mint itself with
    //   {"error":{"message":"encrypted content missing recognized prefix
    //    (expected `rsn_` or `smry_`)","type":"invalid_request_error",
    //    "code":"validation_error"}}
    // — different code AND different wording from the two variants the
    // matcher knew, so the self-heal never fired and the raw JSON rendered
    // in chat. The poisoned thread must be retried on a FRESH codex thread.
    const events: AgentStreamEvent[] = []
    const fakeStore = {
      ...persistStubs,
      createThread: async () => ({ id: 'cm-db-id-prefix-error' }),
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const recoveredUuid = 'cccccccc-dddd-eeee-ffff-000000000000'
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        {
          type: 'error',
          threadId: CODEX_UUID,
          turnId: 't1',
          error:
            '{"error":{"message":"encrypted content missing recognized prefix (expected `rsn_` or `smry_`)","localized_message":"Unknown error","type":"invalid_request_error","param":"","code":"validation_error"}}',
        },
      ],
      [
        { type: 'thread_created', threadId: recoveredUuid },
        { type: 'turn_completed', threadId: recoveredUuid, turnId: 't2' },
      ],
    ])

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: (e) => events.push(e),
      backend,
    })

    await mgr.sendMessage({ content: 'first', attachments: [] })
    await flushMicrotasks(30)

    expect(backend.calls).toHaveLength(2)
    expect(backend.calls[1].threadId).toBeUndefined()
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0)
    expect(events).toContainEqual({ type: 'turn_completed', threadId: 'cm-db-id-prefix-error', turnId: 't2' })
  })

  it('retries on a fresh thread when the gateway rejects with request_too_large (oversized replayed history)', async () => {
    // Live repro 2026-06-11: a 5-image view_image batch ballooned the replayed
    // history past apiyi's request-body byte cap. EVERY subsequent turn on
    // that codex thread re-sends the same oversized history → the thread is
    // permanently wedged ("卡住了之后不能继续对话") — openai/codex#11440
    // documents the dead-end and ships no client-side fix. Our escape hatch:
    // drop the poisoned codex thread mapping and re-send the CURRENT message
    // on a fresh thread (small request → succeeds; codex-side memory of the
    // old turns is lost, surfaced to the user via a notice).
    const events: AgentStreamEvent[] = []
    const fakeStore = {
      ...persistStubs,
      createThread: async () => ({ id: 'cm-db-id-too-large' }),
    } as any
    const fakeAttachments = { ingest: async () => [] } as any
    const recoveredUuid = 'dddddddd-eeee-ffff-0000-111111111111'
    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        {
          type: 'error',
          threadId: CODEX_UUID,
          turnId: 't1',
          error:
            '{"error":{"message":"Request exceeds the maximum allowed size","localized_message":"Unknown error","type":"invalid_request_error","param":"","code":"request_too_large"}}',
        },
      ],
      [
        { type: 'thread_created', threadId: recoveredUuid },
        { type: 'turn_completed', threadId: recoveredUuid, turnId: 't2' },
      ],
    ])

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: (e) => events.push(e),
      backend,
    })

    await mgr.sendMessage({ content: 'first', attachments: [] })
    await flushMicrotasks(30)

    expect(backend.calls).toHaveLength(2)
    expect(backend.calls[1].threadId).toBeUndefined()
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0)
    expect(events).toContainEqual({ type: 'turn_completed', threadId: 'cm-db-id-too-large', turnId: 't2' })
    // The user must learn that codex-side memory was reset.
    const notices = events.filter(
      (e): e is Extract<AgentStreamEvent, { type: 'notice' }> => e.type === 'notice',
    )
    expect(notices.some((n) => n.notice.kind === 'threadContextReset')).toBe(true)
  })

  it('forwards payload.model through to backend.send when caller selects a model', async () => {
    const fakeStore = {
      ...persistStubs,
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
    const fakeStore = { ...persistStubs, createThread: async () => ({ id: 'cm-db-id-6' }) } as any
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

    expect(backend.calls[0].input.model).toBe('gpt-5.5')
  })

  it('persists user message immediately and assistant message on turn_completed (regression: empty thread history)', async () => {
    // Before this test was added, AgentManager.forwardEvents only forwarded
    // stream events to the renderer and never called store.addMessage. That
    // meant: (a) restarting the app showed no chat history because
    // AgentMessage rows didn't exist, and (b) ThreadTitleSummarizer's
    // `messages.length < 2` gate always tripped so threads kept the
    // 40-char content fallback as their title.
    const addMessageCalls: Array<{ threadId: string; role: string; items: unknown }> = []
    const lastMessageAtCalls: string[] = []
    const fakeStore = {
      createThread: async () => ({ id: 'cm-persist-1' }),
      addMessage: async (args: { threadId: string; role: string; items: unknown }) => {
        addMessageCalls.push(args)
        return { id: `m-${addMessageCalls.length}` }
      },
      updateLastMessageAt: async (threadId: string) => {
        lastMessageAtCalls.push(threadId)
      },
    } as any
    const fakeAttachments = { ingest: async () => [] } as any

    const backend = makeStubBackend([
      [
        { type: 'thread_created', threadId: CODEX_UUID },
        { type: 'item_started', threadId: CODEX_UUID, turnId: 't1', itemId: 'a-1', itemType: 'text', payload: {} },
        { type: 'item_delta', threadId: CODEX_UUID, turnId: 't1', itemId: 'a-1', itemType: 'text',
          patch: { kind: 'appendText', field: 'content', text: 'hello ' } },
        { type: 'item_delta', threadId: CODEX_UUID, turnId: 't1', itemId: 'a-1', itemType: 'text',
          patch: { kind: 'appendText', field: 'content', text: 'world' } },
        { type: 'item_completed', threadId: CODEX_UUID, turnId: 't1', itemId: 'a-1', itemType: 'text', final: {} },
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

    await mgr.sendMessage({ content: 'hi there', attachments: [] })
    await flushMicrotasks(40)

    // First addMessage = the user turn (synchronous part of sendMessage).
    expect(addMessageCalls.length).toBeGreaterThanOrEqual(2)
    const userCall = addMessageCalls[0]
    expect(userCall).toMatchObject({ threadId: 'cm-persist-1', role: 'user' })
    expect(Array.isArray(userCall.items)).toBe(true)
    const userItems = userCall.items as Array<{ type: string; content?: string }>
    expect(userItems.find((i) => i.type === 'text')).toMatchObject({ type: 'text', content: 'hi there' })

    // Second addMessage = the assistant turn (accumulated from streamed deltas
    // and flushed on turn_completed).
    const asstCall = addMessageCalls[1]
    expect(asstCall).toMatchObject({ threadId: 'cm-persist-1', role: 'assistant' })
    const asstItems = asstCall.items as Array<{ type: string; content?: string; endedAt?: number }>
    const asstText = asstItems.find((i) => i.type === 'text')
    expect(asstText?.content).toBe('hello world')
    expect(asstText?.endedAt).toBeGreaterThan(0)

    // updateLastMessageAt should be bumped after each persisted message.
    expect(lastMessageAtCalls).toEqual(['cm-persist-1', 'cm-persist-1'])
  })

  it('persists assistant turn even when there is no streamed text item', async () => {
    // Tool-only or empty turns: the assistant accumulator may be empty after
    // streaming. We must NOT write a zero-item AgentMessage row, otherwise
    // the timeline shows a phantom blank assistant bubble after restart.
    const addMessageCalls: Array<{ role: string }> = []
    const fakeStore = {
      createThread: async () => ({ id: 'cm-persist-2' }),
      addMessage: async (args: { threadId: string; role: string; items: unknown }) => {
        addMessageCalls.push(args)
        return { id: 'm-x' }
      },
      updateLastMessageAt: async () => undefined,
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

    await mgr.sendMessage({ content: 'hi', attachments: [] })
    await flushMicrotasks(40)

    // Exactly one addMessage call (the user one). No assistant row.
    expect(addMessageCalls.map((c) => c.role)).toEqual(['user'])
  })

  // The user uploads files via the renderer file picker, which only gives us
  // a buffer (no real path on disk visible to the agent). AttachmentService
  // writes that buffer to `userData/agent/uploads/<sha>.<ext>` and returns
  // an AgentAttachment row with `localPath`. Pre-fix `sendMessage` only
  // forwarded `localImage` items to the backend AND never told the agent
  // those paths in the prompt — so when the user asked "where is this
  // file?" the agent had to guess (and guessed `C:\Program Files\...`,
  // wasting tokens on shell tries). Fix: prepend a one-shot "[Attached
  // files at these local paths:]" block to the text item we send to the
  // backend, listing every uploaded file's localPath, original name, mime,
  // and size. This is the ONLY place the agent learns about non-image
  // attachments — they are never sent as protocol items.
  it('injects the localPath of every attachment (image AND non-image) into the prompt sent to the backend', async () => {
    const fakeStore = {
      ...persistStubs,
      createThread: async () => ({ id: 'cm-db-id-att' }),
    } as any
    const fakeAttachments = {
      ingest: async () => [
        {
          id: 'att-1',
          threadId: 'cm-db-id-att',
          originalName: 'photo.png',
          localPath: 'C:/uploads/abc.png',
          mime: 'image/png',
          size: 1234,
          uploadedAt: new Date(),
        },
        {
          id: 'att-2',
          threadId: 'cm-db-id-att',
          originalName: 'notes.txt',
          localPath: 'C:/uploads/def.txt',
          mime: 'text/plain',
          size: 5678,
          uploadedAt: new Date(),
        },
      ],
    } as any
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

    await mgr.sendMessage({
      content: '这个文件地址在哪里',
      attachments: [
        { name: 'photo.png', mime: 'image/png', buffer: new Uint8Array([1, 2, 3]).buffer },
        { name: 'notes.txt', mime: 'text/plain', buffer: new Uint8Array([4, 5, 6]).buffer },
      ],
    })
    await flushMicrotasks(20)

    expect(backend.calls).toHaveLength(1)
    const items = backend.calls[0].input.items
    const textItem = items.find((i) => i.type === 'text') as { type: 'text'; text: string }
    expect(textItem).toBeDefined()
    // The agent must see BOTH paths verbatim — that's the whole point.
    expect(textItem.text).toContain('C:/uploads/abc.png')
    expect(textItem.text).toContain('C:/uploads/def.txt')
    // Original filename should be there too so the agent can refer to files
    // by the user-meaningful name when responding.
    expect(textItem.text).toContain('photo.png')
    expect(textItem.text).toContain('notes.txt')
    // The original user prompt must still be present (we wrap it, not
    // replace it).
    expect(textItem.text).toContain('这个文件地址在哪里')
    // Image still travels as a localImage protocol item so the model can
    // actually see its pixels (text-prompt path-only is not enough for
    // images). Non-images do NOT — they live only in the preamble.
    const localImagePaths = items
      .filter((i): i is Extract<typeof i, { type: 'localImage' }> => i.type === 'localImage')
      .map((i) => i.path)
    expect(localImagePaths).toEqual(['C:/uploads/abc.png'])
  })

  it('does not add an attachments preamble when there are no attachments', async () => {
    const fakeStore = {
      ...persistStubs,
      createThread: async () => ({ id: 'cm-db-id-noatt' }),
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

    await mgr.sendMessage({ content: 'plain question', attachments: [] })
    await flushMicrotasks(20)

    const textItem = backend.calls[0].input.items.find((i) => i.type === 'text') as {
      type: 'text'
      text: string
    }
    // Without attachments we keep the user's prompt EXACTLY as typed — no
    // surprise preamble bytes inflating their input tokens.
    expect(textItem.text).toBe('plain question')
  })

  it('cancel(dbThreadId) translates to backend.cancel(codexThreadId) when mapping exists', async () => {
    const fakeStore = {
      ...persistStubs,
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

  // Regression: a swallowed bootstrap start() failure left the backend client
  // null, so the first send threw the opaque "CodexLocalBackend.send called
  // before start". sendMessage now (re)starts lazily and surfaces the REAL
  // startup error as a normal error event, keeping the turn recoverable.
  it('surfaces the real backend startup error as an error event instead of the cryptic "called before start"', async () => {
    const events: AgentStreamEvent[] = []
    const fakeStore = { ...persistStubs, createThread: async () => ({ id: 'cm-db-id-startfail' }) } as any
    const fakeAttachments = { ingest: async () => [] } as any
    let sendCalled = false
    const backend: IAgentBackend = {
      async start() {
        throw new Error('`wire_api = "chat"` is no longer supported')
      },
      async stop() {},
      isHealthy() { return false },
      async cancel() {},
      async *send() { sendCalled = true },
    }
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: (e) => events.push(e),
      backend,
    })

    await mgr.sendMessage({ content: 'hi', attachments: [] })
    await flushMicrotasks(20)

    expect(sendCalled).toBe(false)
    const err = events.find((e) => e.type === 'error') as
      | Extract<AgentStreamEvent, { type: 'error' }>
      | undefined
    expect(err).toBeTruthy()
    expect(err?.error).toContain('wire_api = "chat"')
  })

  it('lazily starts an unhealthy backend on send and dedupes concurrent starts', async () => {
    const events: AgentStreamEvent[] = []
    const fakeStore = { ...persistStubs, createThread: async () => ({ id: 'cm-db-id-lazy' }) } as any
    const fakeAttachments = { ingest: async () => [] } as any
    let startCount = 0
    let healthy = false
    const backend: IAgentBackend = {
      async start() {
        startCount += 1
        await Promise.resolve()
        healthy = true
      },
      async stop() {},
      isHealthy() { return healthy },
      async cancel() {},
      async *send() {
        yield { type: 'thread_created', threadId: CODEX_UUID }
        yield { type: 'turn_completed', threadId: CODEX_UUID, turnId: 't1' }
      },
    }
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: (e) => events.push(e),
      backend,
    })

    await Promise.all([
      mgr.sendMessage({ content: 'a', attachments: [] }),
      mgr.sendMessage({ content: 'b', attachments: [] }),
    ])
    await flushMicrotasks(20)

    expect(startCount).toBe(1)
  })
})

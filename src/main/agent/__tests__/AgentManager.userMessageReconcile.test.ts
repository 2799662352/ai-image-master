/**
 * Read-side reconcile loop: when the backend stream carries the internal
 * `user_message_reconciled` event (the rollout's canonical userMessage echo),
 * AgentManager must
 *   1. fold the reconcile block onto our persisted user AgentMessage row
 *      (located by `clientId` = the row id we sent as clientUserMessageId),
 *   2. NEVER forward the event to the renderer (the local user bubble already
 *      exists — forwarding would duplicate the message), and
 *   3. skip silently when clientId is missing or the store lacks the hook
 *      (reconcile is an enhancement, not a critical path).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentManager } from '../AgentManager'
import type { AgentInput, IAgentBackend } from '../types'
import type { AgentStreamEvent, CodexUserMessageReconcile } from '../../../types/agent'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-umr-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const RECONCILE: CodexUserMessageReconcile = {
  codexItemId: 'item-1',
  clientId: 'msg_row_9',
  localImages: ['C:/uploads/a.png'],
  textElements: [{ byteRange: { start: 0, end: 4 }, placeholder: 'Foo' }],
}

function makeBackend(events: AgentStreamEvent[]): IAgentBackend {
  return {
    async start() { },
    async stop() { },
    isHealthy() { return true },
    async cancel() { },
    async *send(_threadId: string | undefined, _input: AgentInput): AsyncIterable<AgentStreamEvent> {
      for (const event of events) yield event
    },
  }
}

function makeManager(opts: {
  backend: IAgentBackend
  attachCalls?: Array<{ messageId: string; reconcile: unknown }>
  withAttachHook?: boolean
  sinkEvents: AgentStreamEvent[]
}): AgentManager {
  const store: Record<string, unknown> = {
    createThread: async () => ({ id: 'thread-1' }),
    addMessage: async () => ({ id: 'msg_row_9' }),
    updateLastMessageAt: async () => undefined,
  }
  if (opts.withAttachHook !== false) {
    store.attachCodexReconcile = async (messageId: string, reconcile: unknown) => {
      opts.attachCalls?.push({ messageId, reconcile })
    }
  }
  return new AgentManager({
    userDataDir: tmpDir,
    backend: opts.backend,
    store: store as never,
    attachments: { ingest: async () => [] } as never,
    eventSink: (event) => opts.sinkEvents.push(event),
  })
}

async function settle(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

describe('AgentManager userMessage reconcile', () => {
  it('folds the reconcile block onto the persisted row and hides the event from the renderer', async () => {
    const attachCalls: Array<{ messageId: string; reconcile: unknown }> = []
    const sinkEvents: AgentStreamEvent[] = []
    const backend = makeBackend([
      { type: 'thread_created', threadId: 'codex-t' },
      { type: 'user_message_reconciled', threadId: 'codex-t', reconcile: RECONCILE },
      { type: 'turn_completed', threadId: 'codex-t' },
    ])
    const mgr = makeManager({ backend, attachCalls, sinkEvents })
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({ content: 'hello', attachments: [] })
    await settle()

    expect(attachCalls).toEqual([{ messageId: 'msg_row_9', reconcile: RECONCILE }])
    expect(sinkEvents.map((e) => e.type)).not.toContain('user_message_reconciled')
    // The rest of the stream still flows to the renderer.
    expect(sinkEvents.map((e) => e.type)).toContain('turn_completed')
  })

  it('skips silently when the echo has no clientId', async () => {
    const attachCalls: Array<{ messageId: string; reconcile: unknown }> = []
    const sinkEvents: AgentStreamEvent[] = []
    const backend = makeBackend([
      {
        type: 'user_message_reconciled',
        threadId: 'codex-t',
        reconcile: { codexItemId: 'item-1', localImages: [], textElements: [] },
      },
      { type: 'turn_completed', threadId: 'codex-t' },
    ])
    const mgr = makeManager({ backend, attachCalls, sinkEvents })
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({ content: 'hello', attachments: [] })
    await settle()

    expect(attachCalls).toEqual([])
    expect(sinkEvents.map((e) => e.type)).not.toContain('user_message_reconciled')
  })

  it('survives a store without the attach hook (older store shims)', async () => {
    const sinkEvents: AgentStreamEvent[] = []
    const backend = makeBackend([
      { type: 'user_message_reconciled', threadId: 'codex-t', reconcile: RECONCILE },
      { type: 'turn_completed', threadId: 'codex-t' },
    ])
    const mgr = makeManager({ backend, withAttachHook: false, sinkEvents })
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({ content: 'hello', attachments: [] })
    await settle()

    expect(sinkEvents.map((e) => e.type)).toContain('turn_completed')
    expect(sinkEvents.map((e) => e.type)).not.toContain('user_message_reconciled')
  })
})

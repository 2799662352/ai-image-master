/**
 * AgentManager → clientUserMessageId wiring: the persisted user AgentMessage
 * row id must ride the AgentInput so CodexProtocolClient forwards it on
 * `turn/start` / `turn/steer` (app-server v2 echoes it as `clientId` on the
 * rollout's userMessage item — our DB rows become reconcilable 1:1 with
 * codex-native history).
 */
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

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cumid-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeBackend(): IAgentBackend & { calls: BackendCall[] } {
  const calls: BackendCall[] = []
  return {
    calls,
    async start() { },
    async stop() { },
    isHealthy() { return true },
    async cancel() { },
    async *send(threadId: string | undefined, input: AgentInput): AsyncIterable<AgentStreamEvent> {
      calls.push({ threadId, input })
    },
  }
}

function makeManager(backend: IAgentBackend, addMessageResult: { id: string } | undefined): AgentManager {
  return new AgentManager({
    userDataDir: tmpDir,
    backend,
    store: {
      createThread: async () => ({ id: 'thread-1' }),
      addMessage: async () => addMessageResult,
      updateLastMessageAt: async () => undefined,
    } as any,
    attachments: { ingest: async () => [] } as any,
  })
}

function flushMicrotasks(times = 5): Promise<void> {
  let p = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => undefined)
  return p
}

describe('AgentManager clientUserMessageId', () => {
  it('forwards the persisted user message row id as input.clientUserMessageId', async () => {
    const backend = makeBackend()
    const mgr = makeManager(backend, { id: 'msg_row_9' })
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({ content: 'hello', attachments: [] })
    await flushMicrotasks()

    expect(backend.calls).toHaveLength(1)
    expect(backend.calls[0].input.clientUserMessageId).toBe('msg_row_9')
  })

  it('omits clientUserMessageId when the store returns no row (degraded no-DB path)', async () => {
    const backend = makeBackend()
    const mgr = makeManager(backend, undefined)
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({ content: 'hello', attachments: [] })
    await flushMicrotasks()

    expect(backend.calls[0].input.clientUserMessageId).toBeUndefined()
  })
})

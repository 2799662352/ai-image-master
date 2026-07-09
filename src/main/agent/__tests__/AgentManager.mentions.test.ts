/**
 * AgentManager mention forwarding — codex app-server `@plugin` / `$app`
 * mention protocol (README "Invoke a plugin"):
 *
 *   input: [
 *     { "type": "text", "text": "@sample Summarize the latest updates." },
 *     { "type": "mention", "name": "Sample Plugin", "path": "plugin://sample@test" }
 *   ]
 *
 * The renderer resolves `@token`s against `plugin/installed` and forwards
 * `payload.mentions = [{ name, path }]`; the manager must attach one
 * `mention` input item per unique path (mirrors the `skills` dedupe so a
 * doubled `@foo @foo` doesn't invoke the plugin twice).
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-mention-input-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeBackend(): IAgentBackend & { calls: BackendCall[] } {
  const calls: BackendCall[] = []
  return {
    calls,
    async start() {},
    async stop() {},
    isHealthy() { return true },
    async cancel() {},
    async *send(threadId: string | undefined, input: AgentInput): AsyncIterable<AgentStreamEvent> {
      calls.push({ threadId, input })
    },
  }
}

function makeManager(backend: IAgentBackend): AgentManager {
  return new AgentManager({
    userDataDir: tmpDir,
    backend,
    store: {
      createThread: async () => ({ id: 'thread-1' }),
      addMessage: async () => ({ id: 'msg-1' }),
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

describe('AgentManager mention input items', () => {
  it('attaches a mention item per payload.mentions entry, preserving name + path', async () => {
    const backend = makeBackend()
    const mgr = makeManager(backend)
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({
      content: '@sample Summarize the latest updates.',
      attachments: [],
      mentions: [{ name: 'Sample Plugin', path: 'plugin://sample@test' }],
    })
    await flushMicrotasks()

    expect(backend.calls).toHaveLength(1)
    expect(backend.calls[0].input.items).toContainEqual({
      type: 'mention',
      name: 'Sample Plugin',
      path: 'plugin://sample@test',
    })
  })

  it('dedupes mentions by path so a doubled @token invokes the plugin once', async () => {
    const backend = makeBackend()
    const mgr = makeManager(backend)
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({
      content: '@sample and again @sample',
      attachments: [],
      mentions: [
        { name: 'Sample Plugin', path: 'plugin://sample@test' },
        { name: 'Sample Plugin', path: 'plugin://sample@test' },
      ],
    })
    await flushMicrotasks()

    const mentionItems = backend.calls[0].input.items.filter((item) => item.type === 'mention')
    expect(mentionItems).toHaveLength(1)
  })

  it('sends no mention items when payload.mentions is omitted', async () => {
    const backend = makeBackend()
    const mgr = makeManager(backend)
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({ content: 'plain message', attachments: [] })
    await flushMicrotasks()

    const mentionItems = backend.calls[0].input.items.filter((item) => item.type === 'mention')
    expect(mentionItems).toHaveLength(0)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { AgentManager } from '../AgentManager'
import type { AgentInput, IAgentBackend } from '../types'
import type { AgentStreamEvent } from '../../../types/agent'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-model-selection-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('AgentManager model-selection turn admission', () => {
  it('repairs a legacy model-only payload before persisting a user message', async () => {
    const operations: string[] = []
    const sentModels: string[] = []
    const backend = {
      async start() {
        operations.push('start')
      },
      async stop() {},
      isHealthy: () => false,
      setProvider: (provider: { id: string } | undefined) => {
        operations.push(`channel:${provider?.id ?? 'none'}`)
      },
      async cancel() {},
      async *send(_threadId: string | undefined, input: AgentInput): AsyncIterable<AgentStreamEvent> {
        sentModels.push(input.model)
      },
    } satisfies IAgentBackend
    const store = {
      createThread: async () => {
        operations.push('thread')
        return { id: 'thread-1' }
      },
      addMessage: async () => {
        operations.push('message')
        return { id: 'message-1' }
      },
      updateLastMessageAt: async () => undefined,
    }
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend,
      store: store as never,
      attachments: { ingest: async () => [] } as never,
      eventSink: () => {},
    })
    await manager.setCodexApiKey('test-key')
    const catalogResult = await manager.getModelSettingsCatalogRpc()
    if (!catalogResult.ok) throw new Error(catalogResult.error)
    const grok = catalogResult.data.models.find((model) => model.id === 'grok-4.5')
    if (!grok) throw new Error('Expected Grok catalog entry')
    operations.length = 0

    await manager.sendMessage({
      content: 'route me before persistence',
      attachments: [],
      model: grok.id,
    })

    expect(operations).toEqual([
      'channel:apiyi-grok',
      'start',
      'thread',
      'message',
    ])
    expect(sentModels).toEqual([grok.id])
  })

  it('rejects payload model and intent mismatch before start or persistence', async () => {
    const start = vi.fn(async () => undefined)
    const createThread = vi.fn(async () => ({ id: 'thread-mismatch' }))
    const addMessage = vi.fn(async () => ({ id: 'message-mismatch' }))
    const send = vi.fn(async function* (): AsyncIterable<AgentStreamEvent> {})
    const backend = {
      start,
      async stop() {},
      isHealthy: () => false,
      setProvider: vi.fn(),
      async cancel() {},
      send,
    } satisfies IAgentBackend
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend,
      store: {
        createThread,
        addMessage,
        updateLastMessageAt: async () => undefined,
      } as never,
      attachments: { ingest: async () => [] } as never,
      eventSink: () => {},
    })
    await manager.setCodexApiKey('test-key')
    const catalogResult = await manager.getModelSettingsCatalogRpc()
    if (!catalogResult.ok) throw new Error(catalogResult.error)
    const grok = catalogResult.data.models.find((model) => model.id === 'grok-4.5')
    if (!grok) throw new Error('Expected Grok catalog entry')
    start.mockClear()

    await expect(manager.sendMessage({
      content: 'mismatch',
      attachments: [],
      model: 'gpt-5.5',
      modelSelection: {
        gatewayId: catalogResult.data.gatewayId,
        modelId: grok.id,
        contextWindow: grok.capabilities.defaultContextWindow,
        catalogRevision: catalogResult.data.revision,
      },
    })).rejects.toThrow(/model.*mismatch|不一致/i)

    expect(start).not.toHaveBeenCalled()
    expect(createThread).not.toHaveBeenCalled()
    expect(addMessage).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects an invalid legacy model before every turn side effect', async () => {
    const start = vi.fn(async () => undefined)
    const createThread = vi.fn(async () => ({ id: 'thread-invalid' }))
    const addMessage = vi.fn(async () => ({ id: 'message-invalid' }))
    const send = vi.fn(async function* (): AsyncIterable<AgentStreamEvent> {})
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend: {
        start,
        async stop() {},
        isHealthy: () => false,
        async cancel() {},
        send,
      },
      store: {
        createThread,
        addMessage,
        updateLastMessageAt: async () => undefined,
      } as never,
      attachments: { ingest: async () => [] } as never,
      eventSink: () => {},
    })
    await manager.setCodexApiKey('test-key')
    start.mockClear()

    await expect(manager.sendMessage({
      content: 'invalid route',
      attachments: [],
      model: 'definitely-not-in-catalog',
    })).rejects.toThrow(/not in.*catalog|不在当前目录|unknown/i)

    expect(start).not.toHaveBeenCalled()
    expect(createThread).not.toHaveBeenCalled()
    expect(addMessage).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('blocks subsequent sends after Channel recovery becomes unprovable', async () => {
    let epoch = 1
    let failRestarts = false
    const createThread = vi.fn(async () => ({ id: 'thread-poisoned' }))
    const addMessage = vi.fn(async () => ({ id: 'message-poisoned' }))
    const backend = {
      async start() {},
      async stop() {},
      isHealthy: () => true,
      currentEpoch: () => epoch,
      setProvider: vi.fn(),
      async restartCodex() {
        if (failRestarts) throw new Error('runtime unhealthy')
        epoch += 1
      },
      async cancel() {},
      async *send(): AsyncIterable<AgentStreamEvent> {},
    } satisfies IAgentBackend
    const manager = new AgentManager({
      userDataDir: tmpDir,
      backend,
      store: {
        createThread,
        addMessage,
        updateLastMessageAt: async () => undefined,
      } as never,
      attachments: { ingest: async () => [] } as never,
      eventSink: () => {},
    })
    await manager.setCodexApiKey('test-key')
    const catalogResult = await manager.getModelSettingsCatalogRpc()
    if (!catalogResult.ok) throw new Error(catalogResult.error)
    failRestarts = true

    await expect(manager.sendMessage({
      content: 'poison runtime',
      attachments: [],
      model: 'grok-4.5',
    })).rejects.toThrow(/runtime unhealthy|recovery/i)
    await expect(manager.sendMessage({
      content: 'must stay blocked',
      attachments: [],
      model: 'gpt-5.5',
    })).rejects.toThrow(/recovery|恢复|unprovable/i)

    const context = await manager.getModelContextConfigRpc()
    expect(context).toMatchObject({
      ok: true,
      data: {
        recoveryRequired: true,
        recoveryError: expect.stringMatching(/runtime unhealthy/i),
      },
    })
    expect(createThread).not.toHaveBeenCalled()
    expect(addMessage).not.toHaveBeenCalled()
  })
})

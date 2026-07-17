import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
  it('repairs the requested route before persisting a user message', async () => {
    const operations: string[] = []
    const backend = {
      async start() {},
      async stop() {},
      isHealthy: () => false,
      setProvider: (provider: { id: string } | undefined) => {
        operations.push(`channel:${provider?.id ?? 'none'}`)
      },
      async cancel() {},
      async *send(): AsyncIterable<AgentStreamEvent> {},
    } satisfies IAgentBackend
    const store = {
      createThread: async () => ({ id: 'thread-1' }),
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
      modelSelection: {
        gatewayId: catalogResult.data.gatewayId,
        modelId: grok.id,
        contextWindow: grok.capabilities.defaultContextWindow,
        catalogRevision: catalogResult.data.revision,
      },
    })

    expect(operations).toEqual([
      'channel:apiyi-grok',
      'message',
    ])
  })
})

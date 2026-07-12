import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentManager } from '../AgentManager'
import type { CodexModel, CodexModelListParams } from '../codexProtocol'
import type { AgentInput, IAgentBackend } from '../types'
import type { AgentStreamEvent } from '../../../types/agent'

interface CatalogBackend extends IAgentBackend {
  modelCalls: CodexModelListParams[]
  rows: CodexModel[]
  listError?: Error
  epoch: number
}

function modelRow(overrides: Partial<CodexModel> = {}): CodexModel {
  return {
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    description: 'Frontier coding model',
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'ultra', description: 'not a supported UI effort' },
      { reasoningEffort: 'fast', description: 'service speed, not reasoning' },
      { reasoningEffort: 'low', description: 'Low' },
      { reasoningEffort: 'medium', description: 'Medium' },
      { reasoningEffort: 'high', description: 'High' },
      { reasoningEffort: 'xhigh', description: 'Extra high' },
      { reasoningEffort: 'max', description: 'Max' },
    ],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text', 'image'],
    supportsPersonality: true,
    isDefault: true,
    upgrade: null,
    additionalSpeedTiers: ['fast'],
    defaultServiceTier: 'priority',
    serviceTiers: [
      { id: 'priority', name: 'Priority', description: 'Fastest available tier' },
    ],
    ...overrides,
  }
}

function makeBackend(rows: CodexModel[]): CatalogBackend {
  const backend: CatalogBackend = {
    rows,
    modelCalls: [],
    epoch: 1,
    async start() {},
    async stop() {},
    isHealthy() { return false },
    currentEpoch() { return backend.epoch },
    async cancel() {},
    async *send(
      _threadId: string | undefined,
      _input: AgentInput,
    ): AsyncIterable<AgentStreamEvent> {},
    async listModels(params) {
      backend.modelCalls.push(params ?? {})
      if (backend.listError) throw backend.listError
      return { data: backend.rows, nextCursor: null }
    },
  }
  return backend
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-model-catalog-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeManager(backend: IAgentBackend): AgentManager {
  return new AgentManager({
    userDataDir: tmpDir,
    backend,
  })
}

describe('AgentManager model settings catalog and snapshot', () => {
  it('waits for the current Provider barrier before listing models', async () => {
    let releaseBarrier!: (ready: boolean) => void
    const backend = makeBackend([modelRow()])
    const manager = makeManager(backend)
    ;(manager as unknown as { providerCapabilityBarrier: Promise<boolean> })
      .providerCapabilityBarrier = new Promise<boolean>((resolve) => {
        releaseBarrier = resolve
      })

    const pending = manager.getModelSettingsCatalogRpc()
    await Promise.resolve()
    expect(backend.modelCalls).toEqual([])

    releaseBarrier(true)
    await expect(pending).resolves.toMatchObject({
      ok: true,
      data: { provider: 'apiyi', source: 'codex' },
    })
    expect(backend.modelCalls).toEqual([{ includeHidden: false }])
  })

  it('retries when a model/list response belongs to a stale backend epoch', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const backend = makeBackend([])
    backend.listModels = async (params) => {
      backend.modelCalls.push(params ?? {})
      if (backend.modelCalls.length === 1) {
        await firstGate
        return {
          data: [modelRow({ id: 'stale-model', model: 'stale-model' })],
          nextCursor: null,
        }
      }
      return { data: [modelRow()], nextCursor: null }
    }
    const manager = makeManager(backend)

    const pending = manager.getModelSettingsCatalogRpc()
    await vi.waitFor(() => {
      expect(backend.modelCalls).toHaveLength(1)
    })
    backend.epoch = 2
    releaseFirst()

    await expect(pending).resolves.toMatchObject({
      ok: true,
      data: {
        provider: 'apiyi',
        source: 'codex',
        models: [{ id: 'gpt-5.6-sol' }],
      },
    })
    expect(backend.modelCalls).toEqual([
      { includeHidden: false },
      { includeHidden: false },
    ])
  })

  it('maps exact runtime rows through shared provider policy', async () => {
    const backend = makeBackend([
      modelRow(),
      modelRow({
        id: 'gpt-5.5',
        model: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: 'Stable coding model',
        isDefault: false,
      }),
    ])
    const manager = makeManager(backend)
    await manager.setActiveProvider('rightcode')

    const result = await manager.getModelSettingsCatalogRpc()

    expect(result).toEqual({
      ok: true,
      data: {
        provider: 'rightcode',
        source: 'codex',
        models: [
          expect.objectContaining({
            id: 'gpt-5.6-sol',
            displayName: 'GPT-5.6 Sol',
            description: 'Frontier coding model',
            hidden: false,
            isDefault: true,
            capabilities: expect.objectContaining({
              model: 'gpt-5.6-sol',
              provider: 'rightcode',
              supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
            }),
          }),
          expect.objectContaining({
            id: 'gpt-5.5',
            capabilities: expect.objectContaining({
              supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
            }),
          }),
        ],
      },
    })
    expect(backend.modelCalls).toEqual([{ includeHidden: false }])
  })

  it('returns non-empty conservative canonical fallback rows when model/list fails', async () => {
    const backend = makeBackend([])
    backend.listError = new Error('model/list unavailable')
    const manager = makeManager(backend)

    const result = await manager.getModelSettingsCatalogRpc()

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('Expected fallback catalog')
    expect(result.data.source).toBe('fallback')
    expect(result.data.provider).toBe('apiyi')
    expect(result.data.models.length).toBeGreaterThan(0)
    expect(result.data.models.every((row) =>
      row.capabilities.contextOptions.every((option) => option.conservative === true),
    )).toBe(true)
  })

  it('returns a fresh confirmed context snapshot that callers cannot mutate', async () => {
    const manager = makeManager(makeBackend([]))

    const first = await manager.getModelContextConfigRpc()
    expect(first).toEqual({
      ok: true,
      data: {
        modelContextWindow: 200_000,
        modelAutoCompactTokenLimit: 180_000,
      },
    })
    if (!first.ok) throw new Error('Expected context snapshot')
    first.data.modelContextWindow = 1

    await expect(manager.getModelContextConfigRpc()).resolves.toEqual({
      ok: true,
      data: {
        modelContextWindow: 200_000,
        modelAutoCompactTokenLimit: 180_000,
      },
    })
  })
})

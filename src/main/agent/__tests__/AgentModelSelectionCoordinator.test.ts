import { describe, expect, it, vi } from 'vitest'

import type {
  AgentModelSelectionApplyPayload,
  AgentModelSelectionSnapshot,
} from '../../../types/agent'
import { AgentModelSelectionCoordinator } from '../AgentModelSelectionCoordinator'
import type { ProviderChannelController } from '../ProviderChannelController'

function selection(
  gatewayId: string,
  modelId: string,
  requestVersion: number,
): AgentModelSelectionApplyPayload {
  return {
    gatewayId,
    modelId,
    contextWindow: modelId === 'grok-4.5' ? 1_000_000 : 272_000,
    catalogRevision: 'catalog-1',
    requestVersion,
  }
}

function deferred(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createSelectionHarness(
  overrides: Partial<AgentModelSelectionSnapshot> = {},
) {
  let snapshot: AgentModelSelectionSnapshot = {
    gatewayId: 'rightcode',
    channelId: 'rightcode-standard',
    modelId: 'gpt-5.5',
    contextWindow: 272_000,
    autoCompactTokenLimit: 244_800,
    catalogRevision: 'catalog-1',
    backendEpoch: 1,
    threadRestored: false,
    ...overrides,
  }
  const channelController = {
    apply: vi.fn(async () => ({
      changed: false,
      previousChannelId: snapshot.channelId,
      channelId: snapshot.channelId,
      backendEpoch: snapshot.backendEpoch,
    })),
    restore: vi.fn(async () => undefined),
  } as unknown as ProviderChannelController
  const applyContext = vi.fn(async () => undefined)
  const persistSelection = vi.fn(async (next: AgentModelSelectionSnapshot) => {
    snapshot = next
  })
  const restoreSelection = vi.fn(async (next: AgentModelSelectionSnapshot) => {
    snapshot = next
  })
  const coordinator = new AgentModelSelectionCoordinator({
    channelController,
    getSnapshot: () => snapshot,
    catalogRevisionIsCurrent: () => true,
    applyContext,
    persistSelection,
    restoreSelection,
    resumeThread: vi.fn(async () => undefined),
    backendEpoch: () => 2,
  })

  return {
    coordinator,
    channelController,
    applyContext,
    persistSelection,
    restoreSelection,
  }
}

describe('AgentModelSelectionCoordinator', () => {
  it('switches models in the same channel without restart', async () => {
    const harness = createSelectionHarness({
      gatewayId: 'rightcode',
      channelId: 'rightcode-standard',
      modelId: 'gpt-5.2',
    })

    const result = await harness.coordinator.apply(
      selection('rightcode', 'gpt-5.5', 1),
    )

    expect(result.ok).toBe(true)
    expect(harness.channelController.apply).toHaveBeenCalledWith(
      'rightcode-standard',
    )
    expect(harness.applyContext).not.toHaveBeenCalled()
  })

  it('rolls back channel model context and catalog on failure', async () => {
    const harness = createSelectionHarness()
    harness.applyContext.mockRejectedValueOnce(new Error('restart failed'))

    const result = await harness.coordinator.apply(
      selection('rightcode', 'grok-4.5', 1),
    )

    expect(result).toMatchObject({
      ok: false,
      kind: 'transaction',
      rollback: { ok: true },
    })
    expect(harness.channelController.restore).toHaveBeenCalledWith(
      'rightcode-standard',
    )
    expect(harness.persistSelection).not.toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'grok-4.5' }),
    )
  })

  it('rejects a stale catalog before mutating the Channel', async () => {
    const harness = createSelectionHarness()
    const coordinator = new AgentModelSelectionCoordinator({
      channelController: harness.channelController,
      getSnapshot: () => ({
        gatewayId: 'rightcode',
        channelId: 'rightcode-standard',
        modelId: 'gpt-5.5',
        contextWindow: 272_000,
        autoCompactTokenLimit: 244_800,
        catalogRevision: 'catalog-current',
        threadRestored: false,
      }),
      catalogRevisionIsCurrent: () => false,
      applyContext: harness.applyContext,
      persistSelection: harness.persistSelection,
      restoreSelection: harness.restoreSelection,
      resumeThread: vi.fn(async () => undefined),
      backendEpoch: () => 2,
    })

    await expect(coordinator.apply(selection('rightcode', 'gpt-5.6-sol', 1)))
      .resolves.toMatchObject({
        ok: false,
        kind: 'configuration',
        stage: 'catalog',
      })
    expect(harness.channelController.apply).not.toHaveBeenCalled()
  })

  it('lets the newest request win when an older transition completes later', async () => {
    const harness = createSelectionHarness()
    const firstContextStarted = deferred()
    const releaseFirstContext = deferred()
    harness.applyContext.mockImplementation(async (contextWindow: number) => {
      if (contextWindow === 1_000_000) {
        firstContextStarted.resolve()
        await releaseFirstContext.promise
      }
    })

    const first = harness.coordinator.apply(
      selection('rightcode', 'grok-4.5', 1),
    )
    await firstContextStarted.promise
    const latest = harness.coordinator.apply(
      selection('rightcode', 'gpt-5.6-sol', 2),
    )
    releaseFirstContext.resolve()

    await expect(first).resolves.toMatchObject({
      ok: false,
      stage: 'rollback',
      requestVersion: 1,
    })
    await expect(latest).resolves.toMatchObject({
      ok: true,
      data: {
        modelId: 'gpt-5.6-sol',
        requestVersion: 2,
      },
    })
    expect(harness.persistSelection).toHaveBeenCalledTimes(1)
    expect(harness.persistSelection).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelId: 'gpt-5.6-sol' }),
      undefined,
    )
  })
})

import { describe, expect, it, vi } from 'vitest'

import type {
  AgentModelSelectionApplyPayload,
  AgentModelSelectionSnapshot,
} from '../../../types/agent'
import { AgentModelSelectionCoordinator } from '../AgentModelSelectionCoordinator'
import {
  ProviderChannelRecoveryError,
  type ProviderChannelController,
} from '../ProviderChannelController'

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
    recover: vi.fn(async () => undefined),
  } as unknown as ProviderChannelController
  const applyContext = vi.fn(async (
    _contextWindow: number,
    _requestVersion: number,
  ) => undefined)
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
    expect(harness.restoreSelection.mock.invocationCallOrder[0]).toBeLessThan(
      harness.persistSelection.mock.invocationCallOrder[0],
    )
    expect(harness.coordinator.getRecoveryState()).toEqual({
      recoveryRequired: false,
    })
  })

  it('poisons recovery when Channel apply and controller recovery both fail', async () => {
    const harness = createSelectionHarness()
    vi.mocked(harness.channelController.apply).mockRejectedValueOnce(
      new ProviderChannelRecoveryError(
        new Error('replacement unhealthy'),
        new Error('recovery unhealthy'),
      ),
    )

    const failed = await harness.coordinator.apply(
      selection('rightcode', 'grok-4.5', 1),
    )

    expect(failed).toMatchObject({
      ok: false,
      kind: 'transaction',
      stage: 'rollback',
      retryable: false,
      recoveryRequired: true,
      error: expect.stringMatching(/replacement unhealthy.*recovery unhealthy/i),
      rollback: {
        ok: false,
        error: expect.stringMatching(/replacement unhealthy.*recovery unhealthy/i),
        effectiveSnapshot: null,
      },
    })
    expect(harness.channelController.restore).not.toHaveBeenCalled()

    const blocked = await harness.coordinator.ensureForTurn({
      gatewayId: 'rightcode',
      modelId: 'gpt-5.5',
      contextWindow: 272_000,
      catalogRevision: 'catalog-1',
    })
    expect(blocked).toMatchObject({
      ok: false,
      kind: 'transaction',
      stage: 'rollback',
      recoveryRequired: true,
    })
    expect(vi.mocked(harness.channelController.apply)).toHaveBeenCalledTimes(1)

    await harness.coordinator.recover()
    expect(harness.channelController.recover).toHaveBeenCalledWith(
      'rightcode-standard',
    )
    await expect(harness.coordinator.ensureForTurn({
      gatewayId: 'rightcode',
      modelId: 'gpt-5.5',
      contextWindow: 272_000,
      catalogRevision: 'catalog-1',
    })).resolves.toMatchObject({ ok: true })
  })

  it.each([
    ['Channel', selection('rightcode', 'grok-4.5', 1)],
    [
      'Context',
      {
        ...selection('rightcode', 'gpt-5.5', 1),
        contextWindow: 1_000_000,
        contextSource: 'context-only',
      },
    ],
  ])('rejects a %s restart while a turn is active without side effects', async (
    _label,
    payload,
  ) => {
    const harness = createSelectionHarness()
    const hasActiveTurns = vi.fn(() => true)
    const coordinator = new AgentModelSelectionCoordinator({
      channelController: harness.channelController,
      getSnapshot: () => ({
        gatewayId: 'rightcode',
        channelId: 'rightcode-standard',
        modelId: 'gpt-5.5',
        contextWindow: 272_000,
        autoCompactTokenLimit: 244_800,
        catalogRevision: 'catalog-1',
        threadRestored: false,
      }),
      catalogRevisionIsCurrent: () => true,
      applyContext: harness.applyContext,
      persistSelection: harness.persistSelection,
      restoreSelection: harness.restoreSelection,
      resumeThread: vi.fn(async () => undefined),
      backendEpoch: () => 2,
      hasActiveTurns,
    } as never)

    const result = await coordinator.apply(payload as AgentModelSelectionApplyPayload)

    expect(result).toMatchObject({
      ok: false,
      kind: 'transient',
      stage: 'busy',
      retryable: true,
    })
    expect(hasActiveTurns).toHaveBeenCalled()
    expect(harness.channelController.apply).not.toHaveBeenCalled()
    expect(harness.applyContext).not.toHaveBeenCalled()
    expect(harness.persistSelection).not.toHaveBeenCalled()
  })

  it('validates catalog availability even when snapshot fields already match', async () => {
    const harness = createSelectionHarness()
    const validateIntent = vi.fn(() => 'API key required')
    const coordinator = new AgentModelSelectionCoordinator({
      channelController: harness.channelController,
      getSnapshot: () => ({
        gatewayId: 'rightcode',
        channelId: 'rightcode-standard',
        modelId: 'gpt-5.5',
        contextWindow: 272_000,
        autoCompactTokenLimit: 244_800,
        catalogRevision: 'catalog-1',
        threadRestored: false,
      }),
      catalogRevisionIsCurrent: () => true,
      applyContext: harness.applyContext,
      persistSelection: harness.persistSelection,
      restoreSelection: harness.restoreSelection,
      resumeThread: vi.fn(async () => undefined),
      backendEpoch: () => 2,
      validateIntent,
    })

    const result = await coordinator.ensureForTurn({
      gatewayId: 'rightcode',
      modelId: 'gpt-5.5',
      contextWindow: 272_000,
      catalogRevision: 'catalog-1',
    })

    expect(result).toMatchObject({
      ok: false,
      kind: 'configuration',
      stage: 'catalog',
      error: 'API key required',
    })
    expect(validateIntent).toHaveBeenCalled()
    expect(harness.persistSelection).not.toHaveBeenCalled()
  })

  it('rolls back when the catalog changes after runtime apply but before persistence', async () => {
    const harness = createSelectionHarness()
    const catalogRevisionIsCurrent = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    const coordinator = new AgentModelSelectionCoordinator({
      channelController: harness.channelController,
      getSnapshot: () => ({
        gatewayId: 'rightcode',
        channelId: 'rightcode-standard',
        modelId: 'gpt-5.5',
        contextWindow: 272_000,
        autoCompactTokenLimit: 244_800,
        catalogRevision: 'catalog-1',
        threadRestored: false,
      }),
      catalogRevisionIsCurrent,
      applyContext: harness.applyContext,
      persistSelection: harness.persistSelection,
      restoreSelection: harness.restoreSelection,
      resumeThread: vi.fn(async () => undefined),
      backendEpoch: () => 2,
    })

    const result = await coordinator.apply(
      selection('rightcode', 'grok-4.5', 1),
    )

    expect(result).toMatchObject({
      ok: false,
      kind: 'configuration',
      stage: 'catalog',
      rollback: { ok: true },
    })
    expect(catalogRevisionIsCurrent).toHaveBeenCalledTimes(2)
    expect(harness.persistSelection).not.toHaveBeenCalled()
    expect(harness.applyContext).toHaveBeenLastCalledWith(272_000, 1)
  })

  it('detects a deferred catalog revision change before persistence', async () => {
    const harness = createSelectionHarness()
    const contextStarted = deferred()
    const releaseContext = deferred()
    let revisionCurrent = true
    harness.applyContext.mockImplementationOnce(async () => {
      contextStarted.resolve()
      await releaseContext.promise
    })
    const coordinator = new AgentModelSelectionCoordinator({
      channelController: harness.channelController,
      getSnapshot: () => ({
        gatewayId: 'rightcode',
        channelId: 'rightcode-standard',
        modelId: 'gpt-5.5',
        contextWindow: 272_000,
        autoCompactTokenLimit: 244_800,
        catalogRevision: 'catalog-1',
        threadRestored: false,
      }),
      catalogRevisionIsCurrent: () => revisionCurrent,
      applyContext: harness.applyContext,
      persistSelection: harness.persistSelection,
      restoreSelection: harness.restoreSelection,
      resumeThread: vi.fn(async () => undefined),
      backendEpoch: () => 2,
    })

    const applying = coordinator.apply(selection('rightcode', 'grok-4.5', 1))
    await contextStarted.promise
    revisionCurrent = false
    releaseContext.resolve()

    await expect(applying).resolves.toMatchObject({
      ok: false,
      kind: 'configuration',
      stage: 'catalog',
      rollback: { ok: true },
    })
    expect(harness.persistSelection).not.toHaveBeenCalled()
  })

  it('rolls back a persisted selection when revision changes before commit', async () => {
    const harness = createSelectionHarness()
    const catalogRevisionIsCurrent = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    const coordinator = new AgentModelSelectionCoordinator({
      channelController: harness.channelController,
      getSnapshot: () => ({
        gatewayId: 'rightcode',
        channelId: 'rightcode-standard',
        modelId: 'gpt-5.5',
        contextWindow: 272_000,
        autoCompactTokenLimit: 244_800,
        catalogRevision: 'catalog-1',
        threadRestored: false,
      }),
      catalogRevisionIsCurrent,
      applyContext: harness.applyContext,
      persistSelection: harness.persistSelection,
      restoreSelection: harness.restoreSelection,
      resumeThread: vi.fn(async () => undefined),
      backendEpoch: () => 2,
    })

    const result = await coordinator.apply(
      selection('rightcode', 'gpt-5.6-sol', 1),
    )

    expect(result).toMatchObject({
      ok: false,
      kind: 'configuration',
      stage: 'verify',
      rollback: { ok: true },
    })
    expect(harness.persistSelection).toHaveBeenCalledTimes(1)
    expect(harness.restoreSelection).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'gpt-5.5' }),
      undefined,
    )
  })

  it('preserves active supported Context for model selection but applies explicit Context requests', async () => {
    const harness = createSelectionHarness({
      modelId: 'gpt-5.5',
      contextWindow: 1_000_000,
      autoCompactTokenLimit: 900_000,
    })
    const resolveContext = vi.fn((
      payload: AgentModelSelectionApplyPayload,
      previous: AgentModelSelectionSnapshot,
    ) => (payload as AgentModelSelectionApplyPayload & {
      contextSource?: 'model-selection' | 'context-only'
    }).contextSource === 'context-only'
      ? payload.contextWindow
      : previous.contextWindow)
    const coordinator = new AgentModelSelectionCoordinator({
      channelController: harness.channelController,
      getSnapshot: () => ({
        gatewayId: 'rightcode',
        channelId: 'rightcode-standard',
        modelId: 'gpt-5.5',
        contextWindow: 1_000_000,
        autoCompactTokenLimit: 900_000,
        catalogRevision: 'catalog-1',
        threadRestored: false,
      }),
      catalogRevisionIsCurrent: () => true,
      applyContext: harness.applyContext,
      persistSelection: harness.persistSelection,
      restoreSelection: harness.restoreSelection,
      resumeThread: vi.fn(async () => undefined),
      backendEpoch: () => 2,
      resolveContext,
    } as never)

    const modelResult = await coordinator.apply({
      ...selection('rightcode', 'gpt-5.6-sol', 1),
      contextWindow: 272_000,
      contextSource: 'model-selection',
    } as AgentModelSelectionApplyPayload)
    expect(modelResult).toMatchObject({
      ok: true,
      data: { contextWindow: 1_000_000 },
    })
    expect(harness.applyContext).not.toHaveBeenCalled()

    const contextResult = await coordinator.apply({
      ...selection('rightcode', 'gpt-5.6-sol', 2),
      contextWindow: 272_000,
      contextSource: 'context-only',
    } as AgentModelSelectionApplyPayload)
    expect(contextResult).toMatchObject({
      ok: true,
      data: { contextWindow: 272_000 },
    })
    expect(harness.applyContext).toHaveBeenCalledWith(272_000, 2)
  })

  it('restores each target thread model instead of the global previous model', async () => {
    const threadModels = new Map([
      ['thread-a', 'thread-a-old'],
      ['thread-b', 'thread-b-old'],
    ])
    const globalSnapshot: AgentModelSelectionSnapshot = {
      gatewayId: 'rightcode',
      channelId: 'rightcode-standard',
      modelId: 'global-old',
      contextWindow: 272_000,
      autoCompactTokenLimit: 244_800,
      catalogRevision: 'catalog-1',
      threadRestored: false,
    }
    const restoreSelection = vi.fn(async () => undefined)
    const getSnapshot = vi.fn(async (threadId?: string) => ({
      ...globalSnapshot,
      ...(threadId ? { threadModelId: threadModels.get(threadId) } : {}),
    }))
    const coordinator = new AgentModelSelectionCoordinator({
      channelController: {
        apply: vi.fn(async () => ({
          changed: false,
          previousChannelId: 'rightcode-standard',
          channelId: 'rightcode-standard',
        })),
        restore: vi.fn(async () => undefined),
      } as unknown as ProviderChannelController,
      getSnapshot,
      catalogRevisionIsCurrent: () => true,
      applyContext: vi.fn(async () => undefined),
      persistSelection: vi.fn(async () => {
        throw new Error('persist failed')
      }),
      restoreSelection,
      resumeThread: vi.fn(async () => undefined),
      backendEpoch: () => 2,
    } as never)

    await coordinator.apply({
      ...selection('rightcode', 'gpt-5.6-sol', 1),
      threadId: 'thread-a',
    })
    await coordinator.apply({
      ...selection('rightcode', 'gpt-5.6-sol', 2),
      threadId: 'thread-b',
    })

    expect(getSnapshot).toHaveBeenNthCalledWith(1, 'thread-a')
    expect(getSnapshot).toHaveBeenNthCalledWith(2, 'thread-b')
    expect(restoreSelection).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ threadModelId: 'thread-a-old' }),
      'thread-a',
    )
    expect(restoreSelection).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ threadModelId: 'thread-b-old' }),
      'thread-b',
    )
  })

  it('poisons rollback whenever any compensation step fails', async () => {
    const harness = createSelectionHarness()
    harness.applyContext.mockRejectedValueOnce(new Error('context apply failed'))
    harness.restoreSelection.mockRejectedValueOnce(new Error('persist rollback failed'))

    const result = await harness.coordinator.apply(
      selection('rightcode', 'grok-4.5', 1),
    )

    expect(result).toMatchObject({
      ok: false,
      kind: 'transaction',
      stage: 'rollback',
      retryable: false,
      recoveryRequired: true,
      rollback: {
        ok: false,
        error: expect.stringMatching(/persist rollback failed/i),
        effectiveSnapshot: null,
      },
    })
  })
})

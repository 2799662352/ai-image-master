import { describe, expect, it, vi } from 'vitest'

import type { AgentModelSelectionSnapshot } from '../../../types/agent'
import { AgentModelSelectionCoordinator } from '../AgentModelSelectionCoordinator'
import type { ProviderChannelController } from '../ProviderChannelController'

/**
 * Plan B per-thread provider routing: same-gateway sibling Channel switches
 * ride the LIVE spawn (the sibling table is already registered as an extra
 * provider), so they must neither restart the process nor wait on OTHER
 * threads' in-flight turns. Cross-gateway switches keep the original
 * restart transaction untouched.
 */

interface HarnessOptions {
  snapshot?: Partial<AgentModelSelectionSnapshot>
  canRouteInProcess?: (
    previous: AgentModelSelectionSnapshot,
    route: { gatewayId: string; channelId: string },
  ) => boolean
  hasInFlightWork?: () => boolean
  threadHasInFlightWork?: (threadId: string) => boolean
}

function createHarness(options: HarnessOptions = {}) {
  let snapshot: AgentModelSelectionSnapshot = {
    gatewayId: 'rightcode',
    channelId: 'rightcode-standard',
    modelId: 'gpt-5.5',
    contextWindow: 272_000,
    autoCompactTokenLimit: 244_800,
    catalogRevision: 'catalog-1',
    backendEpoch: 1,
    threadRestored: false,
    ...options.snapshot,
  }
  const channelController = {
    apply: vi.fn(async () => ({
      changed: true,
      previousChannelId: snapshot.channelId,
      channelId: snapshot.channelId,
      backendEpoch: snapshot.backendEpoch,
    })),
    restore: vi.fn(async () => undefined),
    recover: vi.fn(async () => undefined),
  } as unknown as ProviderChannelController
  const applyContext = vi.fn(async () => undefined)
  const persistSelection = vi.fn(async (next: AgentModelSelectionSnapshot) => {
    snapshot = next
  })
  const restoreSelection = vi.fn(async (next: AgentModelSelectionSnapshot) => {
    snapshot = next
  })
  const resumeThread = vi.fn(async () => undefined)
  const coordinator = new AgentModelSelectionCoordinator({
    channelController,
    getSnapshot: () => snapshot,
    catalogRevisionIsCurrent: () => true,
    applyContext,
    persistSelection,
    restoreSelection,
    resumeThread,
    backendEpoch: () => 2,
    ...(options.canRouteInProcess
      ? { canRouteInProcess: options.canRouteInProcess }
      : {}),
    ...(options.hasInFlightWork
      ? { hasInFlightWork: options.hasInFlightWork }
      : {}),
    ...(options.threadHasInFlightWork
      ? { threadHasInFlightWork: options.threadHasInFlightWork }
      : {}),
  })
  return {
    coordinator,
    channelController,
    applyContext,
    persistSelection,
    restoreSelection,
    resumeThread,
  }
}

const GROK_SELECTION = {
  gatewayId: 'rightcode',
  modelId: 'grok-4.5',
  contextWindow: 1_000_000,
  catalogRevision: 'catalog-1',
  requestVersion: 1,
}

describe('AgentModelSelectionCoordinator Plan B in-process routing', () => {
  it('routes a same-gateway sibling switch without restarting the process', async () => {
    const harness = createHarness({
      canRouteInProcess: (previous, route) =>
        previous.gatewayId === route.gatewayId,
    })

    const result = await harness.coordinator.apply({
      ...GROK_SELECTION,
      threadId: 'db-thread-1',
    })

    expect(result).toMatchObject({
      ok: true,
      data: { channelId: 'rightcode-grok', modelId: 'grok-4.5' },
    })
    // No process mutation: neither the Channel restart nor the launch-level
    // context restart may run — the pin rides the thread instead.
    expect(harness.channelController.apply).not.toHaveBeenCalled()
    expect(harness.applyContext).not.toHaveBeenCalled()
    // The existing codex thread re-binds via thread/resume with the target
    // provider table + per-thread context pin.
    expect(harness.resumeThread).toHaveBeenCalledWith('db-thread-1', {
      gatewayId: 'rightcode',
      channelId: 'rightcode-grok',
      modelId: 'grok-4.5',
      contextWindow: 1_000_000,
    })
    expect(harness.persistSelection).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'rightcode-grok' }),
      'db-thread-1',
    )
  })

  it('ignores OTHER threads\u2019 in-flight turns for an in-process switch', async () => {
    const harness = createHarness({
      canRouteInProcess: () => true,
      // The GLOBAL gate reports busy (another conversation is mid-turn)...
      hasInFlightWork: () => true,
      // ...but the TARGET thread itself is idle.
      threadHasInFlightWork: () => false,
    })

    const result = await harness.coordinator.apply({
      ...GROK_SELECTION,
      threadId: 'db-thread-idle',
    })

    expect(result.ok).toBe(true)
    expect(harness.channelController.apply).not.toHaveBeenCalled()
  })

  it('still gates on the TARGET thread\u2019s own active turn', async () => {
    const threadHasInFlightWork = vi.fn(() => true)
    const harness = createHarness({
      canRouteInProcess: () => true,
      hasInFlightWork: () => false,
      threadHasInFlightWork,
    })

    const result = await harness.coordinator.apply({
      ...GROK_SELECTION,
      threadId: 'db-thread-busy',
    })

    expect(result).toMatchObject({
      ok: false,
      stage: 'busy',
      retryable: true,
    })
    expect(threadHasInFlightWork).toHaveBeenCalledWith('db-thread-busy')
    expect(harness.resumeThread).not.toHaveBeenCalled()
    expect(harness.persistSelection).not.toHaveBeenCalled()
  })

  it('keeps the original restart transaction for cross-gateway switches', async () => {
    const harness = createHarness({
      canRouteInProcess: (previous, route) =>
        previous.gatewayId === route.gatewayId,
      hasInFlightWork: () => true,
    })

    // Cross-gateway (rightcode → apiyi): the GLOBAL busy gate still applies.
    const busy = await harness.coordinator.apply({
      gatewayId: 'apiyi',
      modelId: 'grok-4.5',
      contextWindow: 1_000_000,
      catalogRevision: 'catalog-1',
      requestVersion: 1,
    })
    expect(busy).toMatchObject({ ok: false, stage: 'busy', retryable: true })

    // Once idle, the cross-gateway switch restarts through the controller.
    const idleHarness = createHarness({
      canRouteInProcess: (previous, route) =>
        previous.gatewayId === route.gatewayId,
      hasInFlightWork: () => false,
    })
    const result = await idleHarness.coordinator.apply({
      gatewayId: 'apiyi',
      modelId: 'grok-4.5',
      contextWindow: 1_000_000,
      catalogRevision: 'catalog-1',
      requestVersion: 1,
    })
    expect(result.ok).toBe(true)
    expect(idleHarness.channelController.apply).toHaveBeenCalledWith('apiyi-grok')
  })

  it('rolls back an in-process switch without touching the live process', async () => {
    const harness = createHarness({
      canRouteInProcess: () => true,
    })
    harness.persistSelection.mockRejectedValueOnce(new Error('disk full'))

    const result = await harness.coordinator.apply({
      ...GROK_SELECTION,
      threadId: 'db-thread-1',
    })

    expect(result).toMatchObject({ ok: false, rollback: { ok: true } })
    // The process was never mutated, so rollback must not restart it either.
    expect(harness.channelController.apply).not.toHaveBeenCalled()
    expect(harness.channelController.restore).not.toHaveBeenCalled()
    expect(harness.applyContext).not.toHaveBeenCalled()
    expect(harness.restoreSelection).toHaveBeenCalled()
  })

  it('treats a thread already bound to the target channel as a no-op', async () => {
    const harness = createHarness({
      snapshot: {
        // GLOBAL selection has moved on to gpt-5.5 on the standard channel...
        gatewayId: 'rightcode',
        channelId: 'rightcode-standard',
        modelId: 'gpt-5.5',
        // ...but THIS thread is already bound to the grok sibling.
        thread: {
          exists: true,
          model: 'grok-4.5',
          gatewayId: 'rightcode',
          modelProvider: 'rightcode-grok',
        },
      },
      canRouteInProcess: () => true,
    })

    const result = await harness.coordinator.ensureForTurn(
      {
        gatewayId: 'rightcode',
        modelId: 'grok-4.5',
        contextWindow: 1_000_000,
        catalogRevision: 'catalog-1',
      },
      'db-thread-1',
    )

    expect(result).toMatchObject({
      ok: true,
      data: { channelId: 'rightcode-grok', modelId: 'grok-4.5' },
    })
    // Already bound: no resume, no persist churn, no restart.
    expect(harness.resumeThread).not.toHaveBeenCalled()
    expect(harness.persistSelection).not.toHaveBeenCalled()
    expect(harness.channelController.apply).not.toHaveBeenCalled()
  })
})

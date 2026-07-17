import { modelAutoCompactTokenLimit } from '../../shared/modelSettings'
import type {
  AgentModelRoute,
  AgentModelSelectionApplyPayload,
  AgentModelSelectionApplyResult,
  AgentModelSelectionErrorKind,
  AgentModelSelectionIntent,
  AgentModelSelectionRecoveryResult,
  AgentModelSelectionSnapshot,
  AgentModelSelectionStage,
} from '../../types/agent'
import { resolveGatewayModelRoute } from './gatewayModelRouting'
import {
  ProviderChannelRecoveryError,
  type ProviderChannelController,
} from './ProviderChannelController'

/** Runtime and persistence dependencies for model-selection transactions. */
export interface AgentModelSelectionCoordinatorOptions {
  channelController: ProviderChannelController
  getSnapshot: (
    threadId?: string,
  ) => AgentModelSelectionSnapshot | Promise<AgentModelSelectionSnapshot>
  catalogRevisionIsCurrent: (gatewayId: string, revision: string) => boolean
  applyContext: (contextWindow: number, requestVersion: number) => Promise<void>
  persistSelection: (
    snapshot: AgentModelSelectionSnapshot,
    threadId?: string,
  ) => Promise<void>
  restoreSelection: (
    snapshot: AgentModelSelectionSnapshot,
    threadId?: string,
  ) => Promise<void>
  resumeThread: (threadId: string) => Promise<void>
  backendEpoch: () => number | undefined
  /** Includes pending send admission as well as registered active turns. */
  hasInFlightWork?: () => boolean
  /**
   * Makes the poisoned snapshot available to the backend spawn getter without
   * committing Provider/thread/runtime durable state before recovery succeeds.
   */
  prepareRecovery?: (
    snapshot: AgentModelSelectionSnapshot,
  ) => void | Promise<void>
  /**
   * Revalidates poisoned persisted identities before a forced Channel restart.
   * The returned thread id is omitted when the saved DB thread was deleted.
   */
  validateRecovery?: (
    snapshot: AgentModelSelectionSnapshot,
    threadId?: string,
  ) => Promise<{
    snapshot: AgentModelSelectionSnapshot
    threadId?: string
  }>
  /**
   * Rebuilds the current catalog after a healthy recovery before poison clears.
   */
  refreshRecoveryCatalog?: (
    snapshot: AgentModelSelectionSnapshot,
  ) => Promise<void>
  resolveContext?: (
    payload: AgentModelSelectionApplyPayload,
    previous: AgentModelSelectionSnapshot,
    route: AgentModelRoute,
  ) => number
  /** Optional route injection for catalog-authorized custom Gateways. */
  resolveRoute?: (gatewayId: string, modelId: string) => AgentModelRoute
  /** Optional catalog-backed validation beyond revision equality. */
  validateIntent?: (
    payload: AgentModelSelectionApplyPayload,
    route: AgentModelRoute,
  ) => string | null
}

/** Origin used only to detect stale versions within the renderer selection UI. */
export type AgentModelSelectionIntentSource =
  | 'turn'
  | 'renderer-selection'

/** Entry-time reservation from the coordinator's internal monotonic clock. */
export interface AgentModelSelectionIntentReservation {
  accepted: boolean
  sequence: number
  source: AgentModelSelectionIntentSource
  /** Latest renderer selection that was already reserved before this intent. */
  rendererSelectionSequence: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function classifySelectionError(error: unknown): AgentModelSelectionErrorKind {
  const message = errorMessage(error)
  if (/\b(?:401|403)\b|unauthori[sz]ed|not enabled|unknown (?:Codex )?(?:gateway|provider|channel)|unavailable/i.test(message)) {
    return 'configuration'
  }
  if (/\b429\b|timeout|ECONN|network|socket/i.test(message)) {
    return 'transient'
  }
  return 'transaction'
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function validatePayload(payload: AgentModelSelectionApplyPayload): string | null {
  if (!isNonEmptyString(payload.gatewayId)) return 'Gateway id must be a non-empty string'
  if (!isNonEmptyString(payload.modelId)) return 'Model id must be a non-empty string'
  if (!isNonEmptyString(payload.catalogRevision)) {
    return 'Catalog revision must be a non-empty string'
  }
  if (!Number.isSafeInteger(payload.contextWindow) || payload.contextWindow <= 0) {
    return 'Context window must be a positive safe integer'
  }
  if (!Number.isSafeInteger(payload.requestVersion) || payload.requestVersion < 0) {
    return 'requestVersion must be a non-negative safe integer'
  }
  return null
}

interface SelectionRecoveryState {
  previous: AgentModelSelectionSnapshot
  threadId?: string
  error: string
}

/**
 * Applies model-driven Channel and context transitions atomically.
 *
 * The coordinator owns request ordering and compensation. Its dependencies own
 * the concrete Channel restart and durable persistence implementations.
 */
export class AgentModelSelectionCoordinator {
  private nextIntentSequence = 0
  private latestIntentSequence = 0
  private latestRendererIntentSequence = 0
  private readonly latestSourceVersion = new Map<
    AgentModelSelectionIntentSource,
    number
  >()
  private chain: Promise<void> = Promise.resolve()
  private recovery: SelectionRecoveryState | null = null

  constructor(
    private readonly options: AgentModelSelectionCoordinatorOptions,
  ) {}

  /**
   * Reserves cross-origin ordering synchronously at an external API boundary.
   * Renderer versions only reject older requests from the same UI origin.
   */
  reserveIntentSequence(
    source: AgentModelSelectionIntentSource,
    requestVersion?: number,
  ): AgentModelSelectionIntentReservation {
    if (requestVersion !== undefined) {
      if (!Number.isSafeInteger(requestVersion) || requestVersion < 0) {
        return {
          accepted: false,
          sequence: this.latestIntentSequence,
          source,
          rendererSelectionSequence: this.latestRendererIntentSequence,
        }
      }
      const previousVersion = this.latestSourceVersion.get(source)
      if (
        previousVersion !== undefined
        && requestVersion < previousVersion
      ) {
        return {
          accepted: false,
          sequence: this.latestIntentSequence,
          source,
          rendererSelectionSequence: this.latestRendererIntentSequence,
        }
      }
      this.latestSourceVersion.set(source, requestVersion)
    }
    this.nextIntentSequence += 1
    this.latestIntentSequence = this.nextIntentSequence
    if (source === 'renderer-selection') {
      this.latestRendererIntentSequence = this.latestIntentSequence
    }
    return {
      accepted: true,
      sequence: this.latestIntentSequence,
      source,
      rendererSelectionSequence: this.latestRendererIntentSequence,
    }
  }

  /** Queues one atomic Gateway/model/context selection request. */
  apply(
    payload: AgentModelSelectionApplyPayload,
    reservation = this.reserveIntentSequence(
      'renderer-selection',
      payload.requestVersion,
    ),
  ): Promise<AgentModelSelectionApplyResult> {
    const operation = this.chain.then(
      () => this.applySerialized(payload, reservation),
    )
    this.chain = operation.then(() => undefined, () => undefined)
    return operation
  }

  /**
   * Ensures a requested turn cannot reach a Channel that belongs to another
   * Gateway, model family, context window, or catalog revision.
   */
  ensureForTurn(
    intent: AgentModelSelectionIntent,
    threadId?: string,
    reservation = this.reserveIntentSequence('turn'),
  ): Promise<AgentModelSelectionApplyResult> {
    const payload: AgentModelSelectionApplyPayload = {
      ...intent,
      contextSource: intent.contextSource ?? 'model-selection',
      ...(threadId ? { threadId } : {}),
      requestVersion: 0,
    }
    const operation = this.chain.then(
      () => this.applySerialized(payload, reservation),
    )
    this.chain = operation.then(() => undefined, () => undefined)
    return operation
  }

  /** Returns the current recovery poison without exposing mutable state. */
  getRecoveryState(): Readonly<{
    recoveryRequired: boolean
    error?: string
  }> {
    return this.recovery
      ? { recoveryRequired: true, error: this.recovery.error }
      : { recoveryRequired: false }
  }

  /**
   * Explicitly verifies the last known Channel by forcing controller recovery.
   * Normal apply/ensure calls never clear poison merely because ids still match.
   */
  recover(): Promise<AgentModelSelectionRecoveryResult> {
    const operation = this.chain.then(() => this.recoverSerialized())
    this.chain = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async recoverSerialized(): Promise<AgentModelSelectionRecoveryResult> {
    const recovery = this.recovery
    if (!recovery) {
      return {
        ok: true,
        recoveryRequired: false,
        snapshot: null,
      }
    }
    if (this.options.hasInFlightWork?.()) {
      return {
        ok: false,
        error: '模型恢复需等待当前请求或回合结束。',
        stage: 'busy',
        retryable: true,
        recoveryRequired: true,
      }
    }
    try {
      const validated = await this.options.validateRecovery?.(
        recovery.previous,
        recovery.threadId,
      ) ?? {
        snapshot: recovery.previous,
        ...(recovery.threadId ? { threadId: recovery.threadId } : {}),
      }
      await this.options.prepareRecovery?.(validated.snapshot)
      await this.options.channelController.recover(validated.snapshot.channelId)
      await this.options.restoreSelection(validated.snapshot, validated.threadId)
      await this.options.refreshRecoveryCatalog?.(validated.snapshot)
      this.recovery = null
      return {
        ok: true,
        recoveryRequired: false,
        snapshot: validated.snapshot,
      }
    } catch (error) {
      const message = errorMessage(error)
      this.recovery = {
        ...recovery,
        error: `${recovery.error}; explicit recovery: ${message}`,
      }
      return {
        ok: false,
        error: message,
        stage: 'recovery',
        retryable: true,
        recoveryRequired: true,
      }
    }
  }

  private resolveRoute(gatewayId: string, modelId: string): AgentModelRoute {
    return this.options.resolveRoute?.(gatewayId, modelId)
      ?? resolveGatewayModelRoute(gatewayId, modelId)
  }

  private async applySerialized(
    payload: AgentModelSelectionApplyPayload,
    reservation: AgentModelSelectionIntentReservation,
  ): Promise<AgentModelSelectionApplyResult> {
    const previous = await this.options.getSnapshot(payload.threadId)
    const validationError = validatePayload(payload)
    if (validationError) {
      return this.failure(
        payload,
        previous,
        validationError,
        'configuration',
        'validate',
        false,
        false,
        { ok: true, snapshot: previous },
      )
    }
    if (this.recovery) {
      return this.failure(
        payload,
        previous,
        `Model-selection recovery required: ${this.recovery.error}`,
        'transaction',
        'rollback',
        false,
        true,
        {
          ok: false,
          error: this.recovery.error,
          effectiveSnapshot: null,
        },
      )
    }
    if (payload.threadId && previous.thread?.exists === false) {
      return this.failure(
        payload,
        previous,
        `Target thread not found: ${payload.threadId}`,
        'configuration',
        'validate',
        false,
        false,
        { ok: true, snapshot: previous },
      )
    }
    if (this.isSuperseded(reservation)) {
      return this.superseded(payload, previous)
    }

    let route: AgentModelRoute
    let effectivePayload = payload
    try {
      if (!this.catalogIsCurrent(payload)) {
        return this.failure(
          payload,
          previous,
          '模型目录已更新，请重新选择。',
          'configuration',
          'catalog',
          false,
          false,
          { ok: true, snapshot: previous },
        )
      }
      route = this.resolveRoute(payload.gatewayId, payload.modelId)
      const contextWindow = this.options.resolveContext?.(
        payload,
        previous,
        route,
      ) ?? payload.contextWindow
      effectivePayload = { ...payload, contextWindow }
      const effectiveValidationError = validatePayload(effectivePayload)
      if (effectiveValidationError) {
        return this.failure(
          payload,
          previous,
          effectiveValidationError,
          'configuration',
          'validate',
          false,
          false,
          { ok: true, snapshot: previous },
        )
      }
      const catalogValidationError = this.options.validateIntent?.(
        effectivePayload,
        route,
      )
      if (catalogValidationError) {
        return this.failure(
          payload,
          previous,
          catalogValidationError,
          'configuration',
          'catalog',
          false,
          false,
          { ok: true, snapshot: previous },
        )
      }
    } catch (error) {
      return this.failure(
        payload,
        previous,
        errorMessage(error),
        classifySelectionError(error),
        'validate',
        false,
        false,
        { ok: true, snapshot: previous },
      )
    }

    const channelChanged = previous.channelId !== route.channelId
    const contextChanged =
      previous.contextWindow !== effectivePayload.contextWindow
    if (
      (channelChanged || contextChanged)
      && this.options.hasInFlightWork?.()
    ) {
      return this.failure(
        payload,
        previous,
        '模型或 Context 切换需等待当前回合结束。',
        'transient',
        'busy',
        true,
        false,
        { ok: true, snapshot: previous },
      )
    }

    if (
      previous.gatewayId === effectivePayload.gatewayId
      && previous.channelId === route.channelId
      && previous.modelId === route.modelId
      && (
        !payload.threadId
        || previous.thread === undefined
        || (
          previous.thread.exists
          && previous.thread.model === route.modelId
        )
      )
      && previous.contextWindow === effectivePayload.contextWindow
      && previous.catalogRevision === effectivePayload.catalogRevision
    ) {
      return {
        ok: true,
        data: {
          ...previous,
          requestVersion: effectivePayload.requestVersion,
        },
      }
    }

    let stage: AgentModelSelectionStage = 'restart'
    try {
      await this.options.channelController.apply(route.channelId)
      if (contextChanged) {
        await this.options.applyContext(
          effectivePayload.contextWindow,
          reservation.sequence,
        )
      }
      if (this.isSuperseded(reservation)) {
        return this.rollbackSuperseded(
          payload,
          previous,
          contextChanged,
          reservation.sequence,
        )
      }
      if (!this.catalogIsCurrent(effectivePayload)) {
        return this.rollbackFailure(
          payload,
          previous,
          '模型目录在运行时切换期间发生变化。',
          'configuration',
          'catalog',
          contextChanged,
          reservation.sequence,
        )
      }

      let threadRestored = false
      if (payload.threadId && (channelChanged || contextChanged)) {
        stage = 'resume'
        await this.options.resumeThread(payload.threadId)
        threadRestored = true
      }
      if (this.isSuperseded(reservation)) {
        return this.rollbackSuperseded(
          payload,
          previous,
          contextChanged,
          reservation.sequence,
        )
      }
      if (threadRestored && !this.catalogIsCurrent(effectivePayload)) {
        return this.rollbackFailure(
          payload,
          previous,
          '模型目录在线程恢复期间发生变化。',
          'configuration',
          'catalog',
          contextChanged,
          reservation.sequence,
        )
      }

      const snapshot: AgentModelSelectionSnapshot = {
        gatewayId: effectivePayload.gatewayId.trim(),
        channelId: route.channelId,
        modelId: route.modelId,
        ...(payload.threadId
          ? { thread: { exists: true as const, model: route.modelId } }
          : {}),
        contextWindow: effectivePayload.contextWindow,
        autoCompactTokenLimit: modelAutoCompactTokenLimit(
          effectivePayload.contextWindow,
        ),
        catalogRevision: effectivePayload.catalogRevision,
        backendEpoch: this.options.backendEpoch(),
        threadRestored,
      }
      stage = 'persist'
      await this.options.persistSelection(snapshot, payload.threadId)
      if (this.isSuperseded(reservation)) {
        return this.rollbackSuperseded(
          payload,
          previous,
          contextChanged,
          reservation.sequence,
        )
      }
      if (!this.catalogIsCurrent(effectivePayload)) {
        return this.rollbackFailure(
          payload,
          previous,
          '模型目录在持久化提交前发生变化。',
          'configuration',
          'verify',
          contextChanged,
          reservation.sequence,
        )
      }
      return {
        ok: true,
        data: { ...snapshot, requestVersion: payload.requestVersion },
      }
    } catch (error) {
      if (error instanceof ProviderChannelRecoveryError) {
        const rollback = await this.rollback(
          previous,
          payload.threadId,
          contextChanged,
          reservation.sequence,
          error,
        )
        return this.poisonedFailure(
          payload,
          previous,
          errorMessage(error),
          rollback,
        )
      }
      const failedStage = stage
      const rollback = await this.rollback(
        previous,
        payload.threadId,
        contextChanged,
        reservation.sequence,
      )
      if (!rollback.ok) {
        return this.poisonedFailure(
          payload,
          previous,
          errorMessage(error),
          rollback,
        )
      }
      return this.failure(
        payload,
        previous,
        errorMessage(error),
        classifySelectionError(error),
        failedStage,
        classifySelectionError(error) !== 'configuration',
        false,
        rollback,
      )
    }
  }

  private catalogIsCurrent(
    payload: AgentModelSelectionIntent,
  ): boolean {
    return this.options.catalogRevisionIsCurrent(
      payload.gatewayId,
      payload.catalogRevision,
    )
  }

  private isSuperseded(
    reservation: AgentModelSelectionIntentReservation,
  ): boolean {
    if (!reservation.accepted) return true
    return reservation.source === 'renderer-selection'
      && reservation.sequence < this.latestRendererIntentSequence
  }

  private async rollbackFailure(
    payload: AgentModelSelectionApplyPayload,
    previous: AgentModelSelectionSnapshot,
    error: string,
    kind: AgentModelSelectionErrorKind,
    stage: AgentModelSelectionStage,
    contextChanged: boolean,
    intentSequence: number,
  ): Promise<AgentModelSelectionApplyResult> {
    const rollback = await this.rollback(
      previous,
      payload.threadId,
      contextChanged,
      intentSequence,
    )
    if (!rollback.ok) {
      return this.poisonedFailure(payload, previous, error, rollback)
    }
    return this.failure(
      payload,
      previous,
      error,
      kind,
      stage,
      false,
      false,
      rollback,
    )
  }

  private async rollbackSuperseded(
    payload: AgentModelSelectionApplyPayload,
    previous: AgentModelSelectionSnapshot,
    contextChanged: boolean,
    intentSequence: number,
  ): Promise<AgentModelSelectionApplyResult> {
    const rollback = await this.rollback(
      previous,
      payload.threadId,
      contextChanged,
      intentSequence,
    )
    if (!rollback.ok) {
      return this.poisonedFailure(
        payload,
        previous,
        '模型选择已被更新的请求替代。',
        rollback,
      )
    }
    return this.failure(
      payload,
      previous,
      '模型选择已被更新的请求替代。',
      'transient',
      'rollback',
      true,
      false,
      rollback,
    )
  }

  private superseded(
    payload: AgentModelSelectionApplyPayload,
    previous: AgentModelSelectionSnapshot,
  ): AgentModelSelectionApplyResult {
    return this.failure(
      payload,
      previous,
      '模型选择已被更新的请求替代。',
      'transient',
      'rollback',
      true,
      false,
      { ok: true, snapshot: previous },
    )
  }

  private async rollback(
    previous: AgentModelSelectionSnapshot,
    threadId: string | undefined,
    contextChanged: boolean,
    intentSequence: number,
    recoveryError?: ProviderChannelRecoveryError,
  ): Promise<Extract<AgentModelSelectionApplyResult, { ok: false }>['rollback']> {
    const failures: string[] = []
    if (recoveryError) {
      failures.push(errorMessage(recoveryError))
    } else if (contextChanged) {
      try {
        await this.options.applyContext(
          previous.contextWindow,
          intentSequence,
        )
      } catch (error) {
        failures.push(`context: ${errorMessage(error)}`)
      }
    }
    if (!recoveryError) {
      try {
        await this.options.channelController.restore(previous.channelId)
      } catch (error) {
        failures.push(`channel: ${errorMessage(error)}`)
      }
    }
    try {
      await this.options.restoreSelection(previous, threadId)
    } catch (error) {
      failures.push(`persist: ${errorMessage(error)}`)
    }
    return failures.length === 0
      ? { ok: true, snapshot: previous }
      : { ok: false, error: failures.join('; '), effectiveSnapshot: null }
  }

  private poisonedFailure(
    payload: AgentModelSelectionApplyPayload,
    previous: AgentModelSelectionSnapshot,
    error: string,
    rollback: Extract<
      AgentModelSelectionApplyResult,
      { ok: false }
    >['rollback'],
  ): AgentModelSelectionApplyResult {
    const rollbackError = rollback.ok ? error : rollback.error
    const combinedError = rollback.ok
      ? error
      : `${error}; rollback: ${rollback.error}`
    this.recovery = {
      previous,
      ...(payload.threadId ? { threadId: payload.threadId } : {}),
      error: combinedError,
    }
    return this.failure(
      payload,
      previous,
      combinedError,
      'transaction',
      'rollback',
      false,
      true,
      rollback.ok
        ? { ok: false, error: rollbackError, effectiveSnapshot: null }
        : rollback,
    )
  }

  private failure(
    payload: AgentModelSelectionApplyPayload,
    previous: AgentModelSelectionSnapshot,
    error: string,
    kind: AgentModelSelectionErrorKind,
    stage: AgentModelSelectionStage,
    retryable: boolean,
    recoveryRequired: boolean,
    rollback: Extract<
      AgentModelSelectionApplyResult,
      { ok: false }
    >['rollback'],
  ): AgentModelSelectionApplyResult {
    return {
      ok: false,
      error,
      kind,
      stage,
      retryable,
      recoveryRequired,
      requestVersion: payload.requestVersion,
      previous,
      rollback,
    }
  }
}

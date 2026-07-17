import { modelAutoCompactTokenLimit } from '../../shared/modelSettings'
import type {
  AgentModelRoute,
  AgentModelSelectionApplyPayload,
  AgentModelSelectionApplyResult,
  AgentModelSelectionErrorKind,
  AgentModelSelectionIntent,
  AgentModelSelectionSnapshot,
  AgentModelSelectionStage,
} from '../../types/agent'
import { resolveGatewayModelRoute } from './gatewayModelRouting'
import type { ProviderChannelController } from './ProviderChannelController'

export interface AgentModelSelectionCoordinatorOptions {
  channelController: ProviderChannelController
  getSnapshot: () => AgentModelSelectionSnapshot
  catalogRevisionIsCurrent: (gatewayId: string, revision: string) => boolean
  applyContext: (contextWindow: number) => Promise<void>
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
  /** Optional route injection for catalog-authorized custom Gateways. */
  resolveRoute?: (gatewayId: string, modelId: string) => AgentModelRoute
  /** Optional catalog-backed validation beyond revision equality. */
  validateIntent?: (
    payload: AgentModelSelectionApplyPayload,
    route: AgentModelRoute,
  ) => string | null
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

/**
 * Applies model-driven Channel and context transitions atomically.
 *
 * The coordinator owns request ordering and compensation. Its dependencies own
 * the concrete Channel restart and durable persistence implementations.
 */
export class AgentModelSelectionCoordinator {
  private latestRequestVersion = 0
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly options: AgentModelSelectionCoordinatorOptions,
  ) {}

  /**
   * Records a model-selection intent before an external lifecycle queue starts.
   * This prevents a queued older request from committing after a newer click.
   */
  noteRequestVersion(requestVersion: number): void {
    if (Number.isSafeInteger(requestVersion) && requestVersion >= 0) {
      this.latestRequestVersion = Math.max(
        this.latestRequestVersion,
        requestVersion,
      )
    }
  }

  /** Queues one atomic Gateway/model/context selection request. */
  apply(
    payload: AgentModelSelectionApplyPayload,
  ): Promise<AgentModelSelectionApplyResult> {
    this.noteRequestVersion(payload.requestVersion)
    const operation = this.chain.then(() => this.applySerialized(payload))
    this.chain = operation.then(() => undefined, () => undefined)
    return operation
  }

  /**
   * Ensures a requested turn cannot reach a Channel that belongs to another
   * Gateway, model family, context window, or catalog revision.
   */
  ensureForTurn(
    intent: AgentModelSelectionIntent,
  ): Promise<AgentModelSelectionApplyResult> {
    const previous = this.options.getSnapshot()
    let route: AgentModelRoute
    try {
      route = this.resolveRoute(intent.gatewayId, intent.modelId)
    } catch (error) {
      return Promise.resolve(this.failure(
        { ...intent, requestVersion: this.latestRequestVersion },
        previous,
        errorMessage(error),
        'configuration',
        'validate',
        false,
        { ok: true, snapshot: previous },
      ))
    }
    if (
      previous.gatewayId === intent.gatewayId
      && previous.channelId === route.channelId
      && previous.modelId === route.modelId
      && previous.contextWindow === intent.contextWindow
      && previous.catalogRevision === intent.catalogRevision
    ) {
      return Promise.resolve({
        ok: true,
        data: {
          ...previous,
          requestVersion: this.latestRequestVersion,
        },
      })
    }
    return this.apply({
      ...intent,
      requestVersion: this.latestRequestVersion + 1,
    })
  }

  private resolveRoute(gatewayId: string, modelId: string): AgentModelRoute {
    return this.options.resolveRoute?.(gatewayId, modelId)
      ?? resolveGatewayModelRoute(gatewayId, modelId)
  }

  private async applySerialized(
    payload: AgentModelSelectionApplyPayload,
  ): Promise<AgentModelSelectionApplyResult> {
    const previous = this.options.getSnapshot()
    const validationError = validatePayload(payload)
    if (validationError) {
      return this.failure(
        payload,
        previous,
        validationError,
        'configuration',
        'validate',
        false,
        { ok: true, snapshot: previous },
      )
    }
    if (payload.requestVersion !== this.latestRequestVersion) {
      return this.superseded(payload, previous)
    }

    let route: AgentModelRoute
    try {
      if (
        !this.options.catalogRevisionIsCurrent(
          payload.gatewayId,
          payload.catalogRevision,
        )
      ) {
        return this.failure(
          payload,
          previous,
          '模型目录已更新，请重新选择。',
          'configuration',
          'catalog',
          false,
          { ok: true, snapshot: previous },
        )
      }
      route = this.resolveRoute(payload.gatewayId, payload.modelId)
      const catalogValidationError = this.options.validateIntent?.(payload, route)
      if (catalogValidationError) {
        return this.failure(
          payload,
          previous,
          catalogValidationError,
          'configuration',
          'catalog',
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
        { ok: true, snapshot: previous },
      )
    }

    const contextChanged = previous.contextWindow !== payload.contextWindow
    let stage: AgentModelSelectionStage = 'restart'
    try {
      await this.options.channelController.apply(route.channelId)
      if (contextChanged) {
        await this.options.applyContext(payload.contextWindow)
      }
      if (payload.requestVersion !== this.latestRequestVersion) {
        return this.rollbackSuperseded(payload, previous, contextChanged)
      }

      let threadRestored = false
      if (payload.threadId) {
        stage = 'resume'
        await this.options.resumeThread(payload.threadId)
        threadRestored = true
      }
      if (payload.requestVersion !== this.latestRequestVersion) {
        return this.rollbackSuperseded(payload, previous, contextChanged)
      }

      const snapshot: AgentModelSelectionSnapshot = {
        gatewayId: payload.gatewayId.trim(),
        channelId: route.channelId,
        modelId: route.modelId,
        contextWindow: payload.contextWindow,
        autoCompactTokenLimit: modelAutoCompactTokenLimit(payload.contextWindow),
        catalogRevision: payload.catalogRevision,
        backendEpoch: this.options.backendEpoch(),
        threadRestored,
      }
      stage = 'persist'
      await this.options.persistSelection(snapshot, payload.threadId)
      if (payload.requestVersion !== this.latestRequestVersion) {
        return this.rollbackSuperseded(payload, previous, contextChanged)
      }
      return {
        ok: true,
        data: { ...snapshot, requestVersion: payload.requestVersion },
      }
    } catch (error) {
      const failedStage = stage
      const rollback = await this.rollback(previous, payload.threadId, contextChanged)
      return this.failure(
        payload,
        previous,
        errorMessage(error),
        classifySelectionError(error),
        failedStage,
        classifySelectionError(error) !== 'configuration',
        rollback,
      )
    }
  }

  private async rollbackSuperseded(
    payload: AgentModelSelectionApplyPayload,
    previous: AgentModelSelectionSnapshot,
    contextChanged: boolean,
  ): Promise<AgentModelSelectionApplyResult> {
    const rollback = await this.rollback(previous, payload.threadId, contextChanged)
    return this.failure(
      payload,
      previous,
      '模型选择已被更新的请求替代。',
      'transient',
      'rollback',
      true,
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
      { ok: true, snapshot: previous },
    )
  }

  private async rollback(
    previous: AgentModelSelectionSnapshot,
    threadId: string | undefined,
    contextChanged: boolean,
  ): Promise<Extract<AgentModelSelectionApplyResult, { ok: false }>['rollback']> {
    const failures: string[] = []
    if (contextChanged) {
      try {
        await this.options.applyContext(previous.contextWindow)
      } catch (error) {
        failures.push(`context: ${errorMessage(error)}`)
      }
    }
    try {
      await this.options.channelController.restore(previous.channelId)
    } catch (error) {
      failures.push(`channel: ${errorMessage(error)}`)
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

  private failure(
    payload: AgentModelSelectionApplyPayload,
    previous: AgentModelSelectionSnapshot,
    error: string,
    kind: AgentModelSelectionErrorKind,
    stage: AgentModelSelectionStage,
    retryable: boolean,
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
      requestVersion: payload.requestVersion,
      previous,
      rollback,
    }
  }
}

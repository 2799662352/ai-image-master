import type {
  AgentModelContextApplyPayload,
  AgentModelContextApplyResult,
  AgentModelContextSnapshotResult,
  AgentModelSelectionApplyPayload,
  AgentModelSelectionApplyResult,
  AgentModelSelectionErrorKind,
  AgentModelSelectionSnapshot,
  AgentModelSettingsCatalog,
  AgentModelSettingsCatalogResult,
} from '../../../../types/agent'
import type { PlanReasoningEffort } from '../../../../shared/collaborationMode'
import { resolveModelSelection } from './models'

/** v2 canonical selected-model boundary (owned by the routing slice). */
export const CANONICAL_SELECTED_MODEL_STORAGE_KEY = 'agent.selectedModel:v2'
/** Per-model context-window memory persisted across sessions. */
export const MODEL_CONTEXT_STORAGE_KEY = 'agent.modelContextByModel:v1'

/** Sticky per-kind persistence warnings surfaced next to the model picker. */
export type ModelSettingsPersistenceWarnings = Partial<Record<
  'model' | 'reasoning' | 'context',
  string
>>

/** Renderer-visible classification of one failed selection transaction. */
export interface ModelSelectionError {
  message: string
  kind: AgentModelSelectionErrorKind
  retryable: boolean
}

/** State owned by the model routing slice (selection/catalog/context). */
export interface ModelRoutingSliceState {
  selectedModelId: string
  modelSettingsCatalog?: AgentModelSettingsCatalog
  modelSettingsLoading: boolean
  modelSettingsError?: string
  /** Last main-confirmed Gateway/Channel/model/context selection. */
  modelSelectionSnapshot?: AgentModelSelectionSnapshot
  /** In-flight selection intent; UI treats it as "controls busy". */
  modelSelectionPending?: AgentModelSelectionApplyPayload
  /** Last failed selection intent, kept for `retryModelSelection()`. */
  modelSelectionFailedIntent?: AgentModelSelectionApplyPayload
  modelSelectionError?: ModelSelectionError
  /** Monotonic latest-wins owner for selection responses. */
  modelSelectionRequestSequence: number
}

/** Actions owned by the model routing slice. */
export interface ModelRoutingSliceActions {
  loadModelSettingsCatalog: (gatewayId?: string) => Promise<void>
  /**
   * Ask the main process to atomically apply a Gateway/model/context
   * selection. State commits ONLY after main confirms; on failure the old
   * model is kept and the intent is retryable. Resolves `true` when the
   * selection was confirmed and committed.
   */
  setSelectedModel: (modelId: string) => Promise<boolean>
  /** Re-run the last failed selection intent through `setSelectedModel`. */
  retryModelSelection: () => Promise<boolean>
  setModelContextWindow: (contextWindow: number) => Promise<boolean>
}

export type ModelRoutingSlice =
  & ModelRoutingSliceState
  & ModelRoutingSliceActions

/**
 * Host contract the slice needs from the owning store. Kept structural so
 * the slice never imports `AgentChatState` (no type cycle back into store).
 */
export interface ModelRoutingHost {
  threadId?: string
  activeModelContextWindow: number
  modelContextWindowByModel: Record<string, number>
  modelContextPending?: {
    model: string
    contextWindow: number
    requestVersion: number
  }
  /** Monotonic owner for model-context apply results. */
  modelContextRequestSequence: number
  /** Sticky fatal owner set when rollback cannot prove an effective backend config. */
  modelSettingsRecoveryRequired: boolean
  modelSettingsPersistenceWarnings: ModelSettingsPersistenceWarnings
  /** Invalidates older catalog/context bootstrap reads after Gateway changes. */
  modelSettingsLoadGeneration: number
  /** Monotonic request owner used to discard stale capability responses. */
  collaborationCapabilityRequestSequence: number
  /** Explicit Plan effort awaiting capabilities for one model/thread owner. */
  deferredPlanEffortIntent?: {
    model: string
    effort: Exclude<PlanReasoningEffort, 'auto'>
    threadId: string | undefined
  }
  invalidateCollaborationCapabilities: () => void
  loadCollaborationCapabilities: (gatewayId?: string) => Promise<void>
}

type ModelRoutingOwner = ModelRoutingSlice & ModelRoutingHost
type ModelRoutingSet = (
  partial:
    | Partial<ModelRoutingOwner>
    | ((state: ModelRoutingOwner) => Partial<ModelRoutingOwner>),
) => void
type ModelRoutingGet = () => ModelRoutingOwner

type ModelRoutingElectronApi = {
  agent?: {
    getModelSettingsCatalog?: () => Promise<AgentModelSettingsCatalogResult>
    getModelContextConfig?: () => Promise<AgentModelContextSnapshotResult>
    applyModelContext?: (
      payload: AgentModelContextApplyPayload,
    ) => Promise<AgentModelContextApplyResult>
    applyModelSelection?: (
      payload: AgentModelSelectionApplyPayload,
    ) => Promise<AgentModelSelectionApplyResult>
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** Rejects prototype-polluting keys before they reach persisted maps. */
export function isSafeModelSettingsKey(key: string): boolean {
  return (
    key.length > 0
    && key !== '__proto__'
    && key !== 'prototype'
    && key !== 'constructor'
  )
}

/** Persists the per-model context memory; `false` = session-only. */
export function persistModelContextWindows(
  contexts: Record<string, number>,
): boolean {
  try {
    const storage = globalThis.localStorage
    if (!storage) return false
    storage.setItem(MODEL_CONTEXT_STORAGE_KEY, JSON.stringify(contexts))
    return true
  } catch {
    // Storage is optional in private/restricted renderer contexts.
    return false
  }
}

/** Persists the canonical v2 selected-model id; `false` = session-only. */
export function persistCanonicalModelId(id: string): boolean {
  try {
    const storage = globalThis.localStorage
    if (!storage) return false
    storage.setItem(CANONICAL_SELECTED_MODEL_STORAGE_KEY, id)
    return true
  } catch {
    // localStorage unavailable (SSR / sandbox); silently ignore.
    return false
  }
}

/** Immutably sets/clears one persistence-warning kind. */
export function updateModelSettingsPersistenceWarning(
  current: ModelSettingsPersistenceWarnings,
  kind: keyof ModelSettingsPersistenceWarnings,
  warning: string | undefined,
): ModelSettingsPersistenceWarnings {
  const next = { ...current }
  if (warning) next[kind] = warning
  else delete next[kind]
  return next
}

let modelSettingsLoadInflight:
  | { generation: number; promise: Promise<void> }
  | undefined

interface ModelContextIntent {
  get: ModelRoutingGet
  set: ModelRoutingSet
  model: string
  contextWindow: number
  requestVersion: number
  ownerGeneration: number
  threadId?: string
  resolve: (applied: boolean) => void
}

let activeModelContextIntent: ModelContextIntent | undefined
let queuedModelContextIntent: ModelContextIntent | undefined

/**
 * Cancels the queued (not yet started) context intent. Called by the host's
 * `invalidateCollaborationCapabilities` when the Gateway changes so an
 * old-Gateway intent never runs against the new catalog owner.
 */
export function cancelQueuedModelContextIntent(): void {
  queuedModelContextIntent?.resolve(false)
  queuedModelContextIntent = undefined
}

function reconcileModelSettingsAfterStaleIntent(
  get: ModelRoutingGet,
): void {
  const generation = get().modelSettingsLoadGeneration
  const currentLoad =
    modelSettingsLoadInflight?.generation === generation
      ? modelSettingsLoadInflight.promise
      : undefined
  void (async () => {
    try {
      await currentLoad
    } catch {
      // A fresh authoritative read below owns reconciliation diagnostics.
    }
    const state = get()
    if (state.modelSettingsLoadGeneration !== generation) return
    await state.loadModelSettingsCatalog()
  })()
}

/** Formats one failed Context apply for the settings error banner. */
export function formatContextApplyError(
  result: Extract<AgentModelContextApplyResult, { ok: false }>,
): string {
  if (result.rollback.ok) {
    return `Context 应用失败：${result.error}；已恢复原 Context。`
  }
  return `Context 应用失败：${result.error}；回滚失败：${result.rollback.error}；`
    + '请手动重启 Agent Workspace/Codex。'
}

async function applyModelContextForModel(
  get: ModelRoutingGet,
  set: ModelRoutingSet,
  model: string,
  contextWindow: number,
  explicit = false,
): Promise<boolean> {
  if (
    !isSafeModelSettingsKey(model)
    || !Number.isSafeInteger(contextWindow)
    || contextWindow <= 0
  ) {
    set((state) =>
      state.modelSettingsRecoveryRequired
        ? {}
        : { modelSettingsError: 'Context 参数无效。' })
    return false
  }

  const owner = get()
  if (owner.modelSettingsRecoveryRequired && !explicit) return false
  const requestVersion = owner.modelContextRequestSequence + 1
  const pending = { model, contextWindow, requestVersion }
  set({
    modelContextPending: pending,
    modelContextRequestSequence: requestVersion,
    ...(owner.modelSettingsRecoveryRequired
      ? {}
      : { modelSettingsError: undefined }),
  })

  return new Promise<boolean>((resolve) => {
    const intent: ModelContextIntent = {
      get,
      set,
      model,
      contextWindow,
      requestVersion,
      ownerGeneration: owner.modelSettingsLoadGeneration,
      ...(owner.threadId ? { threadId: owner.threadId } : {}),
      resolve,
    }
    if (activeModelContextIntent) {
      queuedModelContextIntent?.resolve(false)
      queuedModelContextIntent = intent
      return
    }
    activeModelContextIntent = intent
    void drainModelContextIntents()
  })
}

async function executeModelContextIntent(
  intent: ModelContextIntent,
): Promise<{ applied: boolean; fatal: boolean; ownerStale: boolean }> {
  const {
    set,
    model,
    contextWindow,
    requestVersion,
    ownerGeneration,
    threadId,
  } = intent
  set((state) =>
    state.modelSettingsLoadGeneration !== ownerGeneration
    || state.modelSettingsRecoveryRequired
      ? {}
      : { modelSettingsError: undefined })
  const apply = (window as Window & { electronAPI?: ModelRoutingElectronApi })
    .electronAPI?.agent?.applyModelContext
  if (!apply) {
    let ownerStale = false
    set((state) => {
      if (state.modelSettingsLoadGeneration !== ownerGeneration) {
        ownerStale = true
        return {}
      }
      return {
        ...(state.modelContextPending?.requestVersion === requestVersion
          ? { modelContextPending: undefined }
          : {}),
        ...(state.modelSettingsRecoveryRequired
          ? {}
          : { modelSettingsError: 'Electron Context API 不可用。' }),
      }
    })
    return { applied: false, fatal: false, ownerStale }
  }

  let result: AgentModelContextApplyResult
  try {
    result = await apply({
      ...(threadId ? { threadId } : {}),
      model,
      contextWindow,
      requestVersion,
    })
  } catch (error) {
    let ownerStale = false
    set((state) => {
      if (state.modelSettingsLoadGeneration !== ownerGeneration) {
        ownerStale = true
        return {}
      }
      return {
        ...(state.modelContextPending?.requestVersion === requestVersion
          ? { modelContextPending: undefined }
          : {}),
        ...(state.modelSettingsRecoveryRequired
          ? {}
          : {
              modelSettingsError:
                error instanceof Error ? error.message : String(error),
            }),
      }
    })
    return { applied: false, fatal: false, ownerStale }
  }

  const resultVersion = result.ok
    ? result.data.requestVersion
    : result.requestVersion
  if (resultVersion !== requestVersion) {
    let ownerStale = false
    set((state) => {
      if (state.modelSettingsLoadGeneration !== ownerGeneration) {
        ownerStale = true
        return {}
      }
      return {
        ...(state.modelContextPending?.requestVersion === requestVersion
          ? { modelContextPending: undefined }
          : {}),
        ...(state.modelSettingsRecoveryRequired
          ? {}
          : { modelSettingsError: 'Context 响应版本不匹配，请重试。' }),
      }
    })
    return { applied: false, fatal: false, ownerStale }
  }

  let applied = false
  let fatal = false
  let ownerStale = false
  set((state) => {
    if (state.modelSettingsLoadGeneration !== ownerGeneration) {
      ownerStale = true
      if (result.ok) {
        return { activeModelContextWindow: result.data.contextWindow }
      }
      return result.rollback.ok
        ? {
            activeModelContextWindow:
              result.rollback.activeConfig.modelContextWindow,
          }
        : {}
    }
    const ownsPending =
      state.modelContextPending?.requestVersion === requestVersion
    if (!result.ok) {
      const rollbackFailed =
        !result.rollback.ok && result.rollback.effectiveConfig === null
      fatal = rollbackFailed
      return {
        ...(ownsPending || rollbackFailed
          ? { modelContextPending: undefined }
          : {}),
        ...(result.rollback.ok
          ? {
              activeModelContextWindow:
                result.rollback.activeConfig.modelContextWindow,
            }
          : {}),
        modelSettingsRecoveryRequired:
          state.modelSettingsRecoveryRequired || rollbackFailed,
        ...(state.modelSettingsRecoveryRequired
          ? {}
          : { modelSettingsError: formatContextApplyError(result) }),
      }
    }

    applied = true
    const modelContextWindowByModel = {
      ...state.modelContextWindowByModel,
      [model]: result.data.contextWindow,
    }
    const persisted = persistModelContextWindows(modelContextWindowByModel)
    return {
      activeModelContextWindow: result.data.contextWindow,
      modelContextWindowByModel,
      ...(ownsPending ? { modelContextPending: undefined } : {}),
      modelSettingsRecoveryRequired: false,
      modelSettingsError: undefined,
      modelSettingsPersistenceWarnings: updateModelSettingsPersistenceWarning(
        state.modelSettingsPersistenceWarnings,
        'context',
        persisted
          ? undefined
          : 'Context 设置仅本次会话有效，未能持久化。',
      ),
    }
  })
  return { applied, fatal, ownerStale }
}

async function drainModelContextIntents(): Promise<void> {
  while (activeModelContextIntent) {
    const intent = activeModelContextIntent
    const outcome = await executeModelContextIntent(intent)
    intent.resolve(outcome.applied)
    if (outcome.ownerStale) {
      reconcileModelSettingsAfterStaleIntent(intent.get)
    }
    if (outcome.fatal) {
      queuedModelContextIntent?.resolve(false)
      queuedModelContextIntent = undefined
      activeModelContextIntent = undefined
      return
    }
    // Let a model-switch caller commit the successfully applied model before
    // the next queued Context IPC starts against that confirmed UI state.
    await Promise.resolve()
    activeModelContextIntent = queuedModelContextIntent
    queuedModelContextIntent = undefined
  }
}

function createCatalogLoader(
  set: ModelRoutingSet,
  get: ModelRoutingGet,
): ModelRoutingSliceActions['loadModelSettingsCatalog'] {
  return (gatewayId) => {
    const loadOwner = get()
    const generation = loadOwner.modelSettingsLoadGeneration
    const contextRequestSequence = loadOwner.modelContextRequestSequence
    const contextPendingAtLoad = loadOwner.modelContextPending?.requestVersion
    if (modelSettingsLoadInflight?.generation === generation) {
      return modelSettingsLoadInflight.promise
    }

    const promise = (async () => {
      set((state) =>
        state.modelSettingsLoadGeneration === generation
          ? { modelSettingsLoading: true }
          : {})
      const agent = (window as Window & { electronAPI?: ModelRoutingElectronApi })
        .electronAPI?.agent
      const invoke = <T>(operation: (() => Promise<T>) | undefined, label: string): Promise<T> => {
        if (!operation) return Promise.reject(new Error(`${label} API unavailable`))
        try {
          return Promise.resolve(operation())
        } catch (error) {
          return Promise.reject(error)
        }
      }
      const safeInvoke = async <T>(
        operation: (() => Promise<T>) | undefined,
        label: string,
      ): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
        try {
          return { ok: true, value: await invoke(operation, label) }
        } catch (error) {
          return { ok: false, error: errorMessage(error) }
        }
      }
      const [catalogResult, snapshotResult] = await Promise.all([
        safeInvoke(agent?.getModelSettingsCatalog, 'Model settings catalog'),
        safeInvoke(agent?.getModelContextConfig, 'Model context snapshot'),
      ])
      if (get().modelSettingsLoadGeneration !== generation) return

      set((state) => {
        if (state.modelSettingsLoadGeneration !== generation) return {}
        const errors: string[] = []
        let modelSettingsCatalog = state.modelSettingsCatalog
        let activeModelContextWindow = state.activeModelContextWindow
        let snapshotRecoveryRequired = false
        let snapshotRecoveryError: string | undefined
        const contextOwnerStillCurrent =
          contextPendingAtLoad === undefined
          && state.modelContextRequestSequence === contextRequestSequence
          && state.modelContextPending === undefined

        if (!catalogResult.ok) {
          errors.push(catalogResult.error)
        } else if (!catalogResult.value.ok) {
          errors.push(catalogResult.value.error)
        } else {
          if (
            gatewayId !== undefined
            && catalogResult.value.data.gatewayId !== gatewayId
          ) {
            errors.push(
              `模型目录 Gateway 不匹配：期望 ${gatewayId}，收到 ${catalogResult.value.data.gatewayId}`,
            )
          } else {
            modelSettingsCatalog = catalogResult.value.data
          }
        }

        if (!snapshotResult.ok) {
          errors.push(snapshotResult.error)
        } else if (!snapshotResult.value.ok) {
          errors.push(snapshotResult.value.error)
        } else {
          if (contextOwnerStillCurrent) {
            activeModelContextWindow =
              snapshotResult.value.data.modelContextWindow
            snapshotRecoveryRequired =
              snapshotResult.value.data.recoveryRequired === true
            if (snapshotRecoveryRequired) {
              snapshotRecoveryError =
                snapshotResult.value.data.recoveryError
                || '上次 Context 回滚失败，请手动重启或重新应用。'
            }
          }
        }
        const loadError = errors.length > 0
          ? errors.join('；')
          : undefined
        const preserveCurrentError =
          state.modelSettingsRecoveryRequired || !contextOwnerStillCurrent
        const recoveryRequired =
          state.modelSettingsRecoveryRequired || snapshotRecoveryRequired
        const primaryError = snapshotRecoveryRequired
          ? snapshotRecoveryError
          : preserveCurrentError
            ? state.modelSettingsError
            : undefined
        const modelSettingsError = recoveryRequired || preserveCurrentError
          ? primaryError
            ? loadError && !primaryError.includes(loadError)
              ? `${primaryError}；模型设置加载错误：${loadError}`
              : primaryError
            : loadError
          : loadError

        return {
          modelSettingsCatalog,
          activeModelContextWindow,
          modelSettingsLoading: false,
          modelSettingsRecoveryRequired: recoveryRequired,
          modelSettingsError,
        }
      })
    })()
    modelSettingsLoadInflight = { generation, promise }
    void promise.finally(() => {
      if (modelSettingsLoadInflight?.promise === promise) {
        modelSettingsLoadInflight = undefined
      }
    })
    return promise
  }
}

function createContextApplier(
  set: ModelRoutingSet,
  get: ModelRoutingGet,
): ModelRoutingSliceActions['setModelContextWindow'] {
  return async (contextWindow) => {
    const state = get()
    const model = resolveModelSelection(state.selectedModelId).model
    if (
      contextWindow === state.activeModelContextWindow
      && state.modelContextPending === undefined
      && !state.modelSettingsRecoveryRequired
    ) {
      set((current) => {
        const modelContextWindowByModel = {
          ...current.modelContextWindowByModel,
          [model]: contextWindow,
        }
        const persisted = persistModelContextWindows(modelContextWindowByModel)
        return {
          modelContextWindowByModel,
          modelSettingsPersistenceWarnings: updateModelSettingsPersistenceWarning(
            current.modelSettingsPersistenceWarnings,
            'context',
            persisted
              ? undefined
              : 'Context 设置仅本次会话有效，未能持久化。',
          ),
        }
      })
      return true
    }
    return applyModelContextForModel(get, set, model, contextWindow, true)
  }
}

/**
 * Builds the model routing slice. `initialSelectedModelId` is provided by the
 * host store's persisted-settings restore (legacy migration lives there).
 */
export function createModelRoutingSlice(
  set: ModelRoutingSet,
  get: ModelRoutingGet,
  options: { initialSelectedModelId: string },
): ModelRoutingSlice {
  return {
    selectedModelId: options.initialSelectedModelId,
    modelSettingsCatalog: undefined,
    modelSettingsLoading: false,
    modelSettingsError: undefined,
    modelSelectionSnapshot: undefined,
    modelSelectionPending: undefined,
    modelSelectionFailedIntent: undefined,
    modelSelectionError: undefined,
    modelSelectionRequestSequence: 0,

    setSelectedModel: async (modelId) => {
      const before = get()
      const catalog = before.modelSettingsCatalog
      const row = catalog?.models.find((candidate) => candidate.id === modelId)
      if (!catalog || !row || row.availability?.status !== 'available') {
        return false
      }

      const canonicalModel = resolveModelSelection(modelId).model
      const modelChanged =
        canonicalModel !== resolveModelSelection(before.selectedModelId).model
      if (modelChanged) {
        // Claim capability ownership before the async selection transaction.
        // Otherwise the previous model's delayed capability response could
        // consume a deferred Plan intent while the transition is in flight.
        set((state) => ({
          collaborationCapabilityRequestSequence:
            state.collaborationCapabilityRequestSequence + 1,
          deferredPlanEffortIntent: undefined,
        }))
      }

      const ownerGeneration = before.modelSettingsLoadGeneration
      const requestVersion = before.modelSelectionRequestSequence + 1
      const supportsWindow = (value: number | undefined): value is number =>
        value !== undefined
        && row.capabilities.contextOptions.some(
          (option) => option.value === value,
        )
      // Preserve the active Context when the target model supports it,
      // else fall back to the validated per-model memory, else the default.
      const contextWindow = supportsWindow(before.activeModelContextWindow)
        ? before.activeModelContextWindow
        : supportsWindow(before.modelContextWindowByModel[modelId])
          ? before.modelContextWindowByModel[modelId]
          : row.capabilities.defaultContextWindow
      const payload: AgentModelSelectionApplyPayload = {
        gatewayId: catalog.gatewayId,
        modelId,
        contextWindow,
        catalogRevision: catalog.revision,
        ...(before.threadId ? { threadId: before.threadId } : {}),
        requestVersion,
      }
      set({
        modelSelectionPending: payload,
        modelSelectionFailedIntent: undefined,
        modelSelectionError: undefined,
        modelSelectionRequestSequence: requestVersion,
      })

      const fail = (
        message: string,
        kind: AgentModelSelectionErrorKind,
        retryable: boolean,
      ): false => {
        // latest-wins: a newer request owns pending/error state now.
        if (get().modelSelectionRequestSequence !== requestVersion) return false
        set({
          modelSelectionPending: undefined,
          modelSelectionFailedIntent: payload,
          modelSelectionError: { message, kind, retryable },
        })
        // Re-own capabilities for the kept (old) model after the eager claim.
        void get().loadCollaborationCapabilities()
        return false
      }

      const apply = (window as Window & { electronAPI?: ModelRoutingElectronApi })
        .electronAPI?.agent?.applyModelSelection
      if (!apply) return fail('Electron 模型选择 API 不可用。', 'configuration', false)

      let result: AgentModelSelectionApplyResult
      try {
        result = await apply(payload)
      } catch (error) {
        return fail(errorMessage(error), 'transient', true)
      }

      if (get().modelSelectionRequestSequence !== requestVersion) return false
      if (get().modelSettingsLoadGeneration !== ownerGeneration) {
        // Gateway/catalog owner changed while in flight; the fresh catalog
        // load reconciles authoritative state, so drop this result silently.
        set((state) =>
          state.modelSelectionPending?.requestVersion === requestVersion
            ? { modelSelectionPending: undefined }
            : {})
        return false
      }
      if (!result.ok) return fail(result.error, result.kind, result.retryable)

      const confirmed = result.data
      const persisted = persistCanonicalModelId(confirmed.modelId)
      set((state) => {
        const modelContextWindowByModel = {
          ...state.modelContextWindowByModel,
          [confirmed.modelId]: confirmed.contextWindow,
        }
        const contextPersisted =
          persistModelContextWindows(modelContextWindowByModel)
        return {
          selectedModelId: confirmed.modelId,
          activeModelContextWindow: confirmed.contextWindow,
          modelContextWindowByModel,
          modelSelectionSnapshot: confirmed,
          modelSelectionPending: undefined,
          modelSelectionFailedIntent: undefined,
          modelSelectionError: undefined,
          ...(state.deferredPlanEffortIntent?.model !== confirmed.modelId
            ? { deferredPlanEffortIntent: undefined }
            : {}),
          // A confirmed transaction proves the effective backend config.
          modelSettingsRecoveryRequired: false,
          modelSettingsError: undefined,
          modelSettingsPersistenceWarnings: updateModelSettingsPersistenceWarning(
            updateModelSettingsPersistenceWarning(
              state.modelSettingsPersistenceWarnings,
              'model',
              persisted ? undefined : '模型设置仅本次会话有效，未能持久化。',
            ),
            'context',
            contextPersisted
              ? undefined
              : 'Context 设置仅本次会话有效，未能持久化。',
          ),
        }
      })
      void get().loadCollaborationCapabilities(confirmed.gatewayId)
      return true
    },

    retryModelSelection: async () => {
      const failedModel = get().modelSelectionFailedIntent?.modelId
      return failedModel !== undefined
        ? get().setSelectedModel(failedModel)
        : false
    },

    loadModelSettingsCatalog: createCatalogLoader(set, get),
    setModelContextWindow: createContextApplier(set, get),
  }
}

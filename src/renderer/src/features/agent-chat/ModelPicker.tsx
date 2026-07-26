import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import {
  CANONICAL_MODEL_SETTINGS_ROWS,
  isModelReasoningEffort,
  mergeModelSettingsCapabilities,
  type CanonicalModelTier,
  type ModelReasoningEffort,
} from '../../../../shared/modelSettings'
import type {
  AgentModelFamily,
  AgentModelRoute,
  AgentModelSettingsEntry,
} from '../../../../types/agent'
import {
  builtinGateways,
  inferModelFamily,
  ModelUnavailableInGatewayError,
  resolveAuthorizedGatewayModelRoute,
  type AuthorizedGatewayRouteContext,
} from '../../../../main/agent/gatewayModelRouting'
import { findModel } from './models'
import { ModelSettingsPanel } from './ModelSettingsPanel'
import { useAgentChatStore } from './store'

// XAI (Grok) renders above OPENAI by explicit user request — Grok is the
// headline channel on these gateways, so it gets the top slot in the picker.
// A family absent from this list is silently dropped from the picker (see the
// bucket build below), so every `AgentModelFamily` member must appear here.
const FAMILY_ORDER: readonly AgentModelFamily[] = [
  'xai',
  'openai',
  'anthropic',
  'other',
]

const FAMILY_LABEL: Record<AgentModelFamily, string> = {
  openai: 'OPENAI',
  xai: 'XAI',
  anthropic: 'ANTHROPIC',
  other: 'OTHER',
}

const DEFAULT_GATEWAY_ID = builtinGateways()[0]?.id ?? 'apiyi'

function gatewayDisplayName(gatewayId: string): string {
  return builtinGateways().find((gateway) => gateway.id === gatewayId)?.name
    ?? gatewayId
}

const TIER_BADGE: Record<CanonicalModelTier, string> = {
  Fast: 'text-emerald-300/90 bg-emerald-500/10 border-emerald-400/30',
  Medium: 'text-cyan-300/90 bg-cyan-500/10 border-cyan-400/30',
  High: 'text-amber-300/90 bg-amber-500/10 border-amber-400/30',
  'Extra High': 'text-fuchsia-300/90 bg-fuchsia-500/10 border-fuchsia-400/30',
}

const REASONING_LABELS: Record<ModelReasoningEffort, string> = {
  auto: 'Auto',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
}

interface PickerModel extends AgentModelSettingsEntry {
  label: string
  tier: CanonicalModelTier
}

interface ModelPickerProps {
  disabled?: boolean
}

/**
 * Resolves a picker row's route, or `undefined` when the gateway has no
 * channel for it.
 *
 * Only some gateways carry some families — Claude lives on Right.Codes and
 * nowhere else — and that shows up as `ModelUnavailableInGatewayError` for one
 * model rather than a failure of the whole gateway. Callers decide per row
 * whether to drop it or substitute something.
 */
function tryEntryRoute(
  gatewayId: string,
  routeSource: AuthorizedGatewayRouteContext['source'],
  modelId: string,
): AgentModelRoute | undefined {
  try {
    return resolveAuthorizedGatewayModelRoute({ source: routeSource, gatewayId }, modelId)
  } catch (error) {
    if (error instanceof ModelUnavailableInGatewayError) return undefined
    throw error
  }
}

function conservativeEntry(
  gatewayId: string,
  route: AgentModelRoute,
  row: {
    id: string
    displayName: string
    description: string
    isDefault: boolean
  },
): AgentModelSettingsEntry {
  const capabilities = mergeModelSettingsCapabilities({
    model: row.id,
    gatewayId: route.gatewayId,
    channelId: route.channelId,
    supportedReasoningEfforts: [],
  })
  return {
    ...row,
    hidden: false,
    family: route.family,
    route,
    availability: { status: 'available' },
    capabilities: {
      ...capabilities,
      contextOptions: capabilities.contextOptions.map((option) => ({
        ...option,
        conservative: true,
      })),
    },
  }
}

/**
 * Builds the offline fallback list, dropping rows this gateway cannot serve.
 *
 * The canonical directory spans every family we ship, so on a gateway without
 * a Claude channel those rows have nowhere to go. Skipping them mirrors what
 * the main-process catalog builder does with the same models.
 */
function conservativeFallbackRows(
  gatewayId: string,
  routeSource: AuthorizedGatewayRouteContext['source'],
): AgentModelSettingsEntry[] {
  const rows: AgentModelSettingsEntry[] = []
  for (const row of CANONICAL_MODEL_SETTINGS_ROWS) {
    const route = tryEntryRoute(gatewayId, routeSource, row.id)
    if (route) rows.push(conservativeEntry(gatewayId, route, row))
  }
  return rows
}

function pickerModel(row: AgentModelSettingsEntry): PickerModel {
  return {
    ...row,
    label: row.displayName,
    tier: findModel(row.id)?.tier ?? 'Medium',
  }
}

/**
 * Row for the currently selected model when the gateway's catalog has no
 * entry for it.
 *
 * The selection is persisted globally while catalogs are per gateway, so a
 * model picked on one gateway stays selected after switching to another that
 * cannot serve it (Claude selected on Right.Codes, then switch to API Yi).
 * That row still has to render — the user needs to see what is selected in
 * order to change it — so an unroutable model is pinned to the gateway's
 * default channel, which is also where main's send path would fall back.
 */
function unknownModel(
  id: string,
  gatewayId: string,
  routeSource: AuthorizedGatewayRouteContext['source'],
): PickerModel {
  const metadata = findModel(id)
  const route = tryEntryRoute(gatewayId, routeSource, id) ?? {
    gatewayId,
    channelId: builtinGateways().find((gateway) => gateway.id === gatewayId)
      ?.defaultChannelId ?? `${gatewayId}-standard`,
    modelId: id,
    family: inferModelFamily(id),
  }
  return pickerModel(conservativeEntry(gatewayId, route, {
    id,
    displayName: metadata?.label ?? `Unknown · ${id}`,
    description:
      metadata?.description
      ?? '当前 Provider 提供的未识别模型；能力采用保守默认。',
    isDefault: false,
  }))
}

function moveModelFocus(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  index: number,
  count: number,
  refs: { current: Array<HTMLButtonElement | null> },
): void {
  if (count === 0) return
  let target: number | null = null
  switch (event.key) {
    case 'ArrowUp':
      target = (index - 1 + count) % count
      break
    case 'ArrowDown':
      target = (index + 1) % count
      break
    case 'Home':
      target = 0
      break
    case 'End':
      target = count - 1
      break
    default:
      break
  }
  if (target === null) return
  event.preventDefault()
  refs.current[target]?.focus()
}

export function ModelPicker({ disabled }: ModelPickerProps) {
  const selectedModelId = useAgentChatStore((state) => state.selectedModelId)
  const catalog = useAgentChatStore((state) => state.modelSettingsCatalog)
  const modelReasoningEffortByModel = useAgentChatStore(
    (state) => state.modelReasoningEffortByModel,
  )
  const activeModelContextWindow = useAgentChatStore(
    (state) => state.activeModelContextWindow,
  )
  const modelContextPending = useAgentChatStore(
    (state) => state.modelContextPending,
  )
  const modelSettingsLoading = useAgentChatStore(
    (state) => state.modelSettingsLoading,
  )
  const modelSettingsError = useAgentChatStore((state) => state.modelSettingsError)
  const modelSettingsPersistenceWarnings = useAgentChatStore(
    (state) => state.modelSettingsPersistenceWarnings,
  )
  const isRunning = useAgentChatStore((state) => state.isRunning)
  const hasPendingCollabMode = useAgentChatStore((state) =>
    state.threadId
      ? state.collabModePendingByThread[state.threadId] !== undefined
      : false,
  )
  const setSelectedModel = useAgentChatStore((state) => state.setSelectedModel)
  const setModelReasoningEffort = useAgentChatStore(
    (state) => state.setModelReasoningEffort,
  )
  const setModelContextWindow = useAgentChatStore(
    (state) => state.setModelContextWindow,
  )
  const retryModelSelection = useAgentChatStore(
    (state) => state.retryModelSelection,
  )

  const modelSelectionPendingIntent = useAgentChatStore(
    (state) => state.modelSelectionPending,
  )
  const modelSelectionError = useAgentChatStore(
    (state) => state.modelSelectionError,
  )
  const storeSelectionPending = modelSelectionPendingIntent !== undefined
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [localSelectionPending, setModelSelectionPending] = useState(false)
  const modelSelectionPending = localSelectionPending || storeSelectionPending
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const modelRefs = useRef<Array<HTMLButtonElement | null>>([])
  const focusFrameRef = useRef<number | null>(null)

  const gatewayId = catalog?.gatewayId ?? DEFAULT_GATEWAY_ID
  const routeSource = catalog ? 'model-catalog' : 'builtin'
  const baseRows = useMemo(
    () => (
      catalog
        ? catalog.models
        : conservativeFallbackRows(gatewayId, routeSource)
    ).filter((row) => !row.hidden).map(pickerModel),
    [catalog, gatewayId, routeSource],
  )
  const selectedKnown = baseRows.find((model) => model.id === selectedModelId)
  const selected = useMemo(
    () => selectedKnown ?? unknownModel(selectedModelId, gatewayId, routeSource),
    [gatewayId, routeSource, selectedKnown, selectedModelId],
  )
  const availableModels = useMemo(
    () => selectedKnown ? baseRows : [selected, ...baseRows],
    [baseRows, selected, selectedKnown],
  )
  const reasoningEffort = modelReasoningEffortByModel[selectedModelId]
    ?? (
      isModelReasoningEffort(selected.capabilities.defaultReasoningEffort)
        ? selected.capabilities.defaultReasoningEffort
        : 'auto'
    )
  const reasoningLabel = REASONING_LABELS[reasoningEffort]
  const controlsDisabled =
    Boolean(disabled)
    || isRunning
    || hasPendingCollabMode
    || modelContextPending !== undefined
    || modelSelectionPending
  const settingsInteractionsDisabled = controlsDisabled || modelSettingsLoading
  const capabilitiesUnconfirmed =
    !catalog
    || catalog.source === 'fallback'
    || !selectedKnown

  const grouped = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    const filtered = normalizedQuery
      ? availableModels.filter((model) =>
          model.label.toLowerCase().includes(normalizedQuery)
          || model.id.toLowerCase().includes(normalizedQuery)
          || model.description.toLowerCase().includes(normalizedQuery))
      : availableModels
    const buckets = new Map<AgentModelFamily, PickerModel[]>(
      FAMILY_ORDER.map((family) => [family, []]),
    )
    for (const model of filtered) buckets.get(model.family)?.push(model)
    return FAMILY_ORDER
      .map((family) => ({ family, items: buckets.get(family) ?? [] }))
      .filter((group) => group.items.length > 0)
  }, [availableModels, query])
  const flatModels = grouped.flatMap((group) => group.items)
  const pendingModelLabel = modelSelectionPendingIntent
    ? availableModels.find(
        (model) => model.id === modelSelectionPendingIntent.modelId,
      )?.label ?? modelSelectionPendingIntent.modelId
    : undefined
  const persistenceWarning = Object.values(modelSettingsPersistenceWarnings)
    .filter((warning): warning is string => Boolean(warning))
    .join('；')
  const settingsMessage = [modelSettingsError, persistenceWarning]
    .filter((message): message is string => Boolean(message))
    .join('；') || undefined

  useLayoutEffect(() => {
    modelRefs.current.length = flatModels.length
  }, [flatModels.length])

  useEffect(() => () => {
    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current)
    }
  }, [])

  function scheduleTriggerFocus(): void {
    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current)
    }
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null
      if (triggerRef.current && !triggerRef.current.disabled) {
        triggerRef.current.focus()
      }
    })
  }

  function closePicker(restoreFocus: boolean, deferFocus = false): void {
    const activeElement = document.activeElement
    const focusOwned =
      activeElement instanceof Node
      && rootRef.current?.contains(activeElement) === true
    setIsOpen(false)
    setQuery('')
    if (
      restoreFocus
      && focusOwned
    ) {
      if (deferFocus) scheduleTriggerFocus()
      else if (triggerRef.current && !triggerRef.current.disabled) {
        triggerRef.current.focus()
      }
    }
  }

  useEffect(() => {
    if (!isOpen) return undefined
    function onOutsidePointerDown(event: PointerEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        closePicker(false)
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closePicker(true)
    }
    document.addEventListener('pointerdown', onOutsidePointerDown)
    document.addEventListener('keydown', onKeyDown)
    searchRef.current?.focus()
    return () => {
      document.removeEventListener('pointerdown', onOutsidePointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [isOpen])

  useEffect(() => {
    if (controlsDisabled && isOpen && !modelSelectionPending) closePicker(false)
  }, [controlsDisabled, isOpen, modelSelectionPending])

  async function handlePick(id: string): Promise<void> {
    if (settingsInteractionsDisabled || id === selectedModelId) return
    const target = availableModels.find((model) => model.id === id)
    if (target && target.availability.status !== 'available') return
    setModelSelectionPending(true)
    let selectionApplied = false
    try {
      selectionApplied = (await setSelectedModel(id)) === true
        || useAgentChatStore.getState().selectedModelId === id
    } finally {
      setModelSelectionPending(false)
    }
    if (selectionApplied) closePicker(true, true)
  }

  function handleRootBlur(event: ReactFocusEvent<HTMLDivElement>): void {
    const nextTarget = event.relatedTarget
    if (
      nextTarget instanceof Node
      && rootRef.current?.contains(nextTarget)
    ) return
    closePicker(false)
  }

  return (
    <div ref={rootRef} className="relative" onBlur={handleRootBlur}>
      <button
        ref={triggerRef}
        type="button"
        disabled={controlsDisabled}
        onClick={() => {
          if (isOpen) closePicker(true)
          else setIsOpen(true)
        }}
        className="flex items-center gap-1.5 rounded-md border border-zinc-700/80 bg-zinc-900/70 px-2 py-1 text-[11px] text-zinc-200 transition hover:border-cyan-400/40 hover:text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={`选择模型：${selected.label} · ${reasoningLabel}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        title={`${selected.label} · ${reasoningLabel}`}
      >
        <span className="font-medium">{selected.label}</span>
        <span
          className={`hidden rounded border px-1 text-[9px] uppercase tracking-wider sm:inline ${TIER_BADGE[selected.tier]}`}
        >
          {reasoningLabel}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 12 12"
          aria-hidden
          className={`opacity-70 transition ${isOpen ? 'rotate-180' : ''}`}
        >
          <path
            d="M2 4l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {isOpen ? (
        <div
          className="absolute bottom-full left-0 z-[40001] mb-2 w-[360px] overflow-hidden rounded-lg border border-cyan-400/25 bg-zinc-950/95 shadow-[0_24px_60px_rgba(0,0,0,0.6)] backdrop-blur"
        >
          <div className="border-b border-zinc-800/80 p-2">
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  modelRefs.current
                    .slice(0, flatModels.length)
                    .find((node) => node !== null)
                    ?.focus()
                }
              }}
              placeholder="Search models"
              aria-label="Search models"
              className="w-full rounded border border-zinc-800 bg-black/40 px-2 py-1 text-[12px] text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-cyan-400/40"
            />
            <div className="mt-1 px-1 text-[10px] text-zinc-500">
              Gateway · {gatewayDisplayName(gatewayId)}
            </div>
          </div>

          {capabilitiesUnconfirmed ? (
            <div
              role="status"
              className="border-b border-amber-300/15 bg-amber-300/[0.04] px-3 py-1.5 text-[9px] leading-4 text-amber-200/80"
            >
              模型可用性与能力未确认 · 当前目录使用保守默认，实时 Codex 能力恢复后会自动更新。
            </div>
          ) : null}

          <div
            role="listbox"
            aria-label="模型列表"
            aria-busy={modelSelectionPending || modelSettingsLoading}
            className="max-h-[210px] overflow-y-auto py-1"
          >
            {grouped.length === 0 ? (
              <div className="px-3 py-4 text-center text-[11px] text-zinc-500">
                No models match.
              </div>
            ) : (
              grouped.map((group) => (
                <div key={group.family} className="mb-1">
                  <div className="px-3 py-1 text-[9px] uppercase tracking-[0.18em] text-zinc-500">
                    {FAMILY_LABEL[group.family]}
                  </div>
                  {group.items.map((model) => {
                    const index = flatModels.findIndex((item) => item.id === model.id)
                    const isActive = model.id === selectedModelId
                    const unavailable = model.availability.status !== 'available'
                    const unavailableReason =
                      model.availability.status === 'available'
                        ? undefined
                        : model.availability.reason
                    return (
                      <button
                        key={model.id}
                        ref={(node) => {
                          modelRefs.current[index] = node
                        }}
                        type="button"
                        role="option"
                        aria-label={model.label}
                        aria-selected={isActive}
                        aria-disabled={unavailable || settingsInteractionsDisabled}
                        disabled={settingsInteractionsDisabled}
                        onClick={() => {
                          void handlePick(model.id)
                        }}
                        onKeyDown={(event) => {
                          moveModelFocus(event, index, flatModels.length, modelRefs)
                        }}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] transition disabled:cursor-wait disabled:opacity-60 ${
                          isActive
                            ? 'bg-cyan-500/10 text-cyan-100'
                            : unavailable
                              ? 'cursor-not-allowed text-zinc-500'
                              : 'text-zinc-200 hover:bg-zinc-800/60 hover:text-cyan-100'
                        }`}
                        title={model.description}
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium">{model.label}</span>
                          <span className="truncate text-[10px] text-zinc-500">{model.id}</span>
                          {unavailableReason ? (
                            <span className="truncate text-[10px] text-amber-300/80">
                              {unavailableReason}
                            </span>
                          ) : null}
                        </span>
                        <span
                          className={`rounded border px-1 py-[1px] text-[9px] uppercase tracking-wider ${TIER_BADGE[model.tier]}`}
                        >
                          {model.tier}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>

          {modelSelectionPendingIntent || modelSelectionError ? (
            <div className="flex items-center justify-between gap-2 border-t border-zinc-800/80 px-3 py-1.5">
              <div
                aria-live="polite"
                role="status"
                className={`min-w-0 truncate text-[10px] ${
                  modelSelectionPendingIntent
                    ? 'text-cyan-200/90'
                    : 'text-amber-200/90'
                }`}
              >
                {modelSelectionPendingIntent
                  ? `正在切换 ${pendingModelLabel} 通道…`
                  : modelSelectionError?.message}
              </div>
              {!modelSelectionPendingIntent
                && modelSelectionError?.retryable === true ? (
                <button
                  type="button"
                  onClick={() => {
                    void retryModelSelection()
                  }}
                  className="shrink-0 rounded border border-amber-400/40 px-1.5 py-0.5 text-[10px] text-amber-200 transition hover:bg-amber-400/10"
                >
                  重试
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="border-t border-zinc-800/80 p-2">
            <ModelSettingsPanel
              capabilities={selected.capabilities}
              reasoningEffort={reasoningEffort}
              contextWindow={activeModelContextWindow}
              disabled={
                Boolean(disabled)
                || isRunning
                || hasPendingCollabMode
                || modelSettingsLoading
              }
              pending={modelContextPending !== undefined || modelSelectionPending}
              error={settingsMessage}
              onReasoningChange={(effort) => {
                setModelReasoningEffort(selectedModelId, effort)
              }}
              onContextChange={setModelContextWindow}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}

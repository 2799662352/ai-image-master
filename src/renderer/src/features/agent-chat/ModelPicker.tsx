import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import {
  isPlanReasoningEffort,
  type PlanReasoningEffort,
} from '../../../../shared/collaborationMode'
import {
  AGENT_MODELS,
  findModel,
  resolveModelSelection,
  type ModelOption,
  type ModelTier,
} from './models'
import { useAgentChatStore } from './store'

const TIER_ORDER: ModelTier[] = ['Fast', 'Medium', 'High', 'Extra High']

const TIER_BADGE: Record<ModelTier, string> = {
  Fast: 'text-emerald-300/90 bg-emerald-500/10 border-emerald-400/30',
  Medium: 'text-cyan-300/90 bg-cyan-500/10 border-cyan-400/30',
  High: 'text-amber-300/90 bg-amber-500/10 border-amber-400/30',
  'Extra High': 'text-fuchsia-300/90 bg-fuchsia-500/10 border-fuchsia-400/30',
}

interface ModelPickerProps {
  disabled?: boolean
}

export function ModelPicker({ disabled }: ModelPickerProps) {
  const selectedModelId = useAgentChatStore((state) => state.selectedModelId)
  const collabModeKind = useAgentChatStore((state) => state.collabModeKind)
  const isRunning = useAgentChatStore((state) => state.isRunning)
  const hasPendingCollabMode = useAgentChatStore((state) =>
    state.threadId
      ? state.collabModePendingByThread[state.threadId] !== undefined
      : false,
  )
  const setSelectedModel = useAgentChatStore((state) => state.setSelectedModel)
  const setPlanReasoningEffort = useAgentChatStore(
    (state) => state.setPlanReasoningEffort,
  )

  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pendingOption, setPendingOption] = useState<ModelOption | null>(null)
  const [isApplying, setIsApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const planOnlyRef = useRef<HTMLButtonElement | null>(null)
  const isApplyingRef = useRef(false)
  const focusLeftRootDuringApplyRef = useRef(false)

  const selected = findModel(selectedModelId) ?? AGENT_MODELS[0]
  const controlsDisabled = Boolean(disabled) || isRunning || hasPendingCollabMode

  // Filter + group
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? AGENT_MODELS.filter(
          (m) =>
            m.label.toLowerCase().includes(q) ||
            m.id.toLowerCase().includes(q) ||
            m.description.toLowerCase().includes(q),
        )
      : [...AGENT_MODELS]

    const buckets = new Map<ModelTier, ModelOption[]>()
    for (const tier of TIER_ORDER) buckets.set(tier, [])
    for (const m of filtered) buckets.get(m.tier)?.push(m)
    return TIER_ORDER
      .map((tier) => ({ tier, items: buckets.get(tier) ?? [] }))
      .filter((g) => g.items.length > 0)
  }, [query])

  function closePicker(restoreFocus: boolean): void {
    const root = rootRef.current
    const trigger = triggerRef.current
    const activeElement = document.activeElement
    const focusStillOwned =
      activeElement instanceof Node
      && root?.contains(activeElement)

    setIsOpen(false)
    setPendingOption(null)
    setApplyError(null)
    setQuery('')

    if (
      restoreFocus
      && focusStillOwned
      && trigger
      && !trigger.disabled
    ) {
      trigger.focus()
    }
  }

  function returnToModelList(): void {
    setPendingOption(null)
    setApplyError(null)
  }

  // Close on outside pointerdown + Escape.
  useEffect(() => {
    if (!isOpen) return undefined
    function onOutsidePointerDown(event: PointerEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        if (isApplyingRef.current) {
          focusLeftRootDuringApplyRef.current = true
        }
        closePicker(false)
      }
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      if (pendingOption) {
        returnToModelList()
      } else {
        closePicker(true)
      }
    }
    document.addEventListener('pointerdown', onOutsidePointerDown)
    document.addEventListener('keydown', onKey)
    if (pendingOption) {
      planOnlyRef.current?.focus()
    } else {
      searchRef.current?.focus()
    }
    return () => {
      document.removeEventListener('pointerdown', onOutsidePointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [isOpen, pendingOption])

  useEffect(() => {
    if (controlsDisabled && isOpen) closePicker(false)
  }, [controlsDisabled, isOpen])

  function handlePick(id: string): void {
    if (controlsDisabled || isApplyingRef.current) return

    const current = resolveModelSelection(selectedModelId)
    const next = resolveModelSelection(id)
    const needsPlanScope =
      collabModeKind === 'plan'
      && current.model === next.model
      && current.reasoningEffort !== next.reasoningEffort

    if (needsPlanScope) {
      const option = findModel(id)
      if (option) {
        setApplyError(null)
        setPendingOption(option)
      }
      return
    }

    setSelectedModel(id)
    closePicker(true)
  }

  function planEffortFor(option: ModelOption): PlanReasoningEffort {
    const effort = resolveModelSelection(option.id).reasoningEffort
    return isPlanReasoningEffort(effort) ? effort : 'auto'
  }

  async function applyPendingOption(scope: 'plan' | 'all'): Promise<void> {
    if (
      !pendingOption
      || controlsDisabled
      || isApplyingRef.current
    ) {
      return
    }

    const option = pendingOption
    const rootAtSubmit = rootRef.current
    const activeAtSubmit = document.activeElement
    const focusOwnedAtSubmit =
      activeAtSubmit instanceof Node
      && rootAtSubmit?.contains(activeAtSubmit) === true
    isApplyingRef.current = true
    focusLeftRootDuringApplyRef.current = false
    setIsApplying(true)
    setApplyError(null)
    try {
      if (scope === 'plan') {
        await setPlanReasoningEffort(planEffortFor(option))
      } else {
        setSelectedModel(option.id)
        await setPlanReasoningEffort('auto')
      }
      const activeAtCompletion = document.activeElement
      const focusStillOwned =
        activeAtCompletion instanceof Node
        && rootRef.current?.contains(activeAtCompletion) === true
      closePicker(
        focusOwnedAtSubmit
        && !focusLeftRootDuringApplyRef.current
        && focusStillOwned,
      )
    } catch {
      setApplyError('应用模型范围失败，请重试。')
    } finally {
      isApplyingRef.current = false
      focusLeftRootDuringApplyRef.current = false
      setIsApplying(false)
    }
  }

  function handleScopeActionKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ): void {
    if (
      !isApplyingRef.current
      || (event.key !== 'Enter' && event.key !== ' ')
    ) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
  }

  function handleRootBlur(event: ReactFocusEvent<HTMLDivElement>): void {
    const nextTarget = event.relatedTarget
    if (
      nextTarget instanceof Node
      && rootRef.current?.contains(nextTarget)
    ) {
      return
    }
    if (isApplyingRef.current) {
      focusLeftRootDuringApplyRef.current = true
    }
    closePicker(false)
  }

  return (
    <div ref={rootRef} className="relative" onBlur={handleRootBlur}>
      <button
        ref={triggerRef}
        type="button"
        disabled={controlsDisabled}
        onClick={() => {
          if (isOpen) {
            closePicker(true)
          } else {
            setIsOpen(true)
          }
        }}
        className="flex items-center gap-1.5 rounded-md border border-zinc-700/80 bg-zinc-900/70 px-2 py-1 text-[11px] text-zinc-200 transition hover:border-cyan-400/40 hover:text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={`选择模型：${selected.label}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        title={`${selected.label} · ${selected.tier}`}
      >
        <span className="font-medium">{selected.label}</span>
        <span
          className={`hidden rounded border px-1 text-[9px] uppercase tracking-wider sm:inline ${TIER_BADGE[selected.tier]}`}
        >
          {selected.tier}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 12 12"
          aria-hidden
          className={`opacity-70 transition ${isOpen ? 'rotate-180' : ''}`}
        >
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {isOpen ? (
        <div
          role={pendingOption ? undefined : 'listbox'}
          aria-label={pendingOption ? undefined : '模型列表'}
          aria-busy={isApplying}
          className="absolute bottom-full left-0 z-[40001] mb-2 w-[300px] overflow-hidden rounded-lg border border-cyan-400/25 bg-zinc-950/95 shadow-[0_24px_60px_rgba(0,0,0,0.6)] backdrop-blur"
        >
          {pendingOption ? (
            <div role="group" aria-label="选择模型作用域">
              <div className="border-b border-zinc-800/80 px-3 py-2">
                <button
                  type="button"
                  aria-label="返回模型列表"
                  disabled={isApplying}
                  onClick={returnToModelList}
                  className="mb-2 flex items-center gap-1 text-[10px] text-zinc-400 transition hover:text-cyan-100 disabled:cursor-wait disabled:opacity-50"
                >
                  <span aria-hidden>←</span>
                  <span>返回</span>
                </button>
                <div className="text-[12px] font-medium text-cyan-100">选择应用范围</div>
                <p className="mt-1 text-[10px] leading-4 text-zinc-500">
                  {pendingOption.label} 与当前模型相同，仅推理强度不同。请选择这次调整的作用域。
                </p>
              </div>

              <div className="space-y-1 p-2">
                <button
                  ref={planOnlyRef}
                  type="button"
                  aria-label="仅 Plan"
                  aria-disabled={isApplying}
                  onClick={() => {
                    void applyPendingOption('plan')
                  }}
                  onKeyDown={handleScopeActionKeyDown}
                  className="flex w-full flex-col rounded-md border border-fuchsia-400/25 bg-fuchsia-500/10 px-3 py-2 text-left transition hover:border-fuchsia-300/50 hover:bg-fuchsia-500/15 focus:outline-none focus-visible:ring-1 focus-visible:ring-fuchsia-400/70 aria-disabled:pointer-events-none aria-disabled:cursor-wait aria-disabled:opacity-60"
                >
                  <span className="text-[12px] font-medium text-fuchsia-100">仅 Plan</span>
                  <span className="text-[10px] leading-4 text-zinc-500">
                    保留当前模型，只调整 Plan 推理强度
                  </span>
                </button>
                <button
                  type="button"
                  aria-label="所有模式"
                  aria-disabled={isApplying}
                  onClick={() => {
                    void applyPendingOption('all')
                  }}
                  onKeyDown={handleScopeActionKeyDown}
                  className="flex w-full flex-col rounded-md border border-zinc-700/80 bg-zinc-900/70 px-3 py-2 text-left transition hover:border-cyan-400/40 hover:bg-zinc-800/70 focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/70 aria-disabled:pointer-events-none aria-disabled:cursor-wait aria-disabled:opacity-60"
                >
                  <span className="text-[12px] font-medium text-zinc-100">所有模式</span>
                  <span className="text-[10px] leading-4 text-zinc-500">
                    更新模型选项，并将 Plan 专属强度重置为 Auto
                  </span>
                </button>
              </div>

              {applyError ? (
                <div role="alert" className="border-t border-rose-400/20 px-3 py-2 text-[10px] text-rose-300">
                  {applyError}
                </div>
              ) : null}
            </div>
          ) : (
            <>
              <div className="border-b border-zinc-800/80 p-2">
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search models"
                  className="w-full rounded border border-zinc-800 bg-black/40 px-2 py-1 text-[12px] text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-cyan-400/40"
                />
              </div>

              <div className="max-h-[320px] overflow-y-auto py-1">
                {grouped.length === 0 ? (
                  <div className="px-3 py-4 text-center text-[11px] text-zinc-500">No models match.</div>
                ) : (
                  grouped.map((group) => (
                    <div key={group.tier} className="mb-1">
                      <div className="px-3 py-1 text-[9px] uppercase tracking-[0.18em] text-zinc-500">
                        {group.tier}
                      </div>
                      {group.items.map((m) => {
                        const isActive = m.id === selectedModelId
                        return (
                          <button
                            key={m.id}
                            type="button"
                            role="option"
                            aria-label={m.label}
                            aria-selected={isActive}
                            disabled={controlsDisabled || isApplying}
                            onClick={() => {
                              handlePick(m.id)
                            }}
                            className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] transition disabled:cursor-wait disabled:opacity-60 ${
                              isActive
                                ? 'bg-cyan-500/10 text-cyan-100'
                                : 'text-zinc-200 hover:bg-zinc-800/60 hover:text-cyan-100'
                            }`}
                            title={m.description}
                          >
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate font-medium">{m.label}</span>
                              <span className="truncate text-[10px] text-zinc-500">{m.id}</span>
                            </span>
                            <span className="flex items-center gap-1.5">
                              <span
                                className={`rounded border px-1 py-[1px] text-[9px] uppercase tracking-wider ${TIER_BADGE[m.tier]}`}
                              >
                                {m.tier}
                              </span>
                              {isActive ? (
                                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                                  <path
                                    d="M2 6l3 3 5-6"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                    fill="none"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  />
                                </svg>
                              ) : null}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  ))
                )}
              </div>

              {applyError ? (
                <div role="alert" className="border-t border-rose-400/20 px-3 py-2 text-[10px] text-rose-300">
                  {applyError}
                </div>
              ) : null}

              <div className="border-t border-zinc-800/80 px-3 py-1.5 text-[10px] text-zinc-500">
                via API易 · base_url <code className="text-zinc-400">https://api.apiyi.com/v1</code>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

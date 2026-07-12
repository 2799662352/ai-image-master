import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import {
  normaliseSupportedPlanEfforts,
  type ConcretePlanReasoningEffort,
  type PlanReasoningEffort,
} from '../../../../shared/collaborationMode'
import { resolveModelSelection } from './models'
import {
  selectEffectivePlanReasoningEffort,
  useAgentChatStore,
} from './store'

interface CollabModeControlProps {
  disabled?: boolean
}

interface EffortOption {
  value: PlanReasoningEffort
  label: string
  description: string
}

const EFFORT_LABELS: Record<PlanReasoningEffort, string> = {
  auto: 'Auto',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

const EFFORT_DESCRIPTIONS: Record<ConcretePlanReasoningEffort, string> = {
  low: '更快，通常减少推理用量',
  medium: '平衡计划深度、用量与延迟',
  high: '更深入；可能增加用量与延迟',
  xhigh: '最深入；可能显著增加用量与延迟',
  max: '最大推理深度；仅在当前模型与 Provider 支持时可用',
}

const OPTION_KEYS = [
  'ArrowDown',
  'ArrowUp',
  'Home',
  'End',
  'Enter',
  'Escape',
] as const

type OptionKey = (typeof OPTION_KEYS)[number]

function isOptionKey(key: string): key is OptionKey {
  return (OPTION_KEYS as readonly string[]).includes(key)
}

export function CollabModeControl({ disabled = false }: CollabModeControlProps) {
  const isRunning = useAgentChatStore((state) => state.isRunning)
  const collabModeKind = useAgentChatStore((state) => state.collabModeKind)
  const pending = useAgentChatStore((state) =>
    state.threadId ? state.collabModePendingByThread[state.threadId] : undefined,
  )
  const collabModeCompatibility = useAgentChatStore(
    (state) => state.collabModeCompatibility,
  )
  const nextTurnTarget = useAgentChatStore((state) =>
    state.threadId ? state.collabModeNextTurnByThread[state.threadId] : undefined,
  )
  const planReasoningEffort = useAgentChatStore(
    (state) => state.planReasoningEffort,
  )
  const effectivePlanReasoningEffort = useAgentChatStore(
    selectEffectivePlanReasoningEffort,
  )
  const capabilities = useAgentChatStore((state) =>
    state.collaborationCapabilitiesModel
      === resolveModelSelection(state.selectedModelId).model
      ? state.collaborationCapabilities
      : undefined,
  )
  const collaborationError = useAgentChatStore(
    (state) => state.collaborationError,
  )
  const requestCollabMode = useAgentChatStore(
    (state) => state.requestCollabMode,
  )
  const setPlanReasoningEffort = useAgentChatStore(
    (state) => state.setPlanReasoningEffort,
  )

  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [isApplyingEffort, setIsApplyingEffort] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const isApplyingEffortRef = useRef(false)
  const listboxId = useId()

  const isPlan = collabModeKind === 'plan'
  const blockedByTurn = disabled || isRunning
  const controlsDisabled = blockedByTurn || pending !== undefined
  const nextTurnPending =
    collabModeCompatibility === 'next-turn' && nextTurnTarget !== undefined

  const supportedPlanEfforts = useMemo(
    () =>
      capabilities?.source === 'codex'
        ? normaliseSupportedPlanEfforts(capabilities.supportedPlanEfforts)
        : [],
    [capabilities],
  )

  const effortOptions = useMemo<EffortOption[]>(() => {
    const planDefaultEffort = capabilities?.planDefaultEffort || 'medium'
    const autoDescription =
      capabilities?.source === 'codex'
        ? `跟随 Codex Plan 预设 · 当前 ${planDefaultEffort}`
        : `默认兼容值 · ${planDefaultEffort}（未读取官方预设）`

    return [
      {
        value: 'auto',
        label: EFFORT_LABELS.auto,
        description: autoDescription,
      },
      ...supportedPlanEfforts.map((effort) => ({
        value: effort,
        label: EFFORT_LABELS[effort],
        description: EFFORT_DESCRIPTIONS[effort],
      })),
    ]
  }, [capabilities, supportedPlanEfforts])

  const selectedIndex = Math.max(
    0,
    effortOptions.findIndex((option) => option.value === effectivePlanReasoningEffort),
  )
  const isPreferenceSuppressed =
    planReasoningEffort !== 'auto'
    && effectivePlanReasoningEffort === 'auto'

  const liveMessage = collaborationError
    ? ''
    : pending
      ? `正在切换到 ${pending.target === 'plan' ? 'Plan' : 'Default'}…`
      : nextTurnPending
        ? `${nextTurnTarget === 'plan' ? 'Plan' : 'Default'} 将在下回合生效`
        : `已切换到 ${isPlan ? 'Plan' : 'Default'}`

  useEffect(() => {
    if (!open) return undefined

    function onOutsidePointerDown(event: PointerEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', onOutsidePointerDown)
    return () => {
      document.removeEventListener('pointerdown', onOutsidePointerDown)
    }
  }, [open])

  useEffect(() => {
    if (controlsDisabled && open) setOpen(false)
  }, [controlsDisabled, open])

  useEffect(() => {
    if (!open) return
    optionRefs.current[activeIndex]?.focus()
  }, [activeIndex, open])

  function closePopover(restoreFocus: boolean): void {
    setOpen(false)
    const settingsButton = settingsButtonRef.current
    const activeElement = document.activeElement
    const root = rootRef.current
    const focusStillOwned =
      activeElement instanceof Node
      && (
        root?.contains(activeElement)
        || activeElement === settingsButton
        || optionRefs.current.some((option) => option === activeElement)
      )
    if (
      restoreFocus
      && focusStillOwned
      && settingsButton
      && !settingsButton.disabled
    ) {
      settingsButton.focus()
    }
  }

  function toggleSettings(): void {
    if (open) {
      setOpen(false)
      return
    }
    setActiveIndex(selectedIndex)
    setOpen(true)
  }

  async function chooseEffort(value: PlanReasoningEffort): Promise<void> {
    if (isApplyingEffortRef.current) return
    if (value !== 'auto' && !supportedPlanEfforts.includes(value)) return
    isApplyingEffortRef.current = true
    setIsApplyingEffort(true)
    try {
      await setPlanReasoningEffort(value)
      closePopover(true)
    } finally {
      isApplyingEffortRef.current = false
      setIsApplyingEffort(false)
    }
  }

  function handleOptionKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void {
    if (!isOptionKey(event.key)) return
    event.preventDefault()
    event.stopPropagation()

    switch (event.key) {
      case 'ArrowDown':
        setActiveIndex((index + 1) % effortOptions.length)
        return
      case 'ArrowUp':
        setActiveIndex((index - 1 + effortOptions.length) % effortOptions.length)
        return
      case 'Home':
        setActiveIndex(0)
        return
      case 'End':
        setActiveIndex(effortOptions.length - 1)
        return
      case 'Enter':
        void chooseEffort(effortOptions[index].value)
        return
      case 'Escape':
        closePopover(true)
        return
      default: {
        const exhaustiveKey: never = event.key
        return exhaustiveKey
      }
    }
  }

  function handleRootBlur(event: ReactFocusEvent<HTMLDivElement>): void {
    const nextTarget = event.relatedTarget
    if (
      nextTarget instanceof Node
      && rootRef.current?.contains(nextTarget)
    ) {
      return
    }
    closePopover(false)
  }

  const primaryTitle = blockedByTurn
    ? '当前回合结束后可切换'
    : pending
      ? liveMessage
      : isPlan
        ? 'Plan 模式：先调研并形成计划，不直接执行'
        : 'Default 模式：按当前模型设置执行'
  const settingsTitle = blockedByTurn
    ? '当前回合结束后可切换'
    : pending
      ? liveMessage
      : 'Plan 推理设置'

  return (
    <div ref={rootRef} className="relative inline-flex" onBlur={handleRootBlur}>
      <button
        type="button"
        aria-label={isPlan ? '切换到 Default' : '切换到 Plan'}
        aria-pressed={isPlan}
        title={primaryTitle}
        disabled={controlsDisabled}
        onClick={() => {
          setOpen(false)
          void requestCollabMode(isPlan ? 'default' : 'plan')
        }}
        className={`flex items-center gap-1 rounded-l-md rounded-r-none border px-2 py-1 text-[11px] transition disabled:cursor-not-allowed disabled:opacity-50 ${
          isPlan
            ? 'border-fuchsia-400/50 bg-fuchsia-500/10 text-fuchsia-200 hover:border-fuchsia-300/70'
            : 'border-zinc-700/80 bg-zinc-900/70 text-zinc-400 hover:border-cyan-400/40 hover:text-cyan-100'
        }`}
      >
        {pending ? (
          <span
            aria-hidden
            className={`h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-current border-t-transparent ${
              isPlan ? 'text-fuchsia-300' : 'text-cyan-300'
            }`}
          />
        ) : (
          <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden>
            {isPlan ? (
              <path
                d="M6 1.2 7.1 4.9 10.8 6 7.1 7.1 6 10.8 4.9 7.1 1.2 6l3.7-1.1L6 1.2Z"
                fill="currentColor"
              />
            ) : (
              <circle
                cx="6"
                cy="6"
                r="3.75"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
              />
            )}
          </svg>
        )}
        <span className="font-medium">{isPlan ? 'Plan' : 'Default'}</span>
        {isPlan ? (
          <span className="hidden text-[10px] opacity-75 sm:inline">
            · {EFFORT_LABELS[effectivePlanReasoningEffort]}
          </span>
        ) : null}
        {pending ? <span className="text-[10px] opacity-70">切换中</span> : null}
      </button>

      <button
        ref={settingsButtonRef}
        type="button"
        aria-label="Plan 推理设置"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        title={settingsTitle}
        disabled={controlsDisabled}
        onClick={toggleSettings}
        className={`-ml-px flex w-6 items-center justify-center rounded-l-none rounded-r-md border py-1 transition disabled:cursor-not-allowed disabled:opacity-50 ${
          isPlan
            ? 'border-fuchsia-400/50 bg-fuchsia-500/10 text-fuchsia-200 hover:border-fuchsia-300/70'
            : 'border-zinc-700/80 bg-zinc-900/70 text-zinc-500 hover:border-cyan-400/40 hover:text-cyan-100'
        }`}
      >
        <span
          aria-hidden
          className={`flex opacity-75 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <svg width="10" height="10" viewBox="0 0 12 12">
            <path
              d="M2 4.5 6 8l4-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      {open ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Plan 推理强度"
          aria-busy={isApplyingEffort}
          className="absolute bottom-full right-0 z-[40001] mb-2 w-[304px] overflow-hidden rounded-lg border border-fuchsia-400/25 bg-zinc-950/95 shadow-[0_24px_60px_rgba(0,0,0,0.6)] backdrop-blur"
        >
          <div className="border-b border-zinc-800/80 px-3 py-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-fuchsia-100">
              <span aria-hidden className="text-fuchsia-300">✦</span>
              <span>Plan 模式</span>
            </div>
            <p className="mt-0.5 text-[10px] leading-4 text-zinc-500">
              先调研并形成计划，不直接执行
            </p>
          </div>

          <div className="py-1">
            {effortOptions.map((option, index) => {
              const isSelected = option.value === effectivePlanReasoningEffort
              const isActive = index === activeIndex
              return (
                <button
                  key={option.value}
                  ref={(node) => {
                    optionRefs.current[index] = node
                  }}
                  id={`${listboxId}-${option.value}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={isApplyingEffort}
                  tabIndex={isActive ? 0 : -1}
                  onFocus={() => setActiveIndex(index)}
                  onClick={() => {
                    void chooseEffort(option.value)
                  }}
                  onKeyDown={(event) => handleOptionKeyDown(event, index)}
                  className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-fuchsia-400/70 aria-disabled:cursor-wait aria-disabled:opacity-60 ${
                    isSelected
                      ? 'bg-fuchsia-500/10 text-fuchsia-100'
                      : isActive
                        ? 'bg-zinc-800/70 text-zinc-100'
                        : 'text-zinc-200 hover:bg-zinc-800/60 hover:text-fuchsia-100'
                  }`}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[12px] font-medium">{option.label}</span>
                    <span className="text-[10px] leading-4 text-zinc-500">
                      {option.description}
                    </span>
                  </span>
                  {isSelected ? (
                    <span aria-hidden className="shrink-0 text-[12px] text-fuchsia-300">
                      ✓
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>

          <div className="border-t border-zinc-800/80 px-3 py-2 text-[10px] leading-4 text-zinc-500">
            {isPreferenceSuppressed ? (
              <div className="mb-1 text-amber-300/90">
                暂用 Auto，已保留 {EFFORT_LABELS[planReasoningEffort]} 偏好
              </div>
            ) : null}
            <div>仅影响 Plan；Default保持模型原推理强度</div>
          </div>
        </div>
      ) : null}

      {collaborationError ? (
        <span
          role="alert"
          className="absolute left-0 top-full z-[40000] mt-1 max-w-[304px] whitespace-nowrap text-[10px] text-rose-300"
        >
          {collaborationError}
        </span>
      ) : nextTurnPending ? (
        <span className="absolute left-0 top-full mt-1 whitespace-nowrap text-[10px] text-amber-300/90">
          下回合生效
        </span>
      ) : null}

      <span
        data-testid="collab-mode-live"
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
      >
        {liveMessage}
      </span>
    </div>
  )
}

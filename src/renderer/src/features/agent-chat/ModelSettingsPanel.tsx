import { useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type {
  ModelReasoningEffort,
  ModelSettingsCapabilities,
} from '../../../../shared/modelSettings'

export interface ModelSettingsPanelProps {
  capabilities: ModelSettingsCapabilities
  reasoningEffort: ModelReasoningEffort
  contextWindow: number
  disabled: boolean
  pending: boolean
  error?: string
  onReasoningChange: (effort: ModelReasoningEffort) => void
  onContextChange: (contextWindow: number) => Promise<unknown>
}

const REASONING_LABELS: Record<ModelReasoningEffort, string> = {
  auto: 'Auto',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

function compactNumber(value: number, divisor: number): string {
  const scaled = value / divisor
  return Number.isInteger(scaled)
    ? String(scaled)
    : scaled.toFixed(1).replace(/\.0$/, '')
}

export function formatContextWindow(value: number): string {
  if (value >= 1_000_000) return `${compactNumber(value, 1_000_000)}M`
  if (value >= 1_000) return `${compactNumber(value, 1_000)}K`
  return String(value)
}

function optionClassName(selected: boolean, experimental = false): string {
  const tone = selected
    ? experimental
      ? 'border-amber-300/60 bg-amber-400/10 text-amber-100 shadow-[inset_0_0_0_1px_rgba(251,191,36,0.08)]'
      : 'border-cyan-300/55 bg-cyan-400/10 text-cyan-50 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.08)]'
    : 'border-zinc-700/80 bg-zinc-950/55 text-zinc-300 hover:border-cyan-400/35 hover:bg-zinc-900/90 hover:text-zinc-100'

  return `group relative flex min-h-9 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] font-medium tracking-[0.01em] transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:opacity-45 ${tone}`
}

function resolveRovingIndex<T>(
  options: readonly T[],
  selected: T,
  rovingValue: T | null,
): number {
  const rovingIndex = rovingValue === null ? -1 : options.indexOf(rovingValue)
  if (rovingIndex >= 0) return rovingIndex

  const selectedIndex = options.indexOf(selected)
  return selectedIndex >= 0 ? selectedIndex : 0
}

function nextRovingIndex(key: string, currentIndex: number, optionCount: number): number | null {
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return (currentIndex - 1 + optionCount) % optionCount
    case 'ArrowRight':
    case 'ArrowDown':
      return (currentIndex + 1) % optionCount
    case 'Home':
      return 0
    case 'End':
      return optionCount - 1
    default:
      return null
  }
}

function moveRovingFocus<T>(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  currentIndex: number,
  options: readonly T[],
  optionRefs: { current: Array<HTMLButtonElement | null> },
  setRovingValue: (value: T) => void,
  disabled: boolean,
): void {
  if (disabled || options.length === 0) return

  const nextIndex = nextRovingIndex(event.key, currentIndex, options.length)
  if (nextIndex === null) return

  event.preventDefault()
  setRovingValue(options[nextIndex])
  optionRefs.current[nextIndex]?.focus()
}

export function ModelSettingsPanel({
  capabilities,
  reasoningEffort,
  contextWindow,
  disabled,
  pending,
  error,
  onReasoningChange,
  onContextChange,
}: ModelSettingsPanelProps) {
  const contextHeadingId = useId()
  const reasoningHeadingId = useId()
  const contextOptionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const reasoningOptionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [contextRovingValue, setContextRovingValue] = useState<number | null>(null)
  const [reasoningRovingValue, setReasoningRovingValue] =
    useState<ModelReasoningEffort | null>(null)
  const controlsDisabled = disabled || pending
  const contextValues = capabilities.contextOptions.map((option) => option.value)
  const reasoningOptions: ModelReasoningEffort[] = [
    'auto',
    ...capabilities.supportedReasoningEfforts,
  ]
  const contextRovingIndex = resolveRovingIndex(
    contextValues,
    contextWindow,
    contextRovingValue,
  )
  const reasoningRovingIndex = resolveRovingIndex(
    reasoningOptions,
    reasoningEffort,
    reasoningRovingValue,
  )
  const hasExperimentalContext = capabilities.contextOptions.some(
    (option) => option.experimental,
  )
  const statusMessage = error || (pending ? '正在应用并恢复线程' : undefined)

  function handleReasoningChange(effort: ModelReasoningEffort): void {
    if (controlsDisabled) return
    onReasoningChange(effort)
  }

  function handleContextChange(value: number): void {
    if (controlsDisabled) return
    void onContextChange(value).catch(() => undefined)
  }

  return (
    <div
      className="w-full rounded-lg border border-zinc-700/70 bg-zinc-950/95 p-3 text-zinc-100 shadow-[0_18px_48px_rgba(0,0,0,0.45)]"
      aria-busy={pending}
    >
      <section aria-labelledby={contextHeadingId}>
        <div className="mb-2 flex items-center gap-2">
          <h3
            id={contextHeadingId}
            className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-200/80"
          >
            Context
          </h3>
          <span aria-hidden className="h-px flex-1 bg-zinc-800/90" />
        </div>

        <div
          role="listbox"
          aria-label="模型上下文"
          aria-disabled={controlsDisabled}
          className="grid grid-cols-2 gap-1.5"
        >
          {capabilities.contextOptions.map((option, index) => {
            const selected = option.value === contextWindow
            return (
              <button
                key={option.value}
                ref={(node) => {
                  contextOptionRefs.current[index] = node
                }}
                type="button"
                role="option"
                aria-selected={selected}
                aria-disabled={controlsDisabled}
                disabled={controlsDisabled}
                tabIndex={index === contextRovingIndex ? 0 : -1}
                onFocus={() => setContextRovingValue(option.value)}
                onClick={() => handleContextChange(option.value)}
                onKeyDown={(event) => {
                  moveRovingFocus(
                    event,
                    index,
                    contextValues,
                    contextOptionRefs,
                    setContextRovingValue,
                    controlsDisabled,
                  )
                }}
                className={optionClassName(selected, option.experimental)}
              >
                <span>{formatContextWindow(option.value)}</span>
                {option.experimental ? (
                  <span className="rounded-sm border border-amber-300/30 bg-amber-300/10 px-1 py-px text-[8px] font-semibold uppercase tracking-[0.08em] text-amber-200">
                    · 实验性
                  </span>
                ) : null}
                {option.conservative ? (
                  <span className="rounded-sm border border-zinc-500/40 bg-zinc-500/10 px-1 py-px text-[8px] font-semibold tracking-[0.05em] text-zinc-300">
                    · 保守默认
                  </span>
                ) : null}
                {selected ? (
                  <span
                    aria-hidden
                    className={`absolute right-1.5 top-1.5 h-1 w-1 rounded-full ${
                      option.experimental ? 'bg-amber-300' : 'bg-cyan-300'
                    }`}
                  />
                ) : null}
              </button>
            )
          })}
        </div>

        {hasExperimentalContext ? (
          <p className="mt-2 flex gap-1.5 text-[9px] leading-4 text-amber-200/75">
            <span aria-hidden className="mt-px text-amber-300">△</span>
            <span>
              强制客户端按 1M 管理上下文；Provider
              可能拒绝、返回 HTTP 413、增加费用或延迟。
            </span>
          </p>
        ) : null}
      </section>

      <section
        aria-labelledby={reasoningHeadingId}
        className="mt-3 border-t border-zinc-800/80 pt-3"
      >
        <div className="mb-2 flex items-center gap-2">
          <h3
            id={reasoningHeadingId}
            className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-200/80"
          >
            Reasoning
          </h3>
          <span aria-hidden className="h-px flex-1 bg-zinc-800/90" />
        </div>

        <div
          role="listbox"
          aria-label="推理强度"
          aria-disabled={controlsDisabled}
          className="grid grid-cols-3 gap-1.5"
        >
          {reasoningOptions.map((effort, index) => {
            const selected = effort === reasoningEffort
            return (
              <button
                key={effort}
                ref={(node) => {
                  reasoningOptionRefs.current[index] = node
                }}
                type="button"
                role="option"
                aria-selected={selected}
                aria-disabled={controlsDisabled}
                disabled={controlsDisabled}
                tabIndex={index === reasoningRovingIndex ? 0 : -1}
                onFocus={() => setReasoningRovingValue(effort)}
                onClick={() => handleReasoningChange(effort)}
                onKeyDown={(event) => {
                  moveRovingFocus(
                    event,
                    index,
                    reasoningOptions,
                    reasoningOptionRefs,
                    setReasoningRovingValue,
                    controlsDisabled,
                  )
                }}
                className={optionClassName(selected)}
              >
                <span>{REASONING_LABELS[effort]}</span>
                {selected ? (
                  <span
                    aria-hidden
                    className="absolute right-1.5 top-1.5 h-1 w-1 rounded-full bg-cyan-300"
                  />
                ) : null}
              </button>
            )
          })}
        </div>
      </section>

      {statusMessage ? (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={`mt-2 border-t border-zinc-800/80 pt-2 text-[10px] leading-4 ${
            error ? 'text-rose-300' : 'text-amber-200/80'
          }`}
        >
          {statusMessage}
        </div>
      ) : null}
    </div>
  )
}

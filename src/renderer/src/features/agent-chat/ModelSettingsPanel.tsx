import { useId } from 'react'
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
  onContextChange: (contextWindow: number) => Promise<void>
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
  const controlsDisabled = disabled || pending
  const reasoningOptions: ModelReasoningEffort[] = [
    'auto',
    ...capabilities.supportedReasoningEfforts,
  ]
  const hasExperimentalContext = capabilities.contextOptions.some(
    (option) => option.experimental,
  )
  const statusMessage = error || (pending ? '保存中…' : undefined)

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
          {capabilities.contextOptions.map((option) => {
            const selected = option.value === contextWindow
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                aria-disabled={controlsDisabled}
                disabled={controlsDisabled}
                onClick={() => handleContextChange(option.value)}
                className={optionClassName(selected, option.experimental)}
              >
                <span>{formatContextWindow(option.value)}</span>
                {option.experimental ? (
                  <span className="rounded-sm border border-amber-300/30 bg-amber-300/10 px-1 py-px text-[8px] font-semibold uppercase tracking-[0.08em] text-amber-200">
                    · 实验性
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
            <span>Provider 可能拒绝实验性上下文，并显著增加成本与延迟。</span>
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
          {reasoningOptions.map((effort) => {
            const selected = effort === reasoningEffort
            return (
              <button
                key={effort}
                type="button"
                role="option"
                aria-selected={selected}
                aria-disabled={controlsDisabled}
                disabled={controlsDisabled}
                onClick={() => handleReasoningChange(effort)}
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

import type { ThreadGoal, ThreadGoalStatus } from '../../../../types/codexGoals'
import { useAgentChatStore } from './store'

/** Human labels + accent colors per goal status (cyberpunk palette). */
const STATUS_META: Record<string, { label: string; className: string }> = {
  active: { label: '进行中', className: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-200' },
  paused: { label: '已暂停', className: 'border-amber-400/40 bg-amber-400/10 text-amber-200' },
  blocked: { label: '受阻', className: 'border-rose-400/40 bg-rose-400/10 text-rose-200' },
  budgetLimited: { label: '预算耗尽', className: 'border-orange-400/40 bg-orange-400/10 text-orange-200' },
  usageLimited: { label: '用量受限', className: 'border-orange-400/40 bg-orange-400/10 text-orange-200' },
  complete: { label: '已完成', className: 'border-cyan-400/40 bg-cyan-400/10 text-cyan-200' },
}

function statusMeta(status: ThreadGoalStatus): { label: string; className: string } {
  return STATUS_META[status] ?? { label: String(status), className: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-200' }
}

function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0m'
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  if (h > 0) return `${h}h${m > 0 ? ` ${m}m` : ''}`
  if (m > 0) return `${m}m`
  return `${Math.floor(totalSeconds)}s`
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
  return String(n)
}

/**
 * Compact status pill for the active thread's native `/goal`. Renders nothing
 * when no goal is set. Mirrors codex TUI's goal status bar: objective + status
 * + token/time usage, with inline pause/resume/clear controls (all backed by
 * `thread/goal/set|clear`).
 */
export function GoalChip({ goal }: { goal: ThreadGoal }): React.JSX.Element {
  const setGoalStatus = useAgentChatStore((state) => state.setGoalStatus)
  const clearGoal = useAgentChatStore((state) => state.clearGoal)
  const meta = statusMeta(goal.status)
  const isPaused = goal.status === 'paused'
  const hasBudget = typeof goal.tokenBudget === 'number' && goal.tokenBudget > 0
  const budgetText = hasBudget
    ? `${formatTokens(goal.tokensUsed)}/${formatTokens(goal.tokenBudget as number)} tok`
    : `${formatTokens(goal.tokensUsed)} tok`
  const budgetPct = hasBudget
    ? Math.min(100, Math.round((goal.tokensUsed / (goal.tokenBudget as number)) * 100))
    : 0
  // Bar tints hotter as the budget runs down: green → amber → rose.
  const barClass = budgetPct >= 90 ? 'bg-rose-400' : budgetPct >= 70 ? 'bg-amber-400' : 'bg-emerald-400'

  return (
    <div className="mt-2 flex items-start justify-between gap-3 rounded-md border border-cyan-400/25 bg-cyan-400/[0.06] px-3 py-2 text-xs">
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.28em] text-cyan-300/70">goal</span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${meta.className}`}>{meta.label}</span>
          <span className="font-mono text-[10px] text-zinc-400">
            {budgetText} · {formatDuration(goal.timeUsedSeconds)}
          </span>
        </div>
        <p className="truncate text-cyan-50" title={goal.objective}>
          {goal.objective}
        </p>
        {hasBudget ? (
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-zinc-700/60" title={`${budgetPct}% of token budget`}>
            <div className={`h-full rounded-full ${barClass}`} style={{ width: `${budgetPct}%` }} />
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 font-mono text-[11px]">
        <button
          type="button"
          onClick={() => void setGoalStatus(isPaused ? 'active' : 'paused')}
          className="cursor-pointer text-cyan-300 hover:text-cyan-100"
        >
          {isPaused ? '继续' : '暂停'}
        </button>
        <button
          type="button"
          onClick={() => void clearGoal()}
          className="cursor-pointer text-zinc-400 hover:text-rose-200"
        >
          清除
        </button>
      </div>
    </div>
  )
}

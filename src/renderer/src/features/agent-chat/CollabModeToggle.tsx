import { useAgentChatStore } from './store'

/**
 * Plan-mode toggle for the composer footer (next to ModelPicker). Flips the
 * per-thread `collabModeKind` between codex's built-in Plan preset
 * (experimental `turn/start.collaborationMode`) and the normal Default mode.
 * Plan mode makes codex research + propose a plan instead of executing.
 */
export function CollabModeToggle({ disabled }: { disabled?: boolean }) {
  const kind = useAgentChatStore((state) => state.collabModeKind)
  const setCollabMode = useAgentChatStore((state) => state.setCollabMode)
  const isPlan = kind === 'plan'

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setCollabMode(isPlan ? 'default' : 'plan')}
      aria-pressed={isPlan}
      title={isPlan ? 'Plan 模式:codex 先调研并产出计划,不直接执行(点击切回默认)' : '切到 Plan 模式:codex 先调研并产出计划,不直接执行'}
      className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition disabled:cursor-not-allowed disabled:opacity-50 ${
        isPlan
          ? 'border-fuchsia-400/50 bg-fuchsia-500/10 text-fuchsia-200 hover:border-fuchsia-300/70'
          : 'border-zinc-700/80 bg-zinc-900/70 text-zinc-400 hover:border-cyan-400/40 hover:text-cyan-100'
      }`}
    >
      <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden>
        <path
          d="M2 2h8M2 6h5M2 10h6.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      <span className="font-medium">Plan</span>
    </button>
  )
}

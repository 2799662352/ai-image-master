import { useDirectorStore } from '../stores/useDirectorStore'

interface GenerateButtonProps {
  onGenerate: () => void
  onCancel: () => void
  onPause: () => void
  onResume: () => void
}

/**
 * v4.2.7 — Compact controls + live-queue main button.
 *
 * Layout strategy:
 * - idle: full-width primary button.
 * - running / paused: `flex-[3]` primary button (~75%) stays clickable to
 *   enqueue new jobs while the current one runs, plus two `flex-1` (~12.5%)
 *   chip buttons on the right for pause/resume + cancel.
 *
 * The primary button is NEVER disabled while busy (only `!canGenerate`,
 * i.e. no reference images, disables it). Clicking it during a run snapshots
 * the current UI state into the FIFO queue — handled in useDirectorGeneration.
 */
export function GenerateButton({ onGenerate, onCancel, onPause, onResume }: GenerateButtonProps) {
  const generationStatus = useDirectorStore((s) => s.generationStatus)
  const hasImages = useDirectorStore((s) => s.referenceImages.length > 0)
  const pendingCount = useDirectorStore((s) => s.pendingCount)

  const isRunning = generationStatus === 'running'
  const isPaused = generationStatus === 'paused'
  const isBusy = isRunning || isPaused

  if (isBusy) {
    const stateLabel = isRunning ? '运行中' : '已暂停'
    const queueLabel = pendingCount > 0 ? ` + 队列 ${pendingCount}` : ''
    const mainLabel = `加入队列 (${stateLabel}${queueLabel})`

    return (
      <div className="w-full flex gap-1">
        <button
          onClick={onGenerate}
          disabled={!hasImages}
          aria-label={mainLabel}
          className="flex-[3] py-3 rounded-none bg-[#FCE300] text-black font-bold uppercase text-sm tracking-tighter transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed hover:scale-[1.02] active:scale-95"
        >
          <i className="fas fa-plus-circle" />
          {mainLabel}
        </button>
        <button
          onClick={isRunning ? onPause : onResume}
          aria-label={isRunning ? '暂停' : '继续'}
          title={isRunning ? '暂停当前任务' : '继续当前任务'}
          className={`flex-1 py-3 rounded-none font-bold text-base transition-all flex items-center justify-center active:scale-95 ${
            isRunning
              ? 'bg-amber-500 text-black hover:bg-amber-400'
              : 'bg-green-600 text-white hover:bg-green-500'
          }`}
        >
          <i className={isRunning ? 'fas fa-pause' : 'fas fa-play'} />
        </button>
        <button
          onClick={onCancel}
          aria-label="取消当前任务"
          title="取消当前任务（不清空队列）"
          className="flex-1 py-3 rounded-none bg-red-600 text-white font-bold text-base transition-all flex items-center justify-center hover:bg-red-500 active:scale-95"
        >
          <i className="fas fa-times" />
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={onGenerate}
      disabled={!hasImages}
      className="w-full py-3 rounded-none bg-[#FCE300] text-black font-bold uppercase text-sm tracking-tighter transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed hover:scale-105 active:scale-95"
    >
      <i className="fas fa-magic" />
      一键生成漫画分镜
    </button>
  )
}

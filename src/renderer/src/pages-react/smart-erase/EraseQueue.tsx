import { useEraseSessionStore, type EraseSessionTask } from '../../stores/useEraseSessionStore'
import type { EraseTask } from '../../../../types/smartErase'
import { computeProcessingProgress } from './eraseProgress'
import { useTicker } from './useTicker'

const api = (window as any).electronAPI

const STATUS_LABEL: Record<EraseTask['status'], string> = {
  'queued-upload': '排队上传',
  uploading: '上传中',
  'queued-process': '排队处理',
  submitting: '提交中',
  processing: '处理中',
  finished: '完成',
  failed: '失败',
  cancelled: '已取消',
}

const STATUS_COLOR: Record<EraseTask['status'], string> = {
  'queued-upload': 'var(--donor-ink-mute)',
  uploading: 'var(--donor-cyan)',
  'queued-process': 'var(--donor-ink-mute)',
  submitting: 'var(--donor-yellow)',
  processing: 'var(--donor-yellow)',
  finished: 'var(--donor-green)',
  failed: 'var(--donor-red)',
  cancelled: 'var(--donor-ink-dim)',
}

export function EraseQueue() {
  const tasks = useEraseSessionStore((s) => s.activeTasks)
  const hasProcessing = tasks.some((t) => t.status === 'processing')
  const now = useTicker(hasProcessing)

  if (tasks.length === 0) return null

  const counts = countByPhase(tasks)

  return (
    <div className="d-neon-frame p-4 space-y-3">
      <div className="flex items-center gap-3 flex-wrap d-mono text-[11px] tracking-widest uppercase">
        <Counter label="QUEUE" value={counts.queued} color="var(--donor-ink-mute)" />
        <Counter label="UPLOAD" value={counts.uploading} color="var(--donor-cyan)" />
        <Counter label="PROC" value={counts.processing} color="var(--donor-yellow)" />
        <Counter label="FAIL" value={counts.failed} color="var(--donor-red)" />
      </div>

      <ul className="space-y-1.5">
        {tasks.map((t) => (
          <TaskRow key={t.id} task={t} now={now} />
        ))}
      </ul>
    </div>
  )
}

function TaskRow({ task: t, now }: { task: EraseSessionTask; now: number }) {
  const barPercent = getBarPercent(t, now)

  return (
    <li className="px-3 py-2 border border-[color:var(--donor-ink-mute)]/30 d-mono text-[11px] space-y-1">
      <div className="flex items-center gap-3">
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: STATUS_COLOR[t.status] }}
        />
        <span className="truncate flex-1 text-[color:var(--donor-ink)]">
          {t.filename}
        </span>
        <span
          className="text-[10px] tracking-widest uppercase flex-shrink-0"
          style={{ color: STATUS_COLOR[t.status] }}
        >
          {STATUS_LABEL[t.status]}
          {t.status === 'uploading' && t.uploadProgress != null
            ? ` ${t.uploadProgress}%`
            : ''}
          {t.status === 'processing' && barPercent > 0
            ? ` ${barPercent}%`
            : ''}
        </span>
        {t.status !== 'failed' && t.status !== 'cancelled' && (
          <button
            type="button"
            onClick={() => void api?.smartEraseCancel?.(t.id)}
            className="text-[10px] text-[color:var(--donor-ink-dim)] hover:text-[color:var(--donor-red)] tracking-widest"
            title="取消任务"
          >
            [×]
          </button>
        )}
      </div>
      {barPercent > 0 && (
        <div className="h-1 bg-[color:var(--donor-ink-mute)]/20 overflow-hidden">
          <div
            className="h-full transition-all duration-1000 ease-out"
            style={{
              width: `${barPercent}%`,
              backgroundColor:
                t.status === 'failed' ? 'var(--donor-red)' : STATUS_COLOR[t.status],
            }}
          />
        </div>
      )}
    </li>
  )
}

function getBarPercent(t: EraseSessionTask, now: number): number {
  if (t.status === 'uploading') return t.uploadProgress ?? 0
  if (t.status === 'processing') {
    return computeProcessingProgress({
      startedAt: t.processingStartedAt ?? 0,
      durationSeconds: t.durationSeconds,
      status: t.status,
      now,
    })
  }
  return 0
}

function Counter({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <span className="px-2 py-0.5 border" style={{ borderColor: color, color }}>
      {label} {value}
    </span>
  )
}

function countByPhase(tasks: EraseTask[]) {
  let queued = 0, uploading = 0, processing = 0, failed = 0
  for (const t of tasks) {
    switch (t.status) {
      case 'queued-upload': case 'queued-process': queued++; break
      case 'uploading': uploading++; break
      case 'submitting': case 'processing': processing++; break
      case 'failed': failed++; break
    }
  }
  return { queued, uploading, processing, failed }
}

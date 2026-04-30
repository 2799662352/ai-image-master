import { useEraseSessionStore } from '../../stores/useEraseSessionStore'
import type { EraseTask } from '../../../../types/smartErase'

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

/**
 * Active task list with cancel button on every row, plus a compact counter
 * row at the top. Empty state collapses (returns null) so it doesn't take
 * vertical space when nothing's running.
 */
export function EraseQueue() {
  const tasks = useEraseSessionStore((s) => s.activeTasks)

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
          <li
            key={t.id}
            className="flex items-center gap-3 px-3 py-2 border border-[color:var(--donor-ink-mute)]/30 d-mono text-[11px]"
          >
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
          </li>
        ))}
      </ul>
    </div>
  )
}

function Counter({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <span
      className="px-2 py-0.5 border"
      style={{
        borderColor: color,
        color,
      }}
    >
      {label} {value}
    </span>
  )
}

function countByPhase(tasks: EraseTask[]) {
  let queued = 0
  let uploading = 0
  let processing = 0
  let failed = 0
  for (const t of tasks) {
    switch (t.status) {
      case 'queued-upload':
      case 'queued-process':
        queued++
        break
      case 'uploading':
        uploading++
        break
      case 'submitting':
      case 'processing':
        processing++
        break
      case 'failed':
        failed++
        break
    }
  }
  return { queued, uploading, processing, failed }
}

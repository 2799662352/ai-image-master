import type { SplitTask } from '../../../../types/storyboardSplit'

const STAGE_LABELS: Record<string, string> = {
  'uploading-cos': 'COS 上传中',
  'submitting-mps': '提交 MPS',
  'polling-mps': '处理中',
  done: '完成',
}

interface Props {
  task: SplitTask
  onCancel: (id: string) => void
}

export default function ActiveQueueItem({ task, onCancel }: Props) {
  const stageLabel = task.stage ? STAGE_LABELS[task.stage] || task.stage : task.status

  return (
    <div className="d-neon-frame flex items-center gap-3 px-3 py-2 d-mono text-[11px]">
      <span className="text-[color:var(--donor-ink)] truncate max-w-[40%]">{task.filename}</span>

      <div className="flex-1 h-1.5 bg-[color:var(--donor-bg-0)] overflow-hidden">
        <div
          className="h-full bg-[color:var(--donor-cyan)] transition-all duration-500"
          style={{ width: `${task.progress}%` }}
        />
      </div>

      <span className="text-[color:var(--donor-cyan)] tracking-widest whitespace-nowrap">
        {stageLabel} {task.progress}%
      </span>

      <button
        type="button"
        onClick={() => onCancel(task.id)}
        className="d-hover-invert px-2 py-0.5 text-[color:var(--donor-red)] tracking-widest uppercase"
      >
        [ ✕ ]
      </button>
    </div>
  )
}

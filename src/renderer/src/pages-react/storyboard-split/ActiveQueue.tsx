import type { SplitTask } from '../../../../types/storyboardSplit'
import ActiveQueueItem from './ActiveQueueItem'

interface Props {
  tasks: SplitTask[]
  onCancel: (id: string) => void
}

export default function ActiveQueue({ tasks, onCancel }: Props) {
  const active = tasks.filter((t) =>
    ['pending', 'queued', 'uploading', 'submitted', 'processing'].includes(t.status)
  )
  if (active.length === 0) return null

  return (
    <div className="space-y-2">
      <div className="d-mono text-[10px] text-[color:var(--donor-magenta)] tracking-widest uppercase">
        ◐ PROCESSING // {active.length} TASK{active.length > 1 ? 'S' : ''}
      </div>
      {active.map((task) => (
        <ActiveQueueItem key={task.id} task={task} onCancel={onCancel} />
      ))}
    </div>
  )
}

import { useState } from 'react'
import type { FileChange } from '../../../../../types/agent-timeline'

const MAX_VISIBLE_LINES = 200

function diffLineClass(line: string): string {
  if (line.startsWith('@@')) return 'border-l border-cyan-400/20 bg-cyan-500/[0.05] pl-2 text-cyan-300/60'
  if (line.startsWith('+')) return 'border-l border-emerald-400/25 bg-emerald-500/10 pl-2 text-emerald-200'
  if (line.startsWith('-')) return 'border-l border-red-400/25 bg-red-500/10 pl-2 text-red-200'
  return 'border-l border-transparent pl-2 text-zinc-400'
}

/**
 * 操作类型徽章。缺了它,「删掉一个文件」和「改了几行」在 diff 里都是一片红,
 * 分不出来 —— 而这两件事的严重程度差着量级。
 */
const OPERATION_BADGE: Record<FileChange['operation'], { label: string; className: string }> = {
  create: { label: '新建', className: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200' },
  edit: { label: '修改', className: 'border-cyan-400/30 bg-cyan-500/10 text-cyan-200' },
  delete: { label: '删除', className: 'border-red-400/30 bg-red-500/10 text-red-200' },
}

export function FileDiffBlock({ change }: { change: FileChange }) {
  const [showAll, setShowAll] = useState(false)
  const lines = change.diff.split('\n')
  const truncated = !showAll && lines.length > MAX_VISIBLE_LINES
  const visible = truncated ? lines.slice(0, MAX_VISIBLE_LINES) : lines
  const badge = OPERATION_BADGE[change.operation]

  return (
    <div className="mb-2">
      <div className="flex items-center gap-2 px-2 py-1 text-[11px]">
        <span className={`shrink-0 rounded border px-1 py-px text-[10px] leading-none ${badge.className}`}>
          {badge.label}
        </span>
        <code className="min-w-0 flex-1 truncate font-medium text-zinc-200" title={change.path}>
          {change.path}
        </code>
        <span className="text-emerald-400">+{change.added}</span>
        <span className="text-red-400">−{change.removed}</span>
      </div>
      <pre className="overflow-x-auto rounded border border-zinc-800/60 bg-zinc-950/70 p-1.5 font-mono text-[11px] leading-[1.6]">
        {visible.map((line, i) => (
          <div key={i} className={diffLineClass(line)}>
            {line || ' '}
          </div>
        ))}
      </pre>
      {truncated && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1 text-[10px] text-cyan-400 hover:underline"
        >
          Show all {lines.length} lines
        </button>
      )}
    </div>
  )
}

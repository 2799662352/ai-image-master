import { useState } from 'react'
import type { FileChange } from '../../../../../types/agent-timeline'

const MAX_VISIBLE_LINES = 200

function diffLineClass(line: string): string {
  if (line.startsWith('@@')) return 'text-zinc-500'
  if (line.startsWith('+')) return 'text-[#5fdb89] bg-[#0e1b14]'
  if (line.startsWith('-')) return 'text-[#f47b6f] bg-[#1c0e0e]'
  return 'text-zinc-400'
}

export function FileDiffBlock({ change }: { change: FileChange }) {
  const [showAll, setShowAll] = useState(false)
  const lines = change.diff.split('\n')
  const truncated = !showAll && lines.length > MAX_VISIBLE_LINES
  const visible = truncated ? lines.slice(0, MAX_VISIBLE_LINES) : lines

  return (
    <div className="mb-2">
      <div className="flex items-center gap-2 px-2 py-1 text-[11px]">
        <code className="font-medium text-zinc-200">{change.path}</code>
        <span className="text-emerald-400">+{change.added}</span>
        <span className="text-red-400">−{change.removed}</span>
      </div>
      <pre className="overflow-x-auto rounded border border-zinc-800/60 bg-zinc-950/70 p-2 font-mono text-[11px] leading-[1.6]">
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

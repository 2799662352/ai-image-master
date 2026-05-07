import type { FileChange } from '../types/agent-timeline'

export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('@@')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

export function parseChange(raw: {
  path: string
  kind: string
  unifiedDiff: string
}): FileChange {
  const { added, removed } = countDiffLines(raw.unifiedDiff)
  return {
    path: raw.path,
    operation: raw.kind === 'create' ? 'create' : raw.kind === 'delete' ? 'delete' : 'edit',
    diff: raw.unifiedDiff,
    added,
    removed,
  }
}

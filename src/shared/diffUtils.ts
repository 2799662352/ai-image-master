import type { FileChange } from '../types/agent-timeline'

export function countDiffLines(diff: unknown): { added: number; removed: number } {
  let added = 0
  let removed = 0
  const text = typeof diff === 'string' ? diff : ''
  for (const line of text.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('@@')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

export function parseChange(raw: {
  path?: unknown
  kind?: unknown
  unifiedDiff?: unknown
}): FileChange {
  const diff = typeof raw.unifiedDiff === 'string' ? raw.unifiedDiff : ''
  const kind = typeof raw.kind === 'string' ? raw.kind : ''
  const { added, removed } = countDiffLines(diff)
  return {
    path: typeof raw.path === 'string' && raw.path.length > 0 ? raw.path : 'unknown',
    operation: kind === 'create' ? 'create' : kind === 'delete' ? 'delete' : 'edit',
    diff,
    added,
    removed,
  }
}

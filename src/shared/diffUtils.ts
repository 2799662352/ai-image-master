import type { FileChange, FileEditItem } from '../types/agent-timeline'

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

/**
 * 把一段流式 diff 追加到 fileEdit 的第一个改动上,并重算计数。
 *
 * 计数是对**拼接后的全文**重算,不是把每段单独数了相加 —— 增量会被切在半行
 * 上(`+ne` / `w` / `\n` 三段拼一个 `+new`),分段数会数出三行。
 *
 * 主进程(持久化)和渲染层(展示)各有一份 timeline reducer,两边都要走这条
 * 路径,所以放在 shared 里。
 */
export function appendStreamedDiff(item: FileEditItem, text: string): FileEditItem {
  const [head, ...rest] = item.changes
  const base: FileChange = head ?? { path: '', operation: 'edit', diff: '', added: 0, removed: 0 }
  const diff = base.diff + text
  const { added, removed } = countDiffLines(diff)
  const changes = [{ ...base, diff, added, removed }, ...rest]
  return {
    ...item,
    changes,
    totalAdded: changes.reduce((sum, c) => sum + c.added, 0),
    totalRemoved: changes.reduce((sum, c) => sum + c.removed, 0),
  }
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

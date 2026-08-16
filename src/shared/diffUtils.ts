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
 * 把一段流式 diff 追加到 fileEdit 的第一个改动上,并递增计数。
 *
 * 不能把每段单独数了相加 —— 增量会被切在半行上(`+ne` / `w` / `\n` 三段拼成
 * 一个 `+new`),分段数会数出三行。
 *
 * 但也不能每次都重数拼接后的全文:那是 O(n²)。一个几十 KB 的 diff 分几百段
 * 到达,就是几 MB 的重复扫描,而这条路径**主进程和渲染层各跑一遍**。
 *
 * 折中:只重数「最后一个换行之后」的那一段。base 末尾那条不完整的行此前已经
 * 被计入过一次(`+ne` 会被当成一个新增行),所以把它连同新文本一起重数,再减
 * 去它旧的那一份;换行边界之前的计数原样保留。每次的代价只跟「尾巴 + 新增
 * 量」有关,与已攒下的长度无关。
 *
 * 主进程(持久化)和渲染层(展示)各有一份 timeline reducer,两边都要走这条
 * 路径,所以放在 shared 里。
 */
export function appendStreamedDiff(item: FileEditItem, text: string): FileEditItem {
  const [head, ...rest] = item.changes
  const base: FileChange = head ?? { path: '', operation: 'edit', diff: '', added: 0, removed: 0 }
  const diff = base.diff + text
  const boundary = base.diff.lastIndexOf('\n') + 1
  const staleTail = base.diff.slice(boundary)
  const before = countDiffLines(staleTail)
  const after = countDiffLines(staleTail + text)
  const added = base.added - before.added + after.added
  const removed = base.removed - before.removed + after.removed
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

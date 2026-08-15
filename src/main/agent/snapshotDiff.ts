/**
 * 两份工作区快照之间的差异,产出与 Codex `fileChange` 同形的 `FileChange[]`,
 * 好让渲染层与持久化层原样复用。
 *
 * 只输出 hunk(不带 `---`/`+++` 文件头):`FileDiffBlock` 按行首字符上色,
 * 头行对它没有信息量;而 jsdiff 各版本对文件头的拼法略有出入,不依赖它更稳。
 */

import { structuredPatch } from 'diff'
import { countDiffLines } from '../../shared/diffUtils'
import type { FileChange } from '../../types/agent-timeline'
import type { Snapshot } from './workspaceSnapshot'

const CONTEXT_LINES = 3

function renderHunks(oldText: string, newText: string, filePath: string): string {
  const patch = structuredPatch(filePath, filePath, oldText, newText, '', '', {
    context: CONTEXT_LINES,
  })
  return patch.hunks
    .map(
      (h) =>
        `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}`,
    )
    .join('\n')
}

export function diffSnapshots(before: Snapshot, after: Snapshot): FileChange[] {
  // 半份快照算出来的「改动」是扫描范围差异,不是真的改动。
  if (!before.complete || !after.complete) return []

  const paths = new Set<string>([...before.files.keys(), ...after.files.keys()])
  const out: FileChange[] = []

  for (const filePath of [...paths].sort()) {
    if (before.skipped.has(filePath) || after.skipped.has(filePath)) continue
    const oldText = before.files.get(filePath)
    const newText = after.files.get(filePath)
    if (oldText === newText) continue

    const operation: FileChange['operation'] =
      oldText === undefined ? 'create' : newText === undefined ? 'delete' : 'edit'
    const diff = renderHunks(oldText ?? '', newText ?? '', filePath)
    const { added, removed } = countDiffLines(diff)
    out.push({ path: filePath, operation, diff, added, removed, source: 'observed' })
  }

  return out
}

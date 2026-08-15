/**
 * 两份工作区快照之间的差异,产出与 Codex `fileChange` 同形的 `FileChange[]`,
 * 好让渲染层与持久化层原样复用。
 *
 * 只输出 hunk(不带 `---`/`+++` 文件头):`FileDiffBlock` 按行首字符上色,
 * 头行对它没有信息量;而 jsdiff 各版本对文件头的拼法略有出入,不依赖它更稳。
 *
 * ## 为什么单个文件的渲染要限时
 *
 * jsdiff 走 Myers,代价随「文件多长」和「改了多少」相乘上去。一个几千行的文件
 * 被脚本整份重写(`prettier --write`、重新生成的 lock 文件、codegen 覆盖输出)
 * 两个因子同时拉满 —— 而这段跑在**主进程**上,卡住的是整个 Electron 的 IPC 和
 * 窗口响应。偏偏「整份重写」正是命令行改动最典型的形态。上游同样给 diff 渲染
 * 设了 100ms 闸,取同一个值。
 *
 * 超时不作废这个文件:文件确实被改了,这条信息本身就是本功能的全部意义,咽掉
 * 它是另一种「给错的」(漏报)。改为照常出卡片、正文换成一行说明 —— 说不出改了
 * 什么,但绝不说没改。
 */

import { structuredPatch } from 'diff'
import { countDiffLines } from '../../shared/diffUtils'
import type { FileChange } from '../../types/agent-timeline'
import type { Snapshot } from './workspaceSnapshot'

const CONTEXT_LINES = 3

/** 与上游 `DIFF_TIMEOUT` 同值。超过就放弃渲染,不放弃这条改动记录。 */
export const DIFF_TIMEOUT_MS = 100

/** 前导空格 = `FileDiffBlock` 眼里的中性行,不会被误上成增删色。 */
const TOO_SLOW_PLACEHOLDER = `  (文件已改动;差异过大,渲染超过 ${DIFF_TIMEOUT_MS}ms 已放弃,此处不展示具体内容)`

/** @returns null = 渲染超时。 */
function renderHunks(oldText: string, newText: string, filePath: string): string | null {
  const patch = structuredPatch(filePath, filePath, oldText, newText, '', '', {
    context: CONTEXT_LINES,
    timeout: DIFF_TIMEOUT_MS,
  })
  if (!patch) return null
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
    const rendered = renderHunks(oldText ?? '', newText ?? '', filePath)
    const diff = rendered ?? TOO_SLOW_PLACEHOLDER
    // 占位符里没有增删行,countDiffLines 自然给 0/0 —— 与「说不出改了什么」一致。
    const { added, removed } = countDiffLines(diff)
    out.push({ path: filePath, operation, diff, added, removed, source: 'observed' })
  }

  return out
}

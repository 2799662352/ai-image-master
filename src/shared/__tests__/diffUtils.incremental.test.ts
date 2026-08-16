import { describe, expect, it } from 'vitest'
import type { FileEditItem } from '../../types/agent-timeline'
import { appendStreamedDiff, countDiffLines } from '../diffUtils'

/**
 * `appendStreamedDiff` 原本每次都对拼接后的全文重数一遍 —— O(n²),而且这条
 * 路径主进程和渲染层各跑一遍。改成只重数「最后一个换行之后」的那一段之后,
 * 这组用例锁住结果必须与整块重数完全一致。
 */

function emptyItem(): FileEditItem {
  return {
    type: 'fileEdit',
    id: 'edit-1',
    startedAt: 1,
    changes: [{ path: 'a.ts', operation: 'edit', diff: '', added: 0, removed: 0 }],
    totalAdded: 0,
    totalRemoved: 0,
  }
}

function feed(chunks: string[]): FileEditItem {
  return chunks.reduce<FileEditItem>((item, chunk) => appendStreamedDiff(item, chunk), emptyItem())
}

const FULL = '@@ -1,3 +1,3 @@\n const a = 1\n-const b = 2\n+const b = 3\n export { a, b }\n'

describe('appendStreamedDiff 增量计数', () => {
  it('无论怎么切分,结果都和整块重数一致', () => {
    const expected = countDiffLines(FULL)

    // 一次到位 / 按行切 / 每 3 个字符切一刀(必然切在半行上)。
    const wholesale = feed([FULL])
    const byLine = feed(FULL.split(/(?<=\n)/))
    const byChunk = feed(FULL.match(/[\s\S]{1,3}/g) ?? [])

    for (const item of [wholesale, byLine, byChunk]) {
      expect(item.changes[0].diff).toBe(FULL)
      expect({ added: item.changes[0].added, removed: item.changes[0].removed }).toEqual(expected)
      expect(item.totalAdded).toBe(expected.added)
      expect(item.totalRemoved).toBe(expected.removed)
    }
  })

  /**
   * 这条是整个折中方案的要害:`+ne` 在拼完之前就已经被当成一个新增行计过一次
   * 了,补完 `w\n` 之后不能再加一次。
   */
  it('切在半行上不会把同一行数两遍', () => {
    const item = feed(['+ne', 'w\n'])

    expect(item.changes[0].diff).toBe('+new\n')
    expect(item.changes[0].added).toBe(1)
    expect(item.changes[0].removed).toBe(0)
  })

  it('逐字符喂进去也不会漂', () => {
    const item = feed([...FULL])

    expect(item.changes[0].diff).toBe(FULL)
    expect({ added: item.changes[0].added, removed: item.changes[0].removed }).toEqual(countDiffLines(FULL))
  })

  it('文件头和 hunk 头不计入增删', () => {
    const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n'
    const item = feed(diff.split(/(?<=\n)/))

    expect(item.changes[0].added).toBe(1)
    expect(item.changes[0].removed).toBe(1)
  })
})

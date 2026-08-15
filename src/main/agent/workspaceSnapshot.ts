/**
 * 工作区的一次性内存快照,用来算出「本轮命令行改了什么」的基线。
 *
 * ## 为什么不落盘
 *
 * 上游 Codex Desktop 把同样的东西写成 git 对象(`refs/codex/turn-diffs/`),
 * 结果单个项目的 `.git/objects` 涨到 102 GB(openai/codex#29388),另有一例
 * 连续 rollback 写坏内部仓库、工作区文件永久丢失(#30214)。我们只在内存里
 * 存、回合结束即弃,这两类问题因此不存在。
 *
 * ## 为什么超预算要整份作废
 *
 * 半份快照比没有快照更坏:起始扫描完整、结束扫描被截断,对比出来的「删除了
 * 800 个文件」全是扫描范围差异造成的假象,而它看起来跟真的一样。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface SnapshotBudget {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
  skipDirs: ReadonlySet<string>
}

export const DEFAULT_SNAPSHOT_BUDGET: SnapshotBudget = {
  maxFiles: 3000,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  skipDirs: new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'out',
    '.next',
    'coverage',
    'target',
    '.venv',
    '__pycache__',
  ]),
}

export interface Snapshot {
  /** 绝对路径 → 文本内容。 */
  files: Map<string, string>
  /**
   * 见到了但没收内容的路径(二进制、超大、读不动)。对比时两边都要排除它们 ——
   * 否则一个读不动的文件会在下一轮变成「新建」。
   */
  skipped: Set<string>
  /** false = 预算爆了,这份快照不可用,调用方必须整轮作废。 */
  complete: boolean
}

const BINARY_SNIFF_BYTES = 8192

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

export async function takeSnapshot(
  roots: string[],
  budget: SnapshotBudget = DEFAULT_SNAPSHOT_BUDGET,
): Promise<Snapshot> {
  const files = new Map<string, string>()
  const skipped = new Set<string>()
  let totalBytes = 0
  let overBudget = false

  async function walk(dir: string): Promise<void> {
    if (overBudget) return
    let entries: Awaited<ReturnType<typeof fs.readdir>>
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      // 根目录不存在 / 没权限:当作空,不炸掉整个回合。
      return
    }
    for (const entry of entries) {
      if (overBudget) return
      const name = String(entry.name)
      const full = path.join(dir, name)
      if (entry.isDirectory()) {
        if (budget.skipDirs.has(name)) continue
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue

      if (files.size + 1 > budget.maxFiles) {
        overBudget = true
        return
      }
      let buf: Buffer
      try {
        const stat = await fs.stat(full)
        if (stat.size > budget.maxFileBytes) {
          skipped.add(full)
          continue
        }
        buf = await fs.readFile(full)
      } catch {
        skipped.add(full)
        continue
      }
      if (looksBinary(buf)) {
        skipped.add(full)
        continue
      }
      totalBytes += buf.byteLength
      if (totalBytes > budget.maxTotalBytes) {
        overBudget = true
        return
      }
      files.set(full, buf.toString('utf8'))
    }
  }

  for (const root of roots) {
    await walk(path.resolve(root))
    if (overBudget) break
  }

  if (overBudget) return { files: new Map(), skipped: new Set(), complete: false }
  return { files, skipped, complete: true }
}

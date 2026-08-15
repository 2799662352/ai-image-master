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
 *
 * ## 为什么读不动目录也要整份作废
 *
 * 同一个道理。一个 EACCES 的子目录如果被当成「空目录」咽下去,那棵子树就从
 * 快照里凭空消失了 —— 而 `complete` 还是 true,调用方毫不知情地把它当基线用。
 * 唯一合法的「空」是顶层 root 压根不存在(调用方给了个还没建的目录,它本来
 * 就不该贡献任何文件);除此之外的任何 readdir 失败,以及任何发生在 root
 * *之下* 的失败,都走整份作废。宁可不给,不给错的。
 *
 * ## 为什么除了「留下多少」还要限「走了多少」
 *
 * maxFiles / maxTotalBytes 限的是保留量,不是扫描量:十万个小二进制文件一个
 * 都留不下,却要实打实地 stat + 读满十万次,两个闸门谁都不会跳。而快照在交互
 * 路径上、每回合跑两次,扫描本身就是要防的成本。所以另设 maxEntries 直接数
 * 「看过几个文件条目」(留下的和跳过的都算),让预算真的是硬闸。
 */

import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import path from 'node:path'

export interface SnapshotBudget {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
  /** 允许走过的文件条目总数(留下的 + 跳过的),限的是扫描成本本身。 */
  maxEntries: number
  skipDirs: ReadonlySet<string>
}

export const DEFAULT_SNAPSHOT_BUDGET: SnapshotBudget = {
  maxFiles: 3000,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxEntries: 20000,
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
  /** false = 这份快照不可用(预算爆了或有子树没扫到),调用方必须整轮作废。 */
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
  let entriesSeen = 0
  let aborted = false

  async function walk(dir: string, isRoot: boolean): Promise<void> {
    if (aborted) return
    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      // 顶层 root 不存在 = 合法的空,继续扫下一个 root。
      if (isRoot && (err as NodeJS.ErrnoException).code === 'ENOENT') return
      // 其余全部(EACCES / EPERM / ENOTDIR / EMFILE…,以及任何 root 之下的
      // 失败)都意味着有一棵子树没扫到。当成空目录咽下去,下一轮对比就会
      // 凭空报出「删除了一整个目录」。整份作废。
      aborted = true
      return
    }
    for (const entry of entries) {
      if (aborted) return
      const name = entry.name
      const full = path.join(dir, name)
      if (entry.isDirectory()) {
        if (budget.skipDirs.has(name)) continue
        await walk(full, false)
        continue
      }
      if (!entry.isFile()) continue

      entriesSeen += 1
      if (entriesSeen > budget.maxEntries) {
        aborted = true
        return
      }

      // 多个 root 可能互相嵌套,同一个绝对路径会被走到两次。这里直接跳过,
      // 免得同一份内容把 totalBytes 记两遍、在没超预算的工作区上误伤。
      if (files.has(full) || skipped.has(full)) continue

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

      // 两个闸门都要等到「这个文件确定收得下」再判:二进制/超大/读不动的
      // 文件根本不进 files,不该占用文件数配额。
      if (files.size + 1 > budget.maxFiles) {
        aborted = true
        return
      }
      if (totalBytes + buf.byteLength > budget.maxTotalBytes) {
        aborted = true
        return
      }
      totalBytes += buf.byteLength
      files.set(full, buf.toString('utf8'))
    }
  }

  for (const root of roots) {
    await walk(path.resolve(root), true)
    if (aborted) break
  }

  if (aborted) return { files: new Map(), skipped: new Set(), complete: false }
  return { files, skipped, complete: true }
}

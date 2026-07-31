// 「写临时文件 → 校验 → 原子落位」这套动作的通用件。
//
// 抽出来是因为视频落盘和图片落盘要用同一套语义:同样要扛 Windows 的 EBUSY、
// 同样要处理「rename 失败但目标已存在」、同样要在启动时清理崩溃残留。复制两份
// 的话,某天只修好其中一份的概率接近 1。

import fs from 'node:fs/promises'
import path from 'node:path'

/** 下载中的临时文件后缀。两条路径必须一致,否则孤儿清理会漏。 */
export const PART_SUFFIX = '.part'

/**
 * rename 的重试次数与间隔。
 *
 * Windows 上杀毒软件会扫描刚落盘的大文件并短暂锁住句柄,rename 撞 EBUSY 是常态
 * 而非异常 —— 我们落的是 GB 级视频,撞上的概率不低。口径照 electron-updater
 * (60 次 × 500ms,只对 EBUSY 重试)。
 */
const RENAME_ATTEMPTS = 60
const RENAME_DELAY_MS = 500

export interface RenameWithRetryOptions {
  attempts?: number
  delayMs?: number
  /** 测试注入点。 */
  rename?: (from: string, to: string) => Promise<void>
}

export async function renameWithRetry(
  from: string,
  to: string,
  options: RenameWithRetryOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? RENAME_ATTEMPTS
  const delayMs = options.delayMs ?? RENAME_DELAY_MS
  const doRename = options.rename ?? ((f: string, t: string) => fs.rename(f, t))

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await doRename(from, to)
      return
    } catch (e) {
      // 目标已经在了 —— 可能是另一次调用抢先完成的,这种情况报错是错的。
      const landed = await fs
        .access(to)
        .then(() => true)
        .catch(() => false)
      if (landed) {
        await fs.unlink(from).catch(() => undefined)
        return
      }
      const code = (e as { code?: string })?.code
      if (code !== 'EBUSY' || attempt === attempts) throw e
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

/**
 * 清掉目录里残留的 `.part`。崩溃、断电、进程被杀都会留下它们,不清理会一直占磁盘。
 * VS Code 在启动和取消时都会扫缓存目录删 `.tmp`,同一个道理。
 *
 * 任何失败都吞掉:这是启动路径上的清理动作,它自己出问题不该拖垮应用启动。
 */
export async function cleanupOrphanParts(dir: string): Promise<number> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const entry of entries) {
    if (!entry.endsWith(PART_SUFFIX)) continue
    try {
      await fs.unlink(path.join(dir, entry))
      removed += 1
    } catch {
      /* 被占用等情况,下次启动再说 */
    }
  }
  return removed
}

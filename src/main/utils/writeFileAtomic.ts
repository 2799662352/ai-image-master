// 覆盖写一个**已经存在**的小文件:先写临时文件,再 rename 替换,写到一半崩溃 / 断电
// 不会留下截断的目标文件。给凭据这类「必须要么是旧的、要么是新的」的文件用。
//
// ## 为什么不复用 `atomicFile.renameWithRetry`
//
// 那个函数是为「落一个全新路径」(视频 / 图片下载)设计的:rename 失败时,只要目标已存在
// 就**当作成功**(注释:可能是另一次调用抢先完成的)。覆盖写的目标**永远已存在**,
// 于是 Windows 上杀毒软件短暂锁住文件、rename 撞 EBUSY 时,它会静默返回成功 ——
// 盘上留的是**旧内容**,而调用方以为新内容已落盘。对凭据来说就是:下次重启拿到上一个
// token / 密钥,且没有任何错误。
//
// 这里的语义相反:只对「文件被短暂占用」的错误码重试,**最终失败就抛**,让上层如实降级
// (凭据模块退回内存,而不是假装写成功)。

import fs from 'node:fs/promises'

/** 临时文件后缀。清理(例如登出)时要连它一起删。 */
export const ATOMIC_TMP_SUFFIX = '.tmp'

/** Windows 上文件被杀毒软件 / 索引服务短暂占用时的错误码。 */
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])

export interface WriteFileAtomicOptions {
  /** 含首次在内的 rename 尝试次数,默认 5。 */
  attempts?: number
  /** 两次重试之间的等待,默认 100ms。 */
  delayMs?: number
  /** 测试注入点。 */
  rename?: (from: string, to: string) => Promise<void>
}

export async function writeFileAtomic(
  file: string,
  data: Buffer | Uint8Array,
  options: WriteFileAtomicOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? 5
  const delayMs = options.delayMs ?? 100
  const doRename = options.rename ?? ((from: string, to: string) => fs.rename(from, to))
  const tmp = file + ATOMIC_TMP_SUFFIX

  try {
    await fs.writeFile(tmp, data)
    for (let attempt = 1; ; attempt++) {
      try {
        await doRename(tmp, file)
        return
      } catch (e) {
        const code = (e as { code?: string } | null)?.code
        if (!code || !RETRYABLE_CODES.has(code) || attempt >= attempts) throw e
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
  } catch (e) {
    // 失败时别留下临时文件:里面是加密后的凭据,不该在盘上无限期躺着。
    await fs.unlink(tmp).catch(() => undefined)
    throw e
  }
}

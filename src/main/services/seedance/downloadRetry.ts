/**
 * 视频下载的重试策略。
 *
 * 单独成文件是为了能脱开 Electron 的 `net` 直接测:落盘失败的代价很实在 ——
 * 任务当场落 `persistence='failed'`,本地与 COS 都没有副本,只剩上游那条一天后
 * 过期的地址,而这条路径没有第二轮机会。
 *
 * 退避不是装饰:原来的写法是「连试两次、间隔为零」,一次几秒的网络抖动会把两次
 * 一起吃掉。岔开重试才让「抖动」和「真的挂了」区分得开。
 */
export interface RetryDownloadOptions {
  /** 总尝试次数(含首次)。 */
  attempts: number
  /** 首次重试前的等待,其后翻倍。 */
  delayMs: number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

export async function retryDownload<T>(
  attempt: (index: number) => Promise<T>,
  options: RetryDownloadOptions,
): Promise<T> {
  const { attempts, delayMs, sleep = defaultSleep } = options
  let lastError: unknown

  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delayMs * 2 ** (i - 1))
    try {
      return await attempt(i)
    } catch (error) {
      lastError = error
      console.warn(`[seedance] download attempt ${i + 1}/${attempts} failed:`, error)
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

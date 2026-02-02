/**
 * 重试管理器
 * 提供带指数退避的请求重试功能
 */

export interface RetryOptions {
  /** 最大重试次数，默认 3 */
  maxRetries?: number
  /** 基础延迟时间（毫秒），默认 1000 */
  baseDelay?: number
  /** 最大延迟时间（毫秒），默认 10000 */
  maxDelay?: number
  /** 重试时的回调 */
  onRetry?: (attempt: number, error: Error) => void
  /** 判断是否应该重试的函数 */
  shouldRetry?: (error: Error) => boolean
}

/**
 * 带重试机制的异步函数执行器
 * 使用指数退避策略
 * 
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => fetch('/api/data'),
 *   {
 *     maxRetries: 3,
 *     onRetry: (attempt, error) => {
 *       console.log(`重试 ${attempt}/3:`, error.message)
 *     }
 *   }
 * )
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 10000,
    onRetry,
    shouldRetry = () => true
  } = options

  let lastError: Error = new Error('Unknown error')

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      
      // 最后一次尝试失败，直接抛出
      if (attempt === maxRetries) {
        throw lastError
      }

      // 检查是否应该重试
      if (!shouldRetry(lastError)) {
        throw lastError
      }

      // 计算延迟时间（指数退避）
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay)
      
      // 添加随机抖动（±20%）以避免雷群效应
      const jitter = delay * 0.2 * (Math.random() * 2 - 1)
      const finalDelay = Math.round(delay + jitter)
      
      // 调用重试回调
      onRetry?.(attempt, lastError)
      
      // 等待后重试
      await sleep(finalDelay)
    }
  }

  throw lastError
}

/**
 * 延迟函数
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 判断是否为网络错误（可重试）
 */
export function isNetworkError(error: Error): boolean {
  const networkErrorMessages = [
    'network',
    'timeout',
    'abort',
    'ECONNREFUSED',
    'ENOTFOUND',
    'ETIMEDOUT',
    'Failed to fetch',
    'NetworkError'
  ]
  
  const message = error.message.toLowerCase()
  return networkErrorMessages.some(keyword => 
    message.includes(keyword.toLowerCase())
  )
}

/**
 * 判断是否为可重试的 HTTP 状态码
 */
export function isRetryableStatusCode(status: number): boolean {
  // 408: Request Timeout
  // 429: Too Many Requests
  // 500, 502, 503, 504: Server Errors
  return [408, 429, 500, 502, 503, 504].includes(status)
}

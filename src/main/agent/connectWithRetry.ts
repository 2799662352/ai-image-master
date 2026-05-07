export interface RetryOptions<T> {
  attempt: () => Promise<T>
  timeoutMs: number
  intervalMs: number
}

export async function connectWithRetry<T>(options: RetryOptions<T>): Promise<T> {
  const deadline = Date.now() + options.timeoutMs
  let lastError: unknown = new Error('no attempt made')

  while (Date.now() < deadline) {
    try {
      return await options.attempt()
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs))
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`connectWithRetry timed out after ${options.timeoutMs}ms: ${reason}`)
}

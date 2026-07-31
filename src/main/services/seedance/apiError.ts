// Seedance/Ark 的 API 错误类型。
//
// 单独成文件只有一个理由:提交重试(submitRetry)要按状态码判断"这次失败能不能
// 安全重来",而 client.ts 又要用 submitRetry —— 类型留在 client.ts 里就成了循环
// 依赖。行为与原先完全一致,client.ts 仍然 re-export 它,旧的导入路径不受影响。

/**
 * 带上游状态码的 API 错误。调用方（pollLoop / submitRetry）据此区分「重试能自愈」
 * 与「重试只是浪费时间」：密钥失效、参数非法、任务不存在都属于后者。
 */
export class SeedanceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 上游 Retry-After 换算成毫秒（429/503 常带）。 */
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'SeedanceApiError'
  }

  /**
   * 4xx 是请求本身的问题，重试不会自愈；408（请求超时）/425（太早）/429（限流）
   * 与 5xx 是服务端侧的暂时状况，值得重试。HTTP 2xx 但 success:false 属于上游
   * 逻辑拒绝，同样不会自愈。
   */
  get retryable(): boolean {
    if (this.status === 408 || this.status === 425 || this.status === 429) return true
    return this.status >= 500
  }
}

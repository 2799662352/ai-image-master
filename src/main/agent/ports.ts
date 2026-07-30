import net from 'node:net'

/** codex app-server 的扫描区间:[PORT_BASE, PORT_BASE + PORT_RANGE)。 */
const PORT_RANGE = 100

/**
 * 找一个当前空闲的端口。
 *
 * **这个函数只能证明「刚才那一刻端口是空的」。** 探测用的 socket 在返回前就关掉了
 * (端口得留给真正要 bind 的那个进程),而调用方通常还要 spawn 一个子进程才去 bind ——
 * 这中间的窗口关不掉。两个实例同时开工时,顺序扫描会让它们双双选中区间里的第一个
 * 端口,后 bind 的那个死在 `os error 10048`(Windows)/ `EADDRINUSE`。
 *
 * 所以这里做两件事的第一件:**随机起点**,把两个实例撞在同一个端口的概率从「几乎必然」
 * 摊薄到 1/100。真撞上了由调用方用 {@link withPortInUseRetry} 兜底 —— 竞态消不掉,
 * 只能又降概率又能恢复。
 */
export async function pickFreePort(start = 4222): Promise<number> {
  const offset = Math.floor(Math.random() * PORT_RANGE)
  for (let i = 0; i < PORT_RANGE; i += 1) {
    const port = start + ((offset + i) % PORT_RANGE)
    if (await isFree(port)) return port
  }
  throw new Error(`No free port in range ${start}-${start + PORT_RANGE - 1}`)
}

/**
 * 这个错误是不是「端口被占」。
 *
 * 三种写法都要认:Node 自己抛的 `EADDRINUSE`;codex 是 Rust 写的,Windows 上报
 * `os error 10048`、Unix 上报 `os error 98`,而且它是从子进程 stderr 尾巴里捞出来的
 * **文本**,不是带 code 的 Error —— 所以既看 code 也看 message。
 */
export function isPortInUseError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EADDRINUSE') return true
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /EADDRINUSE|os error 10048|os error 98|address already in use/i.test(message)
}

/**
 * 端口撞车就换一个再来。
 *
 * 只对「端口被占」重试:其余失败(二进制缺失、配置错误、鉴权失败)立刻原样抛出 ——
 * 那些重试多少次都是一样的结果,拖着只会让用户多等。
 *
 * 之所以是重试而不是「一次选对」:见 {@link pickFreePort} 里那个关不掉的窗口。
 */
export async function withPortInUseRetry<T>(
  attempt: () => Promise<T>,
  options: { attempts?: number; onRetry?: (error: unknown, attemptsLeft: number) => void } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3)
  let lastError: unknown
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await attempt()
    } catch (error) {
      if (!isPortInUseError(error)) throw error
      lastError = error
      options.onRetry?.(error, attempts - i - 1)
    }
  }
  throw lastError
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    let settled = false

    const finishUnavailable = (): void => {
      if (settled) return
      settled = true
      resolve(false)
    }

    server.once('error', finishUnavailable)
    server.once('listening', () => {
      if (settled) return
      settled = true
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

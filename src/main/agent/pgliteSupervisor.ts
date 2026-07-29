/**
 * PGlite worker 的「死了要能自己活过来」那套判断，抽成纯函数。
 *
 * ## 为什么需要监管
 *
 * `db.ts` 原先只在**启动等待期**挂 `child.on('exit')`，`ready` 一到 `cleanup()`
 * 就把监听摘了。之后 worker 若死掉（崩溃 / Emscripten abort / 内存压力 / 被系统
 * 杀掉），没人知道也没人拉起 —— 本会话后续所有 Prisma 调用全废，直到用户重启
 * 应用。线上表现就是「重启一下就好了」。
 *
 * ## 为什么要熔断
 *
 * 如果 worker 是**起不来**（WASM 坏了、dataDir 有问题、端口被占），无条件重生
 * 会变成 fork 风暴。滚动窗口计数：窗口内超额就停手，改为如实告诉用户需要重启。
 * 与 `pgliteRecovery.ts` 里那个 dataDir 重建熔断是同一套思路，但**刻意不共用
 * 计数器**：那个跨重启持久化（判断「这机器是不是一直坏」），这个只管本会话
 * （判断「现在是不是在打转」），语义不同，混在一起会互相误伤。
 *
 * 放在独立文件里，是为了能脱离 `electron` / `utilityProcess` / PGlite 单测 ——
 * 与 `pgliteRecovery.ts` 同款权衡。
 */

/**
 * 本会话允许的重生次数上限（滚动窗口内）。手调：够宽容偶发崩溃，又不至于在
 * 「怎么都起不来」时无限 fork。
 */
export const RESPAWN_MAX = 5

/** 重生计数的滚动窗口。 */
export const RESPAWN_WINDOW_MS = 10 * 60 * 1000

/**
 * 「连接没了」这一类**瞬时**错误 —— 值得触发恢复 / 重试，而不是当成业务错误
 * 往上抛。
 *
 * 覆盖的几种形态都亲眼见过：
 *   - `P1017` / `Server has closed the connection`：Prisma 对「wire 断了」的统一
 *     报法。socket server 超出 `maxConnections` 时会写一句**非 Postgres 协议**的
 *     裸文本再 `end()`，客户端就报这个（见 pgliteLimits.ts）。
 *   - `Too many connections`：上面那句裸文本本身，偶尔会原样冒上来。
 *   - `ECONNREFUSED`：worker 已经死了，端口没人听。
 *   - `ECONNRESET` / `socket hang up`：worker 正在死的那一瞬。
 *   - `Connection terminated`：node-postgres 在池连接被掐断时的说法。
 *
 * 刻意**不**匹配的：SQL 语法错、唯一键冲突、外键违反等真实业务错误 —— 重试它们
 * 只是把同一个错误再犯一遍。
 */
export function isConnectionLostError(err: unknown): boolean {
  const message = describe(err)
  if (!message) return false
  return (
    /\bP1017\b/.test(message) ||
    /Server has closed the connection/i.test(message) ||
    /Too many connections/i.test(message) ||
    /\bECONNREFUSED\b/.test(message) ||
    /\bECONNRESET\b/.test(message) ||
    /socket hang up/i.test(message) ||
    /Connection terminated/i.test(message)
  )
}

function describe(err: unknown): string {
  if (err == null) return ''
  if (typeof err === 'string') return err
  if (err instanceof Error) {
    // Prisma 把错误码挂在 `code` 上而不一定写进 message
    const code = (err as { code?: unknown }).code
    return `${err.message}\n${typeof code === 'string' ? code : ''}`
  }
  if (typeof err === 'object') {
    const o = err as { message?: unknown; code?: unknown }
    const parts = [o.message, o.code].filter((x): x is string => typeof x === 'string')
    if (parts.length > 0) return parts.join('\n')
  }
  return String(err)
}

export interface RespawnDecision {
  allowed: boolean
  /** 窗口内已经发生过的重生次数（不含这一次）。 */
  recent: number
}

/**
 * 窗口内还允许再重生一次吗。`history` 是历次重生的时间戳（ms）。
 *
 * 不修改入参 —— 调用方拿 {@link pruneRespawnHistory} 自己收敛数组，
 * 免得这里既判断又改状态，测试要同时盯两件事。
 */
export function shouldRespawn(
  history: readonly number[],
  now: number,
  opts: { max?: number; windowMs?: number } = {},
): RespawnDecision {
  const max = opts.max ?? RESPAWN_MAX
  const windowMs = opts.windowMs ?? RESPAWN_WINDOW_MS
  const recent = history.filter((t) => now - t < windowMs).length
  return { allowed: recent < max, recent }
}

/** 丢掉滑出窗口的时间戳。返回新数组。 */
export function pruneRespawnHistory(
  history: readonly number[],
  now: number,
  windowMs: number = RESPAWN_WINDOW_MS,
): number[] {
  return history.filter((t) => now - t < windowMs)
}

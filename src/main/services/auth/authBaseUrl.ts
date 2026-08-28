// IdP 基址。**刻意单独成一个叶子模块,不放在 `session.ts` 里。**
//
// `gatewayToken.ts` 与 `session.ts` 都要用它,而 `session.ts` 又要调
// `gatewayToken.clearGatewayTokens()`(账号被后台停用时一并清掉网关 token)。
// 如果基址仍留在 `session.ts`,这两个模块就会互相 import 成环 —— 今天靠函数声明提升
// 侥幸能跑,但打包器会报循环依赖,而且往后任何一方多加一行模块级初始化都会踩进
// 「import 到一半、拿到未初始化绑定」的经典坑。
//
// 这个模块不 import 任何东西,是依赖图上的叶子,两边都能安全地指向它。
// `session.ts` 仍然 re-export `authBaseUrl`,所以既有调用点(ipc.ts、测试)一行都不用改。

const DEFAULT_BASE_URL = 'https://13797248455.xyz'

/**
 * 每次调用都重读环境变量 —— 不能在模块加载时求值。
 * 主进程模块在 `app` ready 之前就被 import,那时测试或启动脚本可能还没写入覆盖值。
 */
export function authBaseUrl(): string {
  const raw = process.env.CATIMATION_AUTH_BASE_URL?.trim() || DEFAULT_BASE_URL
  return raw.replace(/\/+$/, '')
}

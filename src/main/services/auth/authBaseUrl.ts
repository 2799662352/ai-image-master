// IdP 基址。**刻意单独成一个叶子模块,不放在 `session.ts` 里。**
//
// `gatewayToken.ts` 与 `session.ts` 都要用它,而 `session.ts` 又要调
// `gatewayToken.clearGatewayTokens()`(账号被后台停用时一并清掉网关 token)。
// 如果基址仍留在 `session.ts`,这两个模块就会互相 import 成环 —— 今天靠函数声明提升
// 侥幸能跑,但打包器会报循环依赖,而且往后任何一方多加一行模块级初始化都会踩进
// 「import 到一半、拿到未初始化绑定」的经典坑。
//
// 这个模块**不 import 任何东西**,是依赖图上的叶子,两边都能安全地指向它。
// `session.ts` 仍然 re-export `authBaseUrl`,所以既有调用点(ipc.ts、测试)一行都不用改。
//
// ⚠️ **别在这里 import electron。** 打包闸曾经写成 `import { app } from 'electron'`,
// 结果是 `httpJson` 等一串没有 electron mock 的测试全红(它们只是间接引用了本模块)。
// 所以闸改成由组合根注入 —— 见 `allowAuthBaseUrlOverride`。

const DEFAULT_BASE_URL = 'https://13797248455.xyz'

/** 开发期把 IdP 换到测试服。**打包产物读都不读**,理由见 `authBaseUrl()`。 */
const AUTH_BASE_URL_ENV = 'CATIMATION_AUTH_BASE_URL'

/**
 * 允不允许环境变量改写 IdP 基址。**默认 false —— 缺省即生产。**
 *
 * 由 `main/index.ts` 在启动时按 `!app.isPackaged` 注入。默认关而不是默认开:
 * 忘了注入的后果是「开发时 override 不生效」(看得见、改得动),而反过来是
 * 「打包产物被环境变量牵去测试服」(看不见、且表现为一句没头没脑的 401)。
 * 两种忘记都会发生,要选代价小的那一种。
 */
let overrideAllowed = false

export function allowAuthBaseUrlOverride(allowed: boolean): void {
  overrideAllowed = allowed
}

/**
 * 每次调用都重读环境变量 —— 不能在模块加载时求值。
 * 主进程模块在 `app` ready 之前就被 import,那时测试或启动脚本可能还没写入覆盖值。
 *
 * ## 打包产物无视这个环境变量
 *
 * 与 `resolveGatewayOrigin()` / `resolveMiauBaseUrl()` 完全同一道闸,**三处必须一致**。
 *
 * 之前只有网关那两处有闸、这里没有,于是打包产物跑在设了 `CATIMATION_AUTH_BASE_URL`
 * 的机器上会**劈叉**:登录与额度打测试服后端,而网关被硬闸扳回生产 —— 拿测试服签发的
 * 影子 token 去打生产网关,一律 `401 无效的令牌`,且错误里没有任何一个字提到是环境
 * 配错了。2026-08-31 已经从另一头(万相客户端漏接 origin)撞出过一次同形故障,那次
 * 查了两轮。
 *
 * 闸由组合根注入(`allowAuthBaseUrlOverride`),默认关 —— 证不出这是开发构建,就不该
 * 放行「改凭据去向」这种操作;顺带让测试不受本机是否设了该变量影响。
 */
export function authBaseUrl(): string {
  if (!overrideAllowed) return DEFAULT_BASE_URL
  const raw = process.env[AUTH_BASE_URL_ENV]?.trim() || DEFAULT_BASE_URL
  return raw.replace(/\/+$/, '')
}

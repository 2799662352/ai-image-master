// 桌面端浏览器登录 IPC 编排。PKCE verifier 与 pending 状态只活在主进程,渲染层不可见。

import { ipcMain, shell, type BrowserWindow } from 'electron'
import {
  GatewayTokenError,
  getGatewayToken,
  loadPersisted,
  setActivePool,
  type Pool,
} from './gatewayToken'
import { startLoopbackListener, type LoopbackListener } from './loopback'
import { deriveCodeChallenge, generateCodeVerifier, generateState } from './pkce'
import { onPlatformSpend } from './platformSpend'
import {
  AuthError,
  authBaseUrl,
  claimPairing,
  createRechargeOrder,
  fetchBalance,
  fetchOrganizations,
  fetchPaymentConfig,
  fetchQuota,
  fetchRechargeOrder,
  fetchUsageLogs,
  fetchUsageSummary,
  getAuthState,
  logout,
  startPairing,
} from './session'
import type {
  AuthLoginResult,
  AuthState,
  RechargeTarget,
  UsageQuery,
} from '../../../types/authApi'

// ⚠️ 新增通道必须同时加进这个数组 —— 它是 dispose 时逐个 `removeHandler` 的唯一依据。
// 漏加的症状是热重载后 `ipcMain.handle` 对同一通道抛「second handler」,而不是
// 「某个功能不工作」,所以第一次遇到时很难归因。
const AUTH_CHANNELS = [
  'auth:get-state',
  'auth:start-login',
  'auth:cancel-login',
  'auth:submit-code',
  'auth:logout',
  'auth:get-organizations',
  'auth:get-balance',
  'auth:get-quota',
  'auth:get-payment-config',
  'auth:get-usage-logs',
  'auth:get-usage-summary',
  'auth:create-recharge-order',
  'auth:get-recharge-order',
  'auth:set-billing-pool',
  'auth:clear-billing-pool',
] as const

const CLIENT_NAME = 'CATIMATION Desktop'

/**
 * 当前挂着的消费订阅。模块级,好让重复 `registerAuthIpc` 能先退掉上一份 ——
 * 与 `AUTH_CHANNELS` 那圈 `removeHandler` 是同一条纪律,见那里的注释。
 */
let activeSpendSubscription: (() => void) | null = null

interface PendingLogin {
  pairingId: string
  codeVerifier: string
  listener: LoopbackListener
}

let pending: PendingLogin | null = null

const NETWORK_MESSAGE = '无法连接登录服务,请检查网络或代理后重试'

/**
 * 判据是「有没有拿到 HTTP 状态码」,不是「异常是什么类型」。
 *
 * 断网 / DNS 失败 / TLS 失败时 `net.fetch` 直接抛原始 Error,压根没有响应,
 * 那属于网络问题;拿到了 4xx 才是认证被拒。把这两类混成同一句文案的后果是:
 * 断网的用户看到「授权校验失败,请重新登录」,于是反复重试并开始怀疑自己账号有问题。
 *
 * `status === 0` 与非 AuthError 合并成一个条件而不是各写一支:`session.ts` 的
 * `toAuthError` 只在 `status >= 400` 时构造,所以 0 今天不可达 —— 单独写一支就是
 * 没有任何测试能杀死的死代码。合并后这条判据本身是被测的。
 *
 * ⚠️ **「0 不可达」是一条会被本文件自己破坏的不变量,不只取决于 `session.ts`。**
 * 本文件里还有一处在**手工构造** `AuthError`:`requireGatewayToken` 把
 * `GatewayTokenError` 翻成 `AuthError` 时要凭空补一个 status。它现在补 `400`,
 * 「0 不可达」才继续成立。改那边之前先回来看这里:一旦补成 `0`,这个分支会把那条
 * 翻译过来的 code 整个丢掉、换成 `NETWORK_ERROR` —— 而那个翻译层存在的全部理由
 * 就是保住 code。
 */
function mapLoginFailure(err: unknown): { code: string; message: string } {
  if (err instanceof AuthError && err.status !== 0) {
    switch (err.code) {
      case 'PKCE_MISMATCH':
      case 'GRANT_CODE_MISMATCH':
        return { code: err.code, message: '授权校验失败,请重新登录' }
      case 'PAIRING_ALREADY_CLAIMED':
        return { code: err.code, message: '该授权码已被使用,请重新登录' }
      case 'PAIRING_NOT_APPROVED':
        return { code: err.code, message: '尚未在浏览器中完成授权' }
      case 'PAIRING_EXPIRED':
      case 'PAIRING_NOT_FOUND':
        return { code: err.code, message: '登录已超时,请重新发起' }
      default:
        return { code: err.code, message: err.message }
    }
  }
  return { code: 'NETWORK_ERROR', message: NETWORK_MESSAGE }
}

function broadcastState(getWindow: () => BrowserWindow | null): void {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send('auth:state-changed', getAuthState())
  } catch (e) {
    console.warn('[auth] state-changed broadcast failed:', e)
  }
}

function broadcastLoginResult(
  getWindow: () => BrowserWindow | null,
  result: AuthLoginResult,
): void {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send('auth:login-result', result)
  } catch (e) {
    console.warn('[auth] login-result broadcast failed:', e)
  }
}

/**
 * 「刚花过平台余额,该重新拉一次了」。
 *
 * 不带余额数值,只是一个信号 —— 主进程手上没有权威余额(那是后端的),自己算一份
 * 只会与真值漂移。渲染层收到后走既有的 `getBalance`,口径与它自己拉的完全一致。
 */
function broadcastBalanceStale(getWindow: () => BrowserWindow | null): void {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send('auth:balance-stale')
  } catch (e) {
    console.warn('[auth] balance-stale broadcast failed:', e)
  }
}

function clearPending(): void {
  if (!pending) return
  pending.listener.close()
  pending = null
}

/** `0` / `NaN` / 缺省都视作「没有 producerProjectId」—— 0 不是合法的池键成分。 */
function toOptionalNumber(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * 只认真正的有限 number,**不用 `Number(v)` 强转**。
 *
 * 与上面的 `toOptionalNumber` 是两件不同的事,不能合并:那个刻意把 `0` 当「没有」
 * (0 不是合法池键),而用量参数里 `0` 全是合法语义 —— `projectId: 0` 是「不过滤」、
 * `page: 0` 是 0 基分页的第一页。而 `Number(null)` 与 `Number('')` 都是 `0`,
 * 强转会把「渲染层压根没给这个字段」静默变成一次语义不同的查询,查出来的东西
 * 看着还挺像对的。
 */
function toFiniteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * 渲染层递来的是 `unknown`,这里窄化成 `UsageQuery`。
 *
 * 窄化失败**抛 `AuthError`** 而不是 `as` 硬转往下发:形状不对的对象递到 `session.ts`
 * 只会让 `num(undefined)` 回落成 `0`,于是查到一份别人口径的数据、没有任何报错。
 * 抛在这里、由 `quotaRpc` 兜成信封,UI 才能按 code 分支。
 */
function toUsageQuery(raw: unknown): UsageQuery {
  if (typeof raw !== 'object' || raw === null) {
    throw new AuthError('INVALID_QUERY', 400, '用量查询参数必须是对象')
  }
  const src = raw as Record<string, unknown>

  const projectId = toFiniteNumber(src.projectId)
  if (projectId === undefined) {
    throw new AuthError('INVALID_QUERY', 400, '用量查询缺少 projectId')
  }

  // 逐个显式判 `undefined` 而不是 `if (src.page)`:`page: 0` 是最常用的那一页,
  // falsy 判断恰好在那里把它吞掉,表现成「翻到第二页才有数据」。
  // 反过来也不能无条件塞:凭空造出 `pageSize: 0` 会让 session 走进「没传」的回落分支,
  // 与 UI 以为自己指定的页大小不一致。
  const query: UsageQuery = { projectId }
  const page = toFiniteNumber(src.page)
  if (page !== undefined) query.page = page
  const pageSize = toFiniteNumber(src.pageSize)
  if (pageSize !== undefined) query.pageSize = pageSize
  const startTime = toFiniteNumber(src.startTime)
  if (startTime !== undefined) query.startTime = startTime
  const endTime = toFiniteNumber(src.endTime)
  if (endTime !== undefined) query.endTime = endTime
  return query
}

/**
 * 窄化成三选一的 `RechargeTarget`。
 *
 * 按 kind 逐分支**重建**对象而不是透传原对象:渲染层多送的字段必须在这里被丢掉。
 * `personal` 夹带一个 `projectId` 的后果不是被忽略,而是后端走进成员校验分支 ——
 * 个人计费落点刻意不出现在组织列表里 → 查不到 `joined` → fail-closed 403。
 *
 * 反向的 `producer` 两半则**一个都不能丢**:池键是 `(producerId, producerProjectId)`,
 * 缺一后端 400。在这里拒掉比让后端拒省一个 RTT,且错误信息指向真正的原因。
 *
 * 这里用不了 `session.ts` 那种 `never` 兜底:入参是 `unknown`,default 分支是可达的
 * 运行时路径而不是编译期断言。
 */
function toRechargeTarget(raw: unknown): RechargeTarget {
  if (typeof raw !== 'object' || raw === null) {
    throw new AuthError('INVALID_TARGET', 400, '充值目标必须是对象')
  }
  const src = raw as Record<string, unknown>

  switch (src.kind) {
    case 'personal':
      return { kind: 'personal' }
    case 'project': {
      const projectId = toFiniteNumber(src.projectId)
      if (projectId === undefined) {
        throw new AuthError('INVALID_TARGET', 400, '充值目标 project 缺少 projectId')
      }
      return { kind: 'project', projectId }
    }
    case 'producer': {
      const producerId = toFiniteNumber(src.producerId)
      const producerProjectId = toFiniteNumber(src.producerProjectId)
      if (producerId === undefined || producerProjectId === undefined) {
        throw new AuthError(
          'INVALID_TARGET',
          400,
          'producer 充值目标的 producerId 与 producerProjectId 必须成对',
        )
      }
      return { kind: 'producer', producerId, producerProjectId }
    }
    default:
      throw new AuthError('INVALID_TARGET', 400, `未知的充值目标 kind ${String(src.kind)}`)
  }
}

/**
 * 只保证「是个数字」。**区间校验归 `session.ts`** —— 上限常量在那边,两处各写一份必然漂移。
 *
 * 但 code 与那边保持一致(`INVALID_AMOUNT`):同一种毛病在 UI 上只该有一个分支。
 */
function toAmountCny(raw: unknown): number {
  const amount = toFiniteNumber(raw)
  if (amount === undefined) {
    throw new AuthError('INVALID_AMOUNT', 400, `充值金额必须是数字(当前 ${String(raw)})`)
  }
  return amount
}

function toOutTradeNo(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) {
    throw new AuthError('INVALID_ORDER_NO', 400, '订单号无效')
  }
  return raw
}

/**
 * 窄化成计费池引用。真源类型是 `gatewayToken.ts` 的 `Pool`。
 *
 * 这里用 `Number()` 强转而不是上面的 `toFiniteNumber`,是因为本字段的合法域不含 `0`:
 * `Number(null)` / `Number('')` 都落成 `0`,而 `0` 在这里本来就要被拒 —— 强转带来的
 * 那个歧义在这一格恰好不存在(与用量查询相反,那边 `projectId: 0` 是「不过滤」)。
 *
 * `producerProjectId` 归一成 **`null` 而不是 `undefined`**:它是池键的另一半,
 * `gatewayToken.ts` 拿两半拼缓存键。塞 `undefined` 会拼出一个与真池不同的键,
 * 表现成每次切池都白白重取一次 token,而且没有任何报错。
 */
function toBillingPool(raw: unknown): Pool {
  const src = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const projectId = Number(src.projectId)
  if (!Number.isFinite(projectId) || projectId <= 0) {
    throw new AuthError('INVALID_POOL', 400, `projectId 不合法(当前 ${String(src.projectId)})`)
  }
  return { projectId, producerProjectId: toOptionalNumber(src.producerProjectId) ?? null }
}

/**
 * 取网关凭据,并把 `GatewayTokenError` 翻成 `AuthError`,好让它的 code 过得了信封。
 *
 * `quotaRpc` 只认 `AuthError`,别的一律合成 `QUERY_FAILED`。而本文件里唯一会抛
 * `GatewayTokenError` 的就是这条路径,它的 code 恰恰是 UI 唯一的分流依据:
 * `NOT_LOGGED_IN` 要引导去登录、余额类要引导去充值、权限类要引导换个池。压成同一个
 * code 等于把信封退化回「出错了」—— 那正是当初不裸抛的理由。
 *
 * `status` 给 `400`,而**绝不能给 `0`**。`GatewayTokenError` 本身没有这一维(HTTP 码已经
 * 编进它的 code 里,形如 `HTTP_502`),所以这个数字是我们凭空补的 —— 但补什么不是随意的:
 *
 * 审计范围是**本文件所有读 `status` 的地方**,不只是 `quotaRpc`(它确实不读)。今天还有
 * 一个:`mapLoginFailure` 把 `status === 0` 当作「压根没拿到 HTTP 状态码 ⇒ 网络问题」的
 * 哨兵,进而**丢弃 code**、一律回 `NETWORK_ERROR`。也就是说 `0` 恰好是全仓唯一一个会让
 * code 被压平的取值 —— 而这个翻译层存在的全部理由就是不让 code 被压平。
 *
 * 今天这两条路还没接上(本函数只被 `auth:set-billing-pool` 调,异常就地被 `quotaRpc`
 * 吃掉,逃不到 `mapLoginFailure`),所以填 0 不是活 bug。但只要有人把「登录成功、取网关
 * token 失败」接进登录失败映射,填 0 就会静默复现这个翻译层要解决的那个问题。
 * `400` 与同文件其余几处窄化(`INVALID_QUERY` / `INVALID_TARGET` / `INVALID_AMOUNT` /
 * `INVALID_POOL`)一致,且稳稳落在 `status !== 0` 那条保住 code 的分支里。
 *
 * **返回 void 而不是 token。** 调用方只需要「取到了」这个事实;把 token 摆到这一层
 * 的局部变量里,下一个人顺手 `return { ready: true, token }` 就成了。
 */
async function requireGatewayToken(pool: Pool): Promise<void> {
  try {
    await getGatewayToken(pool)
  } catch (e) {
    if (e instanceof GatewayTokenError) throw new AuthError(e.code, 400, e.message)
    throw e
  }
}

type QuotaRpcResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } }

/**
 * 把一次额度查询包成信封。
 *
 * `code` 保证是非空字符串:非 `AuthError`(断网、DNS 失败、超时)也合成一个,
 * 否则渲染层按 code 分支时会落到 `undefined`,表现成「什么提示都没有」。
 */
async function quotaRpc<T>(work: () => Promise<T>): Promise<QuotaRpcResult<T>> {
  try {
    return { ok: true, data: await work() }
  } catch (e) {
    if (e instanceof AuthError) {
      return { ok: false, error: { code: e.code, message: e.message } }
    }
    return {
      ok: false,
      error: { code: 'QUERY_FAILED', message: e instanceof Error ? e.message : String(e) },
    }
  }
}

function assertAuthorizeOrigin(authorizeUrl: string): void {
  const expected = new URL(authBaseUrl()).origin
  const actual = new URL(authorizeUrl).origin
  if (actual !== expected) {
    console.error('[auth] authorizeUrl origin mismatch:', { expected, actual, authorizeUrl })
    throw new Error('授权链接来源不可信')
  }
}

async function completeClaim(
  getWindow: () => BrowserWindow | null,
  active: PendingLogin,
  grantCode: string,
): Promise<void> {
  try {
    await claimPairing(active.pairingId, grantCode, active.codeVerifier)
    broadcastState(getWindow)
    broadcastLoginResult(getWindow, { ok: true })
  } catch (err) {
    broadcastLoginResult(getWindow, { ok: false, ...mapLoginFailure(err) })
  } finally {
    if (pending === active) {
      active.listener.close()
      pending = null
    }
  }
}

function detachWaitAndClaim(
  getWindow: () => BrowserWindow | null,
  active: PendingLogin,
): void {
  void active.listener.waitForCode().then(
    (grantCode) => completeClaim(getWindow, active, grantCode),
    (err) => {
      broadcastLoginResult(getWindow, { ok: false, ...mapLoginFailure(err) })
      if (pending === active) {
        active.listener.close()
        pending = null
      }
    },
  )
}

/**
 * 注册全部 auth IPC 通道,并返回 disposer。
 *
 * ⚠️ **名字只说了一半:它同时是 auth 子系统的启动钩子。** 除了挂通道,它还会把上次
 * 会话加密落盘的网关 token 读回内存(`loadPersisted()`)。
 *
 * 为什么这件事挂在这儿:
 * - **时机**:`loadPersisted` 内部要用 `app.getPath('userData')` 与 safeStorage,两者
 *   在 app ready 之前都不可用(与 `credentials.ts` 顶部那条「不得在模块加载时读盘」
 *   同源)。本函数只被 `app.whenReady()` 里的启动序列调到,时机由构造保证。
 * - **可测**:另一个选择是在 `src/main/index.ts` 里裸调一行,但那是个 2900 行的入口
 *   模块,在 vitest 里 import 不起来(会拉起 prisma / MCP / electron 全家桶),只能靠
 *   「读源码文本做断言」这种脆测试来守。放在这里,`ipc.test.ts` 能真测到它被调用、
 *   且**没有**在模块加载期被调用。
 */
export function registerAuthIpc(getWindow: () => BrowserWindow | null): () => void {
  // 刻意不 await:读盘 + 解密不该挡在窗口创建前面,而它晚到也不会出错 ——
  // `loadPersisted` 自带登出代际守卫,填回内存前会再比一次,不会把刚清掉的 token 复活。
  void loadPersisted()

  for (const ch of AUTH_CHANNELS) {
    ipcMain.removeHandler(ch)
  }

  // 消费信号 → 渲染层刷余额。
  //
  // 订阅装在这里而不是模块顶层:模块加载期还没有窗口可广播。
  //
  // 先退掉上一份,理由与上面那圈 `removeHandler` **完全相同** —— 生产上本函数的
  // 返回值(disposer)是被丢掉的,没人调;而热重载 / 测试会重复进来。不退的话订阅
  // 只增不减,一次消费就广播 N 遍,渲染层跟着拉 N 次余额。这种「越用越慢」的形状
  // 不会有任何东西变红。
  activeSpendSubscription?.()
  activeSpendSubscription = onPlatformSpend(() => broadcastBalanceStale(getWindow))
  const unsubscribeSpend = activeSpendSubscription

  ipcMain.handle('auth:get-state', () => getAuthState())

  ipcMain.handle('auth:start-login', async () => {
    clearPending()

    const codeVerifier = generateCodeVerifier()
    const codeChallenge = deriveCodeChallenge(codeVerifier)
    const state = generateState()

    // 授权完成后把浏览器送回站点主页:否则用户被扔在 `127.0.0.1:<port>/cb?code=...` 上,
    // 地址栏里还挂着授权码。地址由本进程的 authBaseUrl() 推导,不取自请求。
    const listener = await startLoopbackListener({
      state,
      redirectTo: `${authBaseUrl()}/home`,
    })

    try {
      const pairing = await startPairing(
        CLIENT_NAME,
        { host: listener.host, port: listener.port },
        { codeChallenge, state },
      )

      assertAuthorizeOrigin(pairing.authorizeUrl)

      pending = {
        pairingId: pairing.pairingId,
        codeVerifier,
        listener,
      }

      await shell.openExternal(pairing.authorizeUrl)
      detachWaitAndClaim(getWindow, pending)

      return { authorizeUrl: pairing.authorizeUrl, expiresIn: pairing.expiresIn }
    } catch (err) {
      // `pending` 在 openExternal 之前就已赋值,所以这里不能只关端口:openExternal
      // 抛错(无默认浏览器、URL 被系统拒绝)时若把 pending 留着,它就指向一个已关闭的
      // 监听器 —— 随后 submit-code 会对着一个永远收不到回调的配对去 claim,
      // clearPending() 还会对同一个监听器二次 close。
      listener.close()
      if (pending?.listener === listener) pending = null
      throw err
    }
  })

  ipcMain.handle('auth:cancel-login', () => {
    clearPending()
  })

  ipcMain.handle('auth:submit-code', async (_event, grantCode: unknown) => {
    if (typeof grantCode !== 'string' || !grantCode) {
      throw new Error('授权码无效')
    }
    const active = pending
    if (!active) {
      throw new Error('当前没有进行中的登录')
    }
    await completeClaim(getWindow, active, grantCode)
  })

  ipcMain.handle('auth:logout', async () => {
    // `logout()` 自己把网关 token 一起清掉(见 `session.logout()` 的注释:那条不变量
    // 刻意收在那里,不散在调用方)。这里**只需要 await** —— 里面压着一次 `fs.rm`,
    // 不等它就广播「已登出」,用户此刻关掉应用,进程退出会把删盘截断。
    await logout()
    broadcastState(getWindow)
  })

  // ── 额度查询 ──
  //
  // 一律回 `{ ok, data } | { ok: false, error }` 信封,**不裸抛**。
  // 裸抛经 IPC 会被包成 "Error invoking remote method '…'",后端的 error code 全部
  // 丢失 —— 而 UI 要按 code 分支(余额不足 / 无权访问该项目 / 未登录 三种动作不同)。
  ipcMain.handle('auth:get-organizations', () => quotaRpc(() => fetchOrganizations()))
  ipcMain.handle('auth:get-balance', (_e, projectId: unknown, producerProjectId: unknown) =>
    quotaRpc(() => fetchBalance(Number(projectId), toOptionalNumber(producerProjectId))),
  )
  ipcMain.handle('auth:get-quota', () => quotaRpc(() => fetchQuota()))
  ipcMain.handle('auth:get-payment-config', () => quotaRpc(() => fetchPaymentConfig()))

  // ── 用量明细与原生充值 ──
  //
  // 同一套信封。窄化刻意放在 `quotaRpc` 的**闭包内**而不是 handler 开头:放在外面
  // 窄化失败就是裸抛,那正是 code 会被 Electron 吞掉的那条路径 —— 而 UI 对
  // INVALID_QUERY / INVALID_TARGET / INVALID_AMOUNT 的动作各不相同。
  ipcMain.handle('auth:get-usage-logs', (_e, query: unknown) =>
    quotaRpc(() => fetchUsageLogs(toUsageQuery(query))),
  )
  ipcMain.handle('auth:get-usage-summary', (_e, query: unknown) =>
    quotaRpc(() => fetchUsageSummary(toUsageQuery(query))),
  )
  ipcMain.handle(
    'auth:create-recharge-order',
    (_e, amountCny: unknown, target: unknown, subject: unknown) =>
      quotaRpc(() =>
        createRechargeOrder(
          toAmountCny(amountCny),
          toRechargeTarget(target),
          // 空串会让 session 把 `subject` 整个字段省掉(它自己也判了一次),
          // 但在这里就归一成 undefined,免得两层各有一套「什么算没填」。
          typeof subject === 'string' && subject ? subject : undefined,
        ),
      ),
  )
  ipcMain.handle('auth:get-recharge-order', (_e, outTradeNo: unknown) =>
    quotaRpc(() => fetchRechargeOrder(toOutTradeNo(outTradeNo))),
  )

  // ── 平台计费池 ──
  //
  // 这两条是「用平台余额出图」整条链路上唯一的生产调用方。在它们之前
  // `setActivePool()` 从没被调用过,于是 `getActivePoolToken()` 永远回 null、
  // 出网时的凭据注入器永远注入不到东西 —— 前两个任务的成果一直是死的。
  //
  // **刻意没有任何一条通道会回 token。** 渲染层只需要知道「平台计费此刻可不可用」;
  // 那枚凭据永不过期、泄漏后无法单独吊销,而渲染层是 `nodeIntegration: true` 且无
  // contextIsolation 的环境 —— 递过去一次就等于永久交出去。
  ipcMain.handle('auth:set-billing-pool', (_e, raw: unknown) =>
    quotaRpc(async () => {
      const pool = toBillingPool(raw)
      // 🚨 顺序不能反:**先取到凭据,再置 active**。反过来写的话,取凭据失败的用户
      // 会看到「已切换到平台余额」,而注入器手里什么都没有 —— 他以为自己在花平台的
      // 钱,实际要么还在扣自填 key,要么每张图都失败而找不到原因。
      await requireGatewayToken(pool)
      setActivePool(pool)
      // 只回「能不能用」,不回凭据本身。
      return { ready: true }
    }),
  )

  ipcMain.handle('auth:clear-billing-pool', () =>
    quotaRpc(async () => {
      // 只摘 active,**不清缓存** —— 清缓存是登出的事(`clearGatewayTokens`)。
      // 在这里顺手清掉的话,用户来回切两次池就多两次网络往返。
      setActivePool(null)
      return null
    }),
  )

  return () => {
    clearPending()
    unsubscribeSpend()
    // 只在还是自己那份时清:后来者已经把上一份退掉并换成它的了,这里再置 null
    // 会让**它**的引用丢失,于是再下一次注册退不掉它 —— 正是这段要防的事。
    if (activeSpendSubscription === unsubscribeSpend) activeSpendSubscription = null
    for (const ch of AUTH_CHANNELS) {
      ipcMain.removeHandler(ch)
    }
  }
}

export type { AuthState, AuthLoginResult }

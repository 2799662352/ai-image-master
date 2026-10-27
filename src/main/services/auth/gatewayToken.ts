import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
// 基址取自叶子模块而不是 `./session`:session 现在要 import 本模块(账号被后台停用时
// 一并清网关 token),再反向 import 回去就成环。见 `authBaseUrl.ts` 顶部。
import { authBaseUrl } from './authBaseUrl'
import { getCredential } from './credentials'

export interface Pool {
  projectId: number
  /** producer 池才有。**它是池键的另一半**,只按 projectId 认会把两个池悄悄合并。 */
  producerProjectId: number | null
}

export class GatewayTokenError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'GatewayTokenError'
  }
}

function poolKey(p: Pool): string {
  return `${p.projectId}:${p.producerProjectId ?? ''}`
}

/** 明文 token 只活在这里。**绝不导出这个 Map,绝不经 IPC 下发。** */
const cache = new Map<string, string>()
/** 同一个池的并发请求合流成一次网络往返,避免 N 个出图任务同时打后端。 */
const inflight = new Map<string, Promise<string>>()
let activePool: Pool | null = null
/**
 * 登出代际。`clearGatewayTokens()` 自增,在途请求靠它判断自己是不是已经过期。
 *
 * 清 `inflight` 只删 Map 条目,**取消不了已经建好的 promise 链** —— 那条链稍后
 * 仍会 resolve 并接着写缓存、落盘,而 `fs.rm` 早就跑完了。结果是用户点完登出,
 * 盘上又躺回一枚永不过期、无法单独吊销的 token。
 */
let generation = 0

/**
 * 置当前计费池,并把它一起落盘。
 *
 * **落盘是这个函数存在的一半意义**:池不落盘的话,重启后主进程手上有 token 却
 * 不知道该用哪个池,`getActivePoolToken()` 一律回 null,视频那条路就静默退回
 * 用户自填的 Miau Key(见 `PersistedV2` 的注释里那次真机故障)。
 *
 * 同步返回、异步落盘:调用方(`auth:set-billing-pool`)已经在它自己的 await 链上
 * 完成了「取得凭据」这件真正要紧的事,落盘只是让下次启动少走一趟。失败也不该让
 * 切池动作报错 —— 最坏的后果是回到「重启后需要重新 arm」,也就是这个改动之前的
 * 行为,而不是任何新的坏事。
 */
export function setActivePool(pool: Pool | null): void {
  activePool = pool
  void persist(generation).catch(() => {})
}

/**
 * 给 header 注入器用的同步读。
 *
 * 必须同步:`onBeforeSendHeaders` 在每个请求的热路径上,在那里 await 一次网络
 * 往返会把出图请求整体拖慢,且首次调用时会让请求排队。所以取 token 的时机是
 * 「用户切池 / 登录成功」,不是「请求发出时」。取不到就返回 null,让请求带着
 * 标记头原样出去 —— 网关会回 401,渲染层按既有错误路径提示,不会静默失败。
 */
export function getActivePoolToken(): string | null {
  if (!activePool) return null
  return cache.get(poolKey(activePool)) ?? null
}

/**
 * 当前计费池本身(不含凭据)。
 *
 * 存在的理由只有一个:**素材登记必须落在正在计费的那个池里**。上游把 group 按
 * `project-<id>` / `project-<id>-pp-<ppId>` 懒创建,登记进 A 池的 asset 在 B 池下
 * 读不出来(不是陈旧,是不存在)——所以「用哪枚 token 提交」与「素材登记进哪个池」
 * 必须同源。这里回的正是 `getActivePoolToken()` 取 token 用的那个池。
 *
 * ⚠️ **不要改成从渲染层传池。** 渲染层的池认知与主进程之间存在已知的失步窗口
 * (`seedanceGateway/credentials.ts` 的「已知缺口」),两边不同源的后果是素材登记进
 * 一个与计费池不同的组,而那时 `asset://` 会在提交时解析失败 —— 且报出来的错
 * 完全指不到成因。
 *
 * 回的是拷贝:调用方拿去传给别的模块,不该能改到本模块的状态。
 */
export function getActivePool(): Pool | null {
  return activePool ? { ...activePool } : null
}

/**
 * 打网关所需的**完整**请求头:`Authorization` 与计费归属绑在一起。
 *
 * ## 为什么是一个函数,而不是「取 token」+「取归属」两个
 *
 * 分开取的那一天,就是归属被忘掉的那一天 —— 而忘掉**不报任何错**:
 * 钱照扣、图照出、片照生成,唯一的症状是事后在用量明细里查不到这笔消费。
 * 2026-08-29 真机撞过一次:余额准确减少、后台显示「共 0 条」,
 * 第一反应是钱被吞了,查了很久才落到请求头上。
 *
 * 所以这里**不提供只拿归属、或只拿 Authorization 的入口**。
 * 想给网关发请求,就只能拿到这一整份。
 *
 * (`getActivePoolToken()` 仍然导出,但它是给**判定**用的 ——
 * 「此刻有没有平台凭据」——不是给出网组头用的。)
 *
 * ## 为什么必须带归属
 *
 * 上游 new-api 的归属字段是从**请求头**取的,不是从 token 反查的:
 *
 *   - 任务:`controller/relay.go:801-806`
 *     `task.PrivateData.PlatformUserId = c.GetHeader("X-Platform-User-Id")`
 *   - 消费日志:`model/log.go:400-423` 同款回退,另有 producer 两个头
 *
 * 而查询是 `WHERE platform_user_id = ? AND project_id = ?`
 * (`model/log.go:332-336`)。只发 `Authorization` 的话,行会以
 * `platform_user_id=''` / `project_id=0` 落库 —— **不是没写,是写成了查不到的样子**。
 *
 * 扣费不受影响(走 token 的 allocation),所以这个 bug 的症状是
 * 「余额少了、流水 0 条」,用户第一反应必然是钱被吞了。2026-08-29 真机确认过:
 * new-api 侧任务记录 `quota=2504700 status=SUCCESS` 齐全,平台侧流水却停在五天前。
 *
 * ## 为什么缺了就回空对象,而不是发空串
 *
 * `X-Platform-User-Id: ''` 与不发是两回事:前者会让上游把空串当成一个合法的归属值
 * 写进去,与今天的坏状态一样查不到,却更难在事后分辨「没带头」和「带了个空的」。
 *
 * ## producer 池要发两半
 *
 * 池键是 `(projectId, producerProjectId)`。少发一半,流水会记到错的子项目上 ——
 * 后台那句「无法单独拆出当前池」正是这个问题的表现。
 * 与网页版 `getAuthHeaders()` 发的两个头保持一致(它今天的流水是能查到的)。
 */
export function gatewayPlatformHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }

  const pool = activePool
  const userId = getCredential()?.userId
  if (!pool || !userId) return headers

  headers['X-Platform-User-Id'] = userId
  headers['X-Project-Id'] = String(pool.projectId)
  if (pool.producerProjectId !== null && pool.producerProjectId > 0) {
    headers['X-Producer-Project-Id'] = String(pool.producerProjectId)
  }
  return headers
}

export async function getGatewayToken(pool: Pool): Promise<string> {
  const key = poolKey(pool)
  const hit = cache.get(key)
  if (hit) return hit

  const running = inflight.get(key)
  if (running) return running

  const gen = generation
  const task = fetchToken(pool)
    .then(async (token) => {
      // 出发之后有人登出了。token 照常还给调用方(它自己会撞 401,不必额外造错),
      // 但**一个字节的状态都不能写** —— 写了就是把刚清空的缓存和刚删掉的加密
      // 文件原样填回去。
      if (gen !== generation) return token
      cache.set(key, token)
      // `gen` 要继续往下传:这道守卫只管到 `cache.set`,`persist()` 内部还隔着两个
      // await(可用性探测 + 加密),那两段里登出的话密文照样会被写回盘。
      await persist(gen).catch(() => {})
      return token
    })
    .finally(() => {
      // 已知的 ABA,**刻意不修**:t0 建 taskA → 登出 `inflight.clear()` → t2 建
      // 同键的 taskB → taskA 的这个 finally 把 taskB 的条目删掉。于是第三个并发
      // 调用不再合流,会另起一次网络往返、再多一次磁盘写。
      // 之所以只是浪费而不是错误:`generation` 守卫保证被误删的那个任务写不坏
      // 任何状态,两个任务拿到的也都是同一个池的合法 token。
      // 真要修就是 `if (inflight.get(key) === task) inflight.delete(key)`。
      inflight.delete(key)
    })
  inflight.set(key, task)
  return task
}

async function fetchToken(pool: Pool): Promise<string> {
  const cred = getCredential()
  if (!cred?.token) {
    throw new GatewayTokenError('NOT_LOGGED_IN', '未登录,无法使用平台余额')
  }

  const url = new URL('/api/user/gateway-token', authBaseUrl())
  url.searchParams.set('projectId', String(pool.projectId))
  if (pool.producerProjectId) {
    url.searchParams.set('producerProjectId', String(pool.producerProjectId))
  }

  let resp: Response
  try {
    resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${cred.token}` },
    })
  } catch {
    // 断网 / DNS 失败。刻意不带原始错误 —— 它对用户无意义,而 message 里可能
    // 含完整 URL。可重试。
    throw new GatewayTokenError('NETWORK', '连不上服务器,请检查网络后重试', true)
  }

  const body = (await resp.json().catch(() => null)) as
    | { success?: boolean; data?: { token_key?: string }; error?: { code?: string; message?: string } }
    | null

  if (!resp.ok || !body?.success) {
    const code = body?.error?.code ?? `HTTP_${resp.status}`
    const message = body?.error?.message ?? '获取平台凭据失败'
    throw new GatewayTokenError(code, message, resp.status >= 500)
  }

  const token = body.data?.token_key
  if (!token) {
    // 200 但 body 畸形。**绝不把 body 打出来** —— 它畸形归畸形,仍可能夹带
    // 部分凭据。只记形状。
    throw new GatewayTokenError('MALFORMED_RESPONSE', '服务端返回的凭据格式不对', true)
  }
  return token
}

// ── 落盘 ───────────────────────────────────────────────────────────────────

function storePath(): string {
  return path.join(app.getPath('userData'), 'gateway-tokens.enc')
}

/**
 * 有没有**真的**加密。三道判断,每道都有依据:
 *
 * 1. 问 `isAsyncEncryptionAvailable()` 而不是同步的 `isEncryptionAvailable()`。
 *    异步加密器是惰性初始化的(electron.d.ts:11881),两者结论可以不一致;不一致
 *    时 `encryptStringAsync` 会 reject,而调用处的 `.catch(() => {})` 把它整个吞
 *    掉 —— 表现为「以为落了盘,其实一直没落」,零信号。落盘走异步链路,就得问
 *    异步链路自己的可用性。
 * 2. 非 Linux 直接认为有效。`getSelectedStorageBackend()` 标着 `@platform linux`
 *    (electron.d.ts:11874);Electron 43.2.0 + win32 实测 `typeof` 就是
 *    `'undefined'`,调用直接抛 TypeError。不短路的话它会掉进下面的 catch,等于
 *    **在我们的主力平台上永久关掉落盘** —— 每次重启白白多一次网络往返,还不报错。
 * 3. Linux 上只否掉 `basic_text`。它用硬编码明文口令,等于没加密,而
 *    `isEncryptionAvailable()` 在这个后端下**照样返回 true**(它只回答「有没有加密
 *    能力」,不回答「这加密有没有用」)。我们出 AppImage,那正是最容易没有 secret
 *    store 的场景。
 *
 *    判据是「等于 basic_text」而不是「在白名单里」:后端枚举一直在长(kwallet →
 *    kwallet5 → kwallet6),白名单写死在今天,明天 Electron 加个 kwallet7 就会静默
 *    停止落盘。只否掉已知坏的那一个,新来的按好的用。
 *
 * ⚠️ **这个函数是 async,调用处必须 `await`。** 写成 `if (!encryptionIsReal())` 的话,
 * 对 Promise 取 `!` **恒为 false**(Promise 永远 truthy),而 TS **不会报错**(`!`
 * 接受任意类型)。后果是整个落盘判据静默失效:basic_text 明文后端照样落盘,一个
 * 信号都没有。当前两个调用点(`persist()` / `loadPersisted()`)都已 `await`。
 */
async function encryptionIsReal(): Promise<boolean> {
  try {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return false
    if (process.platform !== 'linux') return true
    // app ready 之前调会返回 'unknown',但那时上面一步已经是 false,走不到这里。
    return safeStorage.getSelectedStorageBackend() !== 'basic_text'
  } catch {
    // 判不出来就当没加密:宁可每次重取,不可明文落盘。
    return false
  }
}

/**
 * 落盘信封。
 *
 * v1 是**裸的** `Record<poolKey, token>`;v2 把 `pool` 一起收进来。
 *
 * ## 为什么 pool 必须跟 token 一起落盘
 *
 * 只落 token 的那版,重启后主进程是「手上有钥匙,但不知道该开哪把锁」——
 * `activePool` 是模块级内存,启动时为 null,于是 `getActivePoolToken()` 一律回
 * null。视频那条路(万相 / 平台版 Seedance)在主进程里就是靠它判「此刻能不能走
 * 平台余额」的,判不出来就落到用户自填的 Miau Key。
 *
 * 2026-08-31 真机撞到:用户已登录、余额显示正常、codex 聊天也在正常扣平台余额,
 * 但工作台出万相时收到 `401 Invalid token` —— 因为那一刻主进程 activePool 还是
 * null,而用户自填的 Key 位里存着一个测试时随手填的 `1`。错误来自上游,里面不会
 * 有任何一个字提到「这次用的是自填 Key」。
 *
 * 这也是渲染层 `billingSource` 得以持久化的前提:它原先刻意不持久化,理由正是
 * 「重启后主进程还没 arm,渲染层先打标记头会让每个请求 401」。池落了盘,主进程
 * 启动即 armed,那条理由就不成立了。两处改动是一对,不能只做一半。
 */
interface PersistedV3 {
  v: 3
  /**
   * 签发这批 token 的 IdP 基址。**v3 存在的唯一理由。**
   *
   * 缓存键只有 `(projectId, producerProjectId)`,不含环境 —— 于是一台在测试服登录过的
   * 机器,换回生产之后 `loadPersisted()` 照样把那枚**测试服**的 token 读回内存并 arm
   * 上去,第一笔请求就是 `401 无效的令牌`。而且 v2 起池也一并落盘,这条路比以前更顺畅。
   *
   * 打包产物本身有硬闸(`authBaseUrl()` / `resolveGatewayOrigin()` 都无视环境变量),
   * 但那只保证「发给谁」,保证不了「用谁签的凭据」—— 盘上的东西是上一次运行留下的。
   *
   * 不匹配时整份丢弃而不是逐条筛:token 是**可丢弃的缓存**,重取一次网络往返而已;
   * 而留下任何一条来路不明的凭据,换来的是一个没人能从错误里看出成因的 401。
   */
  authBaseUrl: string
  /** 当前计费池。null = 登录了但没选池(或用户切回了自填 Key)。 */
  pool: Pool | null
  tokens: Record<string, string>
}

/** `gen` 是调用方出发时的代际,见下面写盘前那道守卫。 */
async function persist(gen: number): Promise<void> {
  if (!(await encryptionIsReal())) return // 只留内存,重启后重取
  const envelope: PersistedV3 = {
    v: 3,
    authBaseUrl: authBaseUrl(),
    pool: activePool,
    tokens: Object.fromEntries(cache),
  }
  const payload = JSON.stringify(envelope)
  const buf = await safeStorage.encryptStringAsync(payload)
  // 上面两个 await 之间都可能有人登出。`payload` 是登出**之前**快照的,密文里带着
  // token,而 `fs.rm` 早已跑完 —— 写下去就是把一枚永不过期、无法单独吊销的 token
  // 亲手送回盘上。所以落地前必须再比一次,而不是只信调用处那道。
  if (gen !== generation) return
  await fs.writeFile(storePath(), buf)
}

export async function loadPersisted(): Promise<void> {
  // 在第一个 await 之前记下代际:下面读盘、解密全是 await,任何一段里登出,
  // 填回内存就等于把刚清掉的 token 复活。
  const gen = generation
  if (!(await encryptionIsReal())) return
  try {
    const buf = await fs.readFile(storePath())
    // 异步版**不返回字符串**,返回 `{ shouldReEncrypt, result }`(electron.d.ts
    // 的 `DecryptStringAsyncReturnValue`)—— 与同步的 `decryptString` 不同。
    // 直接把它交给 `JSON.parse` 不只是类型错,运行时会被 stringify 成
    // "[object Object]" 而抛 SyntaxError,再被下面的 catch 吞掉:表现为
    // 「落盘了但重启后永远读不回来」,一个错都不报。
    // `shouldReEncrypt` 刻意不处理:token 是可丢弃的缓存,下次取用时会重新落盘。
    const { result: json } = await safeStorage.decryptStringAsync(buf)
    // 填回去的话,`getActivePoolToken()` 立刻就能把它交给 header 注入器,
    // 下一次 `persist()` 又会把它写回盘 —— 登出被整个撤销。
    if (gen !== generation) return
    const parsed: unknown = JSON.parse(json)
    const { tokens, pool } = readEnvelope(parsed)
    for (const [k, v] of Object.entries(tokens)) {
      if (typeof v === 'string' && v) cache.set(k, v)
    }
    // 池要在 token 之后才置:反过来的话,中间那一瞬 `getActivePoolToken()` 会
    // 拿着新池去查一个还没填好的缓存,回 null —— 而调用方会把 null 读成
    // 「没有平台凭据」,退回自填 Key。这里全同步,窗口极短,但语义上仍该是
    // 「凭据先就位,再宣布可用」,与 `auth:set-billing-pool` 那条同一个顺序纪律。
    //
    // 只在这一版的池确实解析出来时才置:v1 老文件没有池,保持 null(与升级前
    // 逐字节相同的行为),下一次 `setActivePool` 会把它补上并升级成 v2。
    if (pool) activePool = pool
  } catch {
    // 文件不存在 / 换了机器解不开 / 格式变了。都不是错误,重取即可。
  }
}

const EMPTY_ENVELOPE = { tokens: {} as Record<string, string>, pool: null }

/**
 * 解析落盘信封。认不出的形状、或**来自别的环境**的,一律当空 —— 不猜、不部分采用。
 *
 * v1(裸 map)与 v2(带池)都没有环境标记,**无法证明它们属于当前 IdP**,所以一并丢弃。
 * 代价只是升级后第一次用平台余额时多一趟网络往返;而留着它们,换来的是「换过环境的
 * 机器一启动就 401,且错误里看不出成因」——那正是 v3 要消灭的东西。
 */
function readEnvelope(parsed: unknown): { tokens: Record<string, string>; pool: Pool | null } {
  if (!parsed || typeof parsed !== 'object') return EMPTY_ENVELOPE
  const obj = parsed as Record<string, unknown>
  if (obj.v !== 3) return EMPTY_ENVELOPE
  // 环境不符 = 这批凭据是别处签的,一个都不能要。
  if (obj.authBaseUrl !== authBaseUrl()) return EMPTY_ENVELOPE
  const tokens =
    obj.tokens && typeof obj.tokens === 'object'
      ? (obj.tokens as Record<string, string>)
      : {}
  return { tokens, pool: readPool(obj.pool) }
}

/**
 * 池的形状窄化。
 *
 * `projectId` 必须是正整数 —— 盘上的值可能来自更老的版本、被手改过、或解密出
 * 半截。放一个 NaN 进去的后果不是崩,是 `poolKey()` 生成 `NaN:` 这样一个永远
 * 命不中缓存的键:平台余额看着是开的,每次却都取不到 token 而静默退回自填 Key。
 */
function readPool(raw: unknown): Pool | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const projectId = Number(o.projectId)
  if (!Number.isInteger(projectId) || projectId <= 0) return null
  const ppid = Number(o.producerProjectId)
  return {
    projectId,
    producerProjectId: Number.isInteger(ppid) && ppid > 0 ? ppid : null,
  }
}

export async function clearGatewayTokens(): Promise<void> {
  cache.clear()
  inflight.clear()
  activePool = null
  // 必须在 rm 之前:在途请求要靠它判断自己该不该继续写状态。
  generation += 1
  await fs.rm(storePath(), { force: true }).catch(() => {})
}

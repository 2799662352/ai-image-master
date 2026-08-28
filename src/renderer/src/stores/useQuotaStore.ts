// 账号额度的渲染层状态:可用计费池、当前选中的池、该池余额。
//
// 与 `useAuthStore` 分开:那个管身份会话,这个管计费上下文 —— 两者生命周期不同
// (登录一次,选池可能反复切),混在一起会让「切池」不必要地触发身份相关的订阅。
//
// **主进程刻意回 `{ ok, data } | { ok: false, error }` 信封而不是裸抛**(裸抛经 IPC 会
// 丢掉后端 error code)。所以这一层的主要职责就是把信封摊开:成功取 data,失败把
// message 落到 `error`。不摊开的话 UI 会把整个信封对象当成数据渲染,表现是余额显示
// 空白而不是报错。

import { create } from 'zustand'
import { useAuthStore } from './useAuthStore'
import type {
  AccountBalance,
  AccountOrganization,
  BillingPoolRef,
  PaymentConfig,
  QuotaRpc,
} from '../../../types/authApi'

/**
 * 计费池的键。
 *
 * **两半都是键的一部分。** 两个 producer project 可以共用一个 `projectId` ——
 * 只比对 `projectId` 会把它们当成同一个池,于是「已选中」的高亮打在错的那一行,
 * 而钱记到另一个池上。参考 shortdrama 的 `sameBillingPool`。
 */
export interface Pool {
  projectId: number
  producerProjectId: number | null
}

const STORAGE_KEY = 'catimation_billing_pool'

/**
 * 出图时这一次的钱从哪出。
 *
 * `'platform'` = 平台账号余额,凭据只在主进程,渲染层出网时只打一个标记头;
 * `'own-key'` = 用户在「API 站点」里自填的 Key,沿用一直以来的老路。
 */
export type BillingSource = 'platform' | 'own-key'

type QuotaApi = {
  getOrganizations: () => Promise<QuotaRpc<AccountOrganization[]>>
  getBalance: (projectId: number, producerProjectId?: number) => Promise<QuotaRpc<AccountBalance>>
  getQuota: () => Promise<QuotaRpc<Record<string, unknown>>>
  getPaymentConfig: () => Promise<QuotaRpc<PaymentConfig>>
  /**
   * 两个计费池方法标成可选,是因为**桥可能在但方法不存在** —— 老版本 preload、
   * 或测试里只 mock 了一半的假桥。直接调用不存在的方法是一个同步 TypeError,
   * 会变成 unhandled rejection 把整轮测试判红(见下面 `unexpected` 的注释)。
   *
   * 回的信封里只有 `ready`,**没有也不会有 token** —— 那条通道刻意不存在。
   */
  setBillingPool?: (pool: BillingPoolRef) => Promise<QuotaRpc<{ ready: boolean }>>
  clearBillingPool?: () => Promise<QuotaRpc<null>>
}

interface QuotaStoreState {
  organizations: AccountOrganization[]
  selectedPool: Pool | null
  balanceYuan: number | null
  personalBillingProjectId: number | null
  /**
   * ⚠️ **刻意不持久化,每次启动都回到 `'own-key'`。**
   *
   * 平台凭据活在主进程内存里,重启后要重新按池取。若这里记住了 `'platform'`,
   * 下次启动渲染层会一上来就打标记头,而主进程还没 arm —— 注入器删掉 Authorization
   * 又写不回 token,于是**每一个请求 401**,用户还以为是网关坏了。
   */
  billingSource: BillingSource
  loading: boolean
  error: string | null
}

interface QuotaStoreActions {
  load: () => Promise<void>
  selectPool: (pool: Pool) => Promise<void>
  refreshBalance: () => Promise<void>
  isSelected: (pool: Pool) => boolean
  setBillingSource: (s: BillingSource) => Promise<void>
}

type QuotaStore = QuotaStoreState & QuotaStoreActions

function getApi(): QuotaApi | undefined {
  return (window as Window & { electronAPI?: { auth?: QuotaApi } }).electronAPI?.auth
}

/** 池相等必须比对两半。只比 projectId 会把共用 id 的两个 producer 池混为一个。 */
export function samePool(a: Pool | null, b: Pool | null): boolean {
  if (!a || !b) return a === b
  return a.projectId === b.projectId && (a.producerProjectId ?? null) === (b.producerProjectId ?? null)
}

function readStoredPool(): Pool | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as { projectId?: unknown; producerProjectId?: unknown }
    const id = Number(p.projectId)
    if (!Number.isFinite(id) || id <= 0) return null
    const ppid = Number(p.producerProjectId)
    return { projectId: id, producerProjectId: Number.isFinite(ppid) && ppid > 0 ? ppid : null }
  } catch {
    // localStorage 在隐私模式/被禁用时会抛。没有选池不是错误,只是回到未选状态。
    return null
  }
}

function writeStoredPool(pool: Pool | null): void {
  try {
    if (pool) localStorage.setItem(STORAGE_KEY, JSON.stringify(pool))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 存不下就算了 —— 下次启动回到未选状态,比让整个选池动作失败好。
  }
}

/**
 * 「用户**自己**把平台余额关掉过」。
 *
 * `load()` 由设置页的 AccountSection 在挂载时触发,而它会在 `own-key` + 已选池时
 * 自动抬手。没有这个标记的话:用户明确关掉、离开设置页再回来,它自己开回去,
 * 继续花组织的钱 —— 用户没做任何动作,也不会收到任何提示。
 *
 * 🚨 **只记用户的显式动作。** arm 失败时的内部回落走的是裸 `set({ billingSource })`,
 * 不经过 `setBillingSource`,所以不会写这个标记 —— 那是刻意的:一次网络抖动
 * 不该等于「用户不想用平台余额」,否则自动抬手就被一次 502 永久关掉了。
 *
 * 落 localStorage 而不是内存:它要跨重启有效,否则重开一次应用又回到老样子。
 */
const AUTO_ARM_OPT_OUT_KEY = 'catimation_billing_auto_arm_opt_out'

function readAutoArmOptOut(): boolean {
  try {
    return localStorage.getItem(AUTO_ARM_OPT_OUT_KEY) === '1'
  } catch {
    // 隐私模式/被禁用时读不到。当作「没关过」—— 与这个功能上线之前的行为一致。
    return false
  }
}

function writeAutoArmOptOut(optedOut: boolean): void {
  try {
    if (optedOut) localStorage.setItem(AUTO_ARM_OPT_OUT_KEY, '1')
    else localStorage.removeItem(AUTO_ARM_OPT_OUT_KEY)
  } catch {
    // 写不进去只影响「下次还会不会自动抬手」,不该让切换动作本身失败。
  }
}

const initialState: QuotaStoreState = {
  organizations: [],
  selectedPool: null,
  balanceYuan: null,
  personalBillingProjectId: null,
  billingSource: 'own-key',
  loading: false,
  error: null,
}

/**
 * 启用平台余额失败时给用户的下一步动作。
 *
 * **按 code 分支而不是照抄 message,是这一层存在的理由。** 主进程已经把后端错误翻译
 * 成了有意义的 code,而这几类要引导的动作完全不同:换组织 / 重新登录 / 稍后重试 ——
 * 只把 message 摊出来,用户看到「无权访问该项目」也不知道该去哪儿点。
 *
 * 未命中的 code 一律当「可重试」处理并附上原始 message:漏掉一个新 code 时,
 * 「稍后重试」比「什么都不说」强,而 message 保证用户还能把原文报给客服。
 */
const BILLING_POOL_HINT: Record<string, string> = {
  NOT_LOGGED_IN: '登录已失效,请重新登录后再启用平台余额。',
  PROJECT_NOT_ALLOCATED: '你不是这个计费池的成员,请在上面换一个组织后重试。',
  INVALID_POOL: '这个计费池不可用,请换一个计费池。',
  UPSTREAM_UNREACHABLE: '暂时连不上账号服务,请稍后重试。',
  NETWORK: '网络异常,请稍后重试。',
  MALFORMED_RESPONSE: '账号服务返回了无法识别的内容,请稍后重试。',
}

/**
 * 失败文案。
 *
 * 前缀里**必须**写明「已切回自有 Key」:静默留在 platform 态是这条链路最坏的失败 ——
 * 用户以为在花平台余额,实际每个请求都 401(甚至更糟:在花自己的钱)。
 */
function billingPoolFailure(code: string, message: string): string {
  const hint = BILLING_POOL_HINT[code] ?? (/^HTTP_5\d\d$/.test(code) ? '账号服务暂时不可用,请稍后重试。' : message)
  return `平台余额未启用(已切回自有 Key):${hint}`
}

/** 把信封摊开。失败返回 undefined 并把文案交给调用方落到 error。 */
function unwrap<T>(r: QuotaRpc<T>): { data?: T; error?: string } {
  return r.ok ? { data: r.data } : { error: r.error.message }
}

/**
 * 🚨 **异常绝不许逃出这些 action。**
 *
 * 调用点全是组件里的 `void loadQuota()` / `void selectPool(...)` —— 没有 catch。逃出去的
 * 异常会成为一个 unhandled rejection:vitest 因此**判整轮失败**(哪怕每条断言都过),
 * 而在生产里用户什么提示都看不到,只剩控制台一行红字。
 *
 * 别以为「主进程回信封所以不会抛」:`getApi()` 只挡住「整个桥没挂上」,挡不住「桥在但
 * 某个方法不存在」—— 那时调用它是一个**同步** TypeError。实测撞过:一个既有测试的假桥
 * 只 mock 了登录相关方法,4 条 unhandled rejection 把 474 个通过的测试判成红的。
 *
 * `message` 直接透出而不做映射:这一层的异常都是「桥/网络层面出了意外」,没有需要
 * 分支处理的业务 code —— 有 code 的那些走信封,由 `unwrap` 处理。
 */
function unexpected(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return `额度查询失败:${msg}`
}

/**
 * 换池重新 arm 的**串行闸**。
 *
 * 池选择器是个原生 `<select>`,键盘方向键每翻一格就触发一次 `change` —— 在 5 个池里
 * 翻一遍就是 5 趟 setBillingPool。主进程是**异步取到凭据之后**才写下它们的,所以并发
 * 发出去时最后落地的是最后**返回**的那趟,而 UI 高亮的一定是最后**选中**的那个。
 * 两者不同池时,症状恰好就是重新 arm 这件事本身要消灭的 bug:界面在新池、钱从旧池扣。
 *
 * **排队,而不是在 arm 期间禁用控件。** `AccountSection` 里那两个计费来源按钮用的是
 * `switching` 局部 state(见那边的注释,理由同源:连点两下会打出两次 arm)—— 按钮那么
 * 做没问题,但把 `<select>` 禁掉会打断键盘导航,而键盘导航正是最容易触发这条竞态的
 * 操作方式。何况正确性不该依赖某一个控件记得加锁:守在 store 这层,所有调用点都算数。
 *
 * 不需要另配「只保留最后一次」的序号:队列里每一趟都在**执行时**现读 `selectedPool`,
 * 中途被翻过去的池不会留下过期的引用 —— 排在最后的那趟发的一定是用户最后停下的池。
 * 重复 arm 同一个池只是多一趟往返,不会记错账。
 */
let armChain: Promise<void> = Promise.resolve()

/**
 * 登出复位订阅。**装它的地方是 `setBillingSource`,这不是随手放的。**
 *
 * 没有它的后果不是「少复位一下」:主进程登出时清了缓存与 activePool,渲染层若仍返回
 * `'platform'`,每个 Miau 请求都会带着标记头出去 —— 注入器**先无条件删掉
 * Authorization**,而它手上已经没有 token 可写,于是**每一次出图都 401**。
 * 而 `AccountSection` 里那两个计费来源按钮**只在已登录分支渲染**,所以会话内没有
 * 任何路径能切回自有 Key:用户只能重启应用。
 *
 * 为什么装在 `setBillingSource` 里而不是某个组件的 mount effect:那样就多了一个
 * 「记得调」的调用点,而漏掉它没有任何信号。装在这里则由构造保证 ——
 * **能进入 platform 态的唯一入口就是这里**,所以订阅一定不晚于第一次可能需要它的时刻。
 * (与 `session.logout()` 那条「不变量收进唯一入口」同源。)
 *
 * 方向是 quota → auth:计费上下文依赖身份,反过来不成立。让 `useAuthStore` 去 import
 * 这个 store 会把身份层拽进计费的关注点里。
 */
let unsubscribeAuth: (() => void) | null = null

function ensureLogoutResetsBillingSource(): void {
  if (unsubscribeAuth) return
  unsubscribeAuth = useAuthStore.subscribe((s) => {
    // 按**当前值**判断而不是「已认证 → 未认证」的跳变:跳变判断会漏掉
    // 「hydrate 先落一个 false、随后才有人切 platform」这类顺序,而按值判断天然幂等。
    if (s.authenticated) return
    // 已经是 own-key 就别写:zustand 每次 setState 都会通知订阅者,
    // 无谓地换一个新 state 对象会让所有读这个 store 的组件白重渲染一轮。
    if (useQuotaStore.getState().billingSource === 'own-key') return
    // 刻意**不**顺带发一趟 `clearBillingPool()`:主进程在登出里已经清过
    // (`clearGatewayTokens()` 会把 activePool 一并摘掉),这里再发一趟既多余,
    // 又给这条路径引入一个可能 reject 的 await。
    useQuotaStore.setState({ billingSource: 'own-key' })
  })
}

export const useQuotaStore = create<QuotaStore>((set, get) => ({
  ...initialState,

  load: async () => {
    const api = getApi()
    if (!api) return

    set({ loading: true, error: null })
    try {
      // 两个查询彼此独立,并行发 —— 任一失败不该让另一个的结果丢掉。
      const [orgsRes, cfgRes] = await Promise.all([api.getOrganizations(), api.getPaymentConfig()])

      const orgs = unwrap(orgsRes)
      const cfg = unwrap(cfgRes)

      set({
        loading: false,
        organizations: orgs.data ?? [],
        personalBillingProjectId: cfg.data?.personalBillingProjectId ?? null,
        error: orgs.error ?? cfg.error ?? null,
      })
    } catch (e) {
      // loading 必须落回来,否则 UI 永远转圈。
      set({ loading: false, error: unexpected(e) })
      return
    }

    // 恢复上次选的池。**只恢复选择本身,余额单独拉** —— 上次的余额早就过期了。
    const stored = readStoredPool()
    if (stored && !get().selectedPool) {
      set({ selectedPool: stored })
      await get().refreshBalance()
    }

    // 登录后默认走平台余额。
    //
    // 不这么做的话,用户登录了、余额也显示出来了,出图却仍被要求「请先设置 API Key」——
    // 「登录」这个动作对用户的含义就是「我要用账号里的钱」,还让他去填第三方 Key 说不通。
    //
    // 三条约束:
    //  - 只在 `own-key` **且用户没自己关过**时抬手(`readAutoArmOptOut`)。
    //    这个标记只由 `setBillingSource('own-key')` 写 —— 内部回落走裸 `set()`,
    //    不该被记成用户意图,否则一次网络抖动就永久关掉了自动抬手。
    //  - 必须有已选池,否则 arm 一定失败,徒增一次注定报错的 IPC。
    //  - `setBillingSource` 自己会在失败时回落 `own-key` 并把人话原因摊到 `error` 上,
    //    所以这里不需要 try —— 失败的结果就是维持现状,与不做这一步等价。
    if (get().billingSource === 'own-key' && get().selectedPool && !readAutoArmOptOut()) {
      await get().setBillingSource('platform')
    }
  },

  selectPool: async (pool) => {
    const { organizations, personalBillingProjectId } = get()

    // 个人计费落点**刻意不出现在组织列表里**(后端设计前提,见 payment.ts:118-121),
    // 所以「不在列表里」不能作为拒绝理由 —— 得先把它排除掉。
    const isPersonal =
      personalBillingProjectId !== null &&
      pool.projectId === personalBillingProjectId &&
      pool.producerProjectId === null

    if (!isPersonal) {
      const hit = organizations.find((o) =>
        samePool({ projectId: o.id, producerProjectId: o.producerProjectId ?? null }, pool),
      )
      // 没有 allocation 行就没有影子账户可扣,选中它只会在出图时拿到一个看不懂的错误。
      if (!hit || !hit.joined) {
        set({ error: '这个计费池你还没加入,先在网页端加入后再选择' })
        return
      }
    }

    // 🚨 **先让主进程的旧池失效,再宣称换到新池。顺序就是这条修复的全部内容。**
    //
    // 下面那行 `set({ selectedPool })` 一执行,UI 就说「你现在用新池」。而主进程要到
    // 再下面重新 arm 落地之后才真的换过去 —— 中间隔着一次余额刷新往返 + 整个
    // `armChain` 队列。这段窗口里主进程的 activePool 仍是**旧池**、旧 token 仍在缓存
    // 里,`getActivePoolToken()` 交给注入器的是旧池的凭据,网关扣的是旧池的钱。
    //
    // `armChain` 在它本该保护的那个场景里反而**拉长了**这个窗口:用方向键连翻五个池
    // 会串行五次往返,全程活跃的还是第一个池。
    //
    // 先清一次,窗口就从「扣错池」变成 fail-closed:主进程没有 activePool → 注入器
    // 删掉 Authorization 又写不回 → 401。响亮、可见、一分钱不花。而「扣错池」是静默的、
    // 跨组织的、事后从桌面端根本查不出来 —— 正是平台余额这个功能本身要防的失效类别。
    let disarmFailure: string | null = null
    if (get().billingSource === 'platform') {
      try {
        await getApi()?.clearBillingPool?.()
      } catch {
        // 清不掉就不能硬着头皮换过去 —— 那等于把上面描述的窗口原样留着。退回 own-key
        // 是**本地就成立的事实**(不打标记 → 注入器根本不会被触发),并且必须留下文案:
        // 静默退回等于用户以为在花平台余额、实际在花自己的钱。
        // 异常在这里咽掉,逃出去只会变成一条 unhandled rejection(见文件顶部 🚨)。
        //
        // 文案攒在局部变量里、等换池流程走完再落:当场 `set` 会被下面那行
        // `set({ error: null })` 和 `refreshBalance()` 成功时的 `set({ error: null })`
        // **连着覆盖两次**,那正是「回落对了、提示废了」——用户点一下什么也没发生。
        disarmFailure = '换计费池失败(已切回自有 Key):请重新启用平台余额。'
        set({ billingSource: 'own-key' })
      }
    }

    set({ selectedPool: pool, error: null })
    writeStoredPool(pool)
    await get().refreshBalance()

    // 见上:这条必须落在 `refreshBalance()` **之后**,它成功时会把 error 清成 null。
    // 也刻意盖过余额查询自己的报错 —— 「钱可能记到别处」比「余额没刷出来」要紧。
    if (disarmFailure) {
      set({ error: disarmFailure })
      return
    }

    // 已经在平台模式下换池时**必须重新 arm 主进程**。不换的话主进程还揣着上一个池的
    // 凭据,渲染层却已经把 UI 高亮打在新池上 —— 钱继续从旧池扣,而这正是「两个
    // producer 池共用一个 projectId」那条教训的动态版本:池键换了一半也算换了池。
    //
    // 上一趟 arm 落地了才发下一趟,理由见 `armChain`。`catch` 只是保险:
    // `setBillingSource` 自己吞掉所有异常,但链子一旦 reject 就再也不会往下走,
    // 那之后的每一次换池都会静默地不再 arm。
    if (get().billingSource === 'platform') {
      const run = armChain.then(() => get().setBillingSource('platform'))
      armChain = run.catch(() => {})
      await run
    }
  },

  refreshBalance: async () => {
    const api = getApi()
    const pool = get().selectedPool
    if (!api || !pool) return

    // 意外异常与信封错误在这里**同样处置**:都只写 error、保留旧余额。
    // 显示 0 会让用户以为余额空了 —— 比「旧值 + 报错」糟得多。
    let r: { data?: AccountBalance; error?: string }
    try {
      r = unwrap(await api.getBalance(pool.projectId, pool.producerProjectId ?? undefined))
    } catch (e) {
      set({ error: unexpected(e) })
      return
    }
    if (r.error !== undefined) {
      set({ error: r.error })
      return
    }
    set({ balanceYuan: r.data?.balanceYuan ?? null, error: null })
  },

  isSelected: (pool) => samePool(get().selectedPool, pool),

  /**
   * 切换出图的钱从哪出。
   *
   * 🚨 **切 platform 失败时一律回落 `'own-key'`,绝不静默留在 platform 态。**
   * 留下的后果不是「少个提示」:渲染层会继续打标记头,主进程收到标记后**先无条件删掉
   * Authorization**(注入器刻意如此,免得静默用用户自己的钱出图),而它手上又没有凭据
   * 可写 —— 于是每一个请求 401,用户只看到一串莫名其妙的网关错误。
   *
   * 切回 own-key 是**本地就成立的事实**(不打标记 = 注入器根本不会被触发),所以
   * 先落状态再尽力通知主进程清凭据;清不掉也不影响计费正确性,只是主进程多留一份
   * 内存缓存到下次登出。
   */
  setBillingSource: async (next) => {
    const api = getApi()
    // 见 `ensureLogoutResetsBillingSource`:装在这里,是为了让「能进 platform 态」与
    // 「登出会把它复位」由构造绑在一起,而不是靠某个组件记得调一次。幂等。
    ensureLogoutResetsBillingSource()

    if (next === 'own-key') {
      // 走到这里一定是用户自己点的:内部回落用的是裸 `set()`,不经过本函数。
      // 记下来,免得 `load()` 下次挂载时又把它抬回去。
      writeAutoArmOptOut(true)
      set({ billingSource: 'own-key', error: null })
      try {
        await api?.clearBillingPool?.()
      } catch {
        // 见上:清不掉不影响「已经切回自有 Key」这个事实。异常在这里咽掉,
        // 逃出去只会变成一条 unhandled rejection。
      }
      return
    }

    const pool = get().selectedPool
    if (!pool) {
      set({ billingSource: 'own-key', error: '先在上面选一个计费池,再启用平台余额。' })
      return
    }
    if (!api?.setBillingPool) {
      set({ billingSource: 'own-key', error: '当前环境不支持平台余额(缺少主进程通道)。' })
      return
    }

    let r: QuotaRpc<{ ready: boolean }>
    try {
      // 两半都递过去,`producerProjectId` **显式补 `?? null`**:池键的这一半在组织列表
      // 那边是 `number | undefined`,而主进程收的是 `number | null` —— 直接透传
      // undefined 会在那头被 Number() 变成 NaN,arm 的就不是这个池了。
      r = await api.setBillingPool({
        projectId: pool.projectId,
        producerProjectId: pool.producerProjectId ?? null,
      })
    } catch (e) {
      set({ billingSource: 'own-key', error: unexpected(e) })
      return
    }

    if (!r.ok) {
      set({ billingSource: 'own-key', error: billingPoolFailure(r.error.code, r.error.message) })
      return
    }
    // `ready: false` 是「调用成功但凭据没到手」——主进程是先取凭据、成功了才置 active,
    // 所以这一支同样不能进 platform 态。只看 ok 会漏掉它。
    if (!r.data?.ready) {
      set({
        billingSource: 'own-key',
        error: '平台余额未启用(已切回自有 Key):凭据未就绪,请稍后重试。',
      })
      return
    }

    // 用户自己开回来了,把「关过」这件事忘掉 —— 否则他每次重启都得手动再点一次。
    writeAutoArmOptOut(false)
    set({ billingSource: 'platform', error: null })
  },
}))

/**
 * Test-only：清掉模块级单例状态。与 `useAuthStore.__resetSubscriptionsForTesting` 对称。
 *
 * `armChain` 必须在这里断开:某条用例留下一趟永远不 resolve 的 arm(闸没放开、
 * 或 mock 挂在半路)时,链子会一直悬着,后面每一个用例的换池都排在它后面永不执行 ——
 * 表现成一片与本次改动无关的超时,查起来很费劲。
 *
 * 登出订阅同理:不断开的话,上一条用例装的那份会跟着 `useAuthStore` 的每一次
 * `setState` 一起触发,把下一条用例刚切好的 platform 态踢回 own-key。
 */
export function __resetQuotaStoreForTesting(): void {
  armChain = Promise.resolve()
  unsubscribeAuth?.()
  unsubscribeAuth = null
}

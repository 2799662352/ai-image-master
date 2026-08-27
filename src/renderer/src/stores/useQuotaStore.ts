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
import type {
  AccountBalance,
  AccountOrganization,
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

type QuotaApi = {
  getOrganizations: () => Promise<QuotaRpc<AccountOrganization[]>>
  getBalance: (projectId: number, producerProjectId?: number) => Promise<QuotaRpc<AccountBalance>>
  getQuota: () => Promise<QuotaRpc<Record<string, unknown>>>
  getPaymentConfig: () => Promise<QuotaRpc<PaymentConfig>>
}

interface QuotaStoreState {
  organizations: AccountOrganization[]
  selectedPool: Pool | null
  balanceYuan: number | null
  personalBillingProjectId: number | null
  loading: boolean
  error: string | null
}

interface QuotaStoreActions {
  load: () => Promise<void>
  selectPool: (pool: Pool) => Promise<void>
  refreshBalance: () => Promise<void>
  isSelected: (pool: Pool) => boolean
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

const initialState: QuotaStoreState = {
  organizations: [],
  selectedPool: null,
  balanceYuan: null,
  personalBillingProjectId: null,
  loading: false,
  error: null,
}

/** 把信封摊开。失败返回 undefined 并把文案交给调用方落到 error。 */
function unwrap<T>(r: QuotaRpc<T>): { data?: T; error?: string } {
  return r.ok ? { data: r.data } : { error: r.error.message }
}

export const useQuotaStore = create<QuotaStore>((set, get) => ({
  ...initialState,

  load: async () => {
    const api = getApi()
    if (!api) return

    set({ loading: true, error: null })
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

    // 恢复上次选的池。**只恢复选择本身,余额单独拉** —— 上次的余额早就过期了。
    const stored = readStoredPool()
    if (stored && !get().selectedPool) {
      set({ selectedPool: stored })
      await get().refreshBalance()
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

    set({ selectedPool: pool, error: null })
    writeStoredPool(pool)
    await get().refreshBalance()
  },

  refreshBalance: async () => {
    const api = getApi()
    const pool = get().selectedPool
    if (!api || !pool) return

    const res = await api.getBalance(pool.projectId, pool.producerProjectId ?? undefined)
    const r = unwrap(res)
    if (r.error !== undefined) {
      // **失败时保留旧余额。** 显示 0 会让用户以为余额空了 —— 比「旧值 + 报错」糟得多。
      set({ error: r.error })
      return
    }
    set({ balanceYuan: r.data?.balanceYuan ?? null, error: null })
  },

  isSelected: (pool) => samePool(get().selectedPool, pool),
}))

/**
 * Test-only：这个 store 目前没有模块级单例状态，但保留这个钩子与
 * `useAuthStore.__resetSubscriptionsForTesting` 对称 —— 将来加了余额轮询定时器
 * (那是模块级的)时，清理逻辑有个既定的落点，不用再改一遍所有测试。
 */
export function __resetQuotaStoreForTesting(): void {
  // 目前无模块级状态需要清理。
}

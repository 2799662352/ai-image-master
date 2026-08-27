// 设置页 · 账号分区。身份先于 API 站点,所以排在设置页第一节。
//
// 独立成文件而不是写在 SettingsPage(621 行)里,一是那文件已经够长,二是分区
// 只依赖 auth 桥、能单测 —— 整页搬进 jsdom 得先喂饱四套无关 IPC。
//
// 配色跟随所在页面,用设置页那套主题 token(bg-cyberpunk-yellow / border-zinc-700
// ……),不要混进全屏登录页的字面 hex。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuthStore } from '../../stores/useAuthStore'
import { useQuotaStore, type Pool } from '../../stores/useQuotaStore'
import { RechargeModal } from './RechargeModal'
import { UsageDrawer } from './UsageDrawer'

/** 池键序列化成 `<projectId>:<producerProjectId|->`，两半都在，才能唯一。 */
function poolValue(pool: Pool): string {
  return `${pool.projectId}:${pool.producerProjectId ?? '-'}`
}

function parsePoolValue(v: string): Pool | null {
  const [a, b] = v.split(':')
  const projectId = Number(a)
  if (!Number.isFinite(projectId) || projectId <= 0) return null
  const ppid = Number(b)
  return { projectId, producerProjectId: Number.isFinite(ppid) && ppid > 0 ? ppid : null }
}

/**
 * 余额文案。
 *
 * **`null` 与 `0` 必须区分。** 余额未知（还没选池 / 查询失败）显示 `¥0.00` 会让用户
 * 以为钱花光了、跑去充值，而真实原因完全不同。所以未知给占位符。
 */
function balanceText(yuan: number | null): string {
  if (yuan === null) return '余额未知'
  return `¥${yuan.toFixed(2)}`
}

export function AccountSection() {
  const authenticated = useAuthStore((s) => s.authenticated)
  const username = useAuthStore((s) => s.username)
  const displayName = useAuthStore((s) => s.displayName)
  const role = useAuthStore((s) => s.role)
  const pending = useAuthStore((s) => s.pending)
  const error = useAuthStore((s) => s.error)
  const sessionOnly = useAuthStore((s) => s.sessionOnly)

  const hydrate = useAuthStore((s) => s.hydrate)
  const ensureSubscriptions = useAuthStore((s) => s.ensureSubscriptions)
  const startLogin = useAuthStore((s) => s.startLogin)
  const logout = useAuthStore((s) => s.logout)

  const organizations = useQuotaStore((s) => s.organizations)
  const selectedPool = useQuotaStore((s) => s.selectedPool)
  const balanceYuan = useQuotaStore((s) => s.balanceYuan)
  const personalBillingProjectId = useQuotaStore((s) => s.personalBillingProjectId)
  const quotaError = useQuotaStore((s) => s.error)
  const loadQuota = useQuotaStore((s) => s.load)
  const selectPool = useQuotaStore((s) => s.selectPool)

  // 接推送 + 拉当前状态,缺一不可:漏前者则登录完成后这一块不动,
  // 漏后者则重启后已登录也显示未登录。ensureSubscriptions 幂等。
  useEffect(() => {
    ensureSubscriptions()
    void hydrate()
  }, [ensureSubscriptions, hydrate])

  // 额度那几个端点都挂 authMiddleware,未登录发过去只会拿 401 —— 白发请求还会在
  // 控制台留下误导性的报错。所以**必须**等 authenticated 才拉。
  useEffect(() => {
    if (!authenticated) return
    void loadQuota()
  }, [authenticated, loadQuota])

  /**
   * 下拉里的可选项。
   *
   * 个人计费落点**刻意不在** `/api/user/organizations` 的返回里(后端设计前提),
   * 所以要单独补一条 —— 只渲染组织列表的话,用户最常用的那个池反而选不到。
   */
  const poolOptions = useMemo(() => {
    const items = organizations
      .filter((o) => o.joined)
      .map((o) => ({
        pool: { projectId: o.id, producerProjectId: o.producerProjectId ?? null } as Pool,
        label: o.studioName ? `${o.studioName} / ${o.name}` : o.name,
      }))
    if (
      personalBillingProjectId !== null &&
      !items.some((i) => i.pool.projectId === personalBillingProjectId && i.pool.producerProjectId === null)
    ) {
      items.unshift({
        pool: { projectId: personalBillingProjectId, producerProjectId: null },
        label: '个人计费',
      })
    }
    return items
  }, [organizations, personalBillingProjectId])

  const onPoolChange = useCallback(
    (v: string) => {
      const pool = parsePoolValue(v)
      if (pool) void selectPool(pool)
    },
    [selectPool],
  )

  const [usageOpen, setUsageOpen] = useState(false)
  const [rechargeOpen, setRechargeOpen] = useState(false)

  /**
   * 没选池就发不出去。
   *
   * 用量端点的 `projectId` 是必填才有意义的(不传等于「不过滤」,查出来是别人的口径),
   * 建单更是必须有项目上下文、三选一。禁用比「点了拿一个 400」好:后者要等一个 RTT
   * 才告诉用户「你还没选池」,而这件事本地就知道。
   */
  const poolReady = selectedPool !== null

  const openUsage = useCallback(() => {
    setUsageOpen(true)
  }, [])
  const closeUsage = useCallback(() => {
    setUsageOpen(false)
  }, [])
  const openRecharge = useCallback(() => {
    setRechargeOpen(true)
  }, [])
  const closeRecharge = useCallback(() => {
    setRechargeOpen(false)
  }, [])

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="w-6 h-6 bg-cyberpunk-yellow text-cyberpunk-black flex items-center justify-center text-sm font-bold">
          1
        </span>
        <span className="font-bold text-white uppercase tracking-tight">账号</span>
      </div>

      {authenticated ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4 bg-zinc-800 border-2 border-zinc-700 px-4 py-3">
            <div className="min-w-0">
              <div className="text-sm text-white font-medium truncate">
                {displayName ?? username ?? '已登录'}
              </div>
              <div className="text-xs text-zinc-400 mt-0.5">
                {role ? `角色 ${role}` : '已登录'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void logout()}
              className="shrink-0 px-4 py-2 bg-zinc-800 border-2 border-zinc-700 hover:bg-zinc-700 text-white text-sm font-bold uppercase tracking-tight transition-colors"
            >
              退出登录
            </button>
          </div>

          <div className="bg-zinc-800 border-2 border-zinc-700 px-4 py-3 space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-xs text-zinc-400">计费池余额</div>
                {/* 余额数字本身可点(对齐网页端 `title="查看使用明细"` 那个交互)。
                    但**光有它不够** —— 一串数字看不出能点,所以下面还有一个显式的
                    文字入口。两个都要。 */}
                <button
                  type="button"
                  data-testid="account-balance"
                  title="查看使用明细"
                  onClick={openUsage}
                  disabled={!poolReady}
                  className="mt-0.5 block text-left text-sm text-white font-medium tabular-nums underline decoration-zinc-600 decoration-dotted underline-offset-4 hover:decoration-cyberpunk-yellow disabled:cursor-default disabled:no-underline disabled:opacity-60 transition-colors"
                >
                  {balanceText(balanceYuan)}
                </button>
              </div>
              {/* 充值曾经是 `openExternal('…/home')` —— 那是个真 bug:首页到不了充值
                  表单(表单是 `/space` 画布页上的弹窗,`/plan` 只是充值*记录*页)。而
                  payUrl 是支付宝每次现签、含订单号、10 分钟过期的一次性地址,拼不出来,
                  所以只能走原生的「建单 → 开系统浏览器 → 轮询到 CREDITED」。 */}
              <button
                type="button"
                onClick={openRecharge}
                disabled={!poolReady}
                className="shrink-0 px-6 py-2 bg-cyberpunk-yellow hover:opacity-90 text-cyberpunk-black text-sm font-bold uppercase tracking-tight transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                充值
              </button>
            </div>

            <div className="space-y-1">
              <label
                htmlFor="account-pool-select"
                className="block text-xs text-zinc-400"
              >
                计费池
              </label>
              <select
                id="account-pool-select"
                data-testid="account-pool-select"
                value={selectedPool ? poolValue(selectedPool) : ''}
                onChange={(e) => onPoolChange(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-900 border-2 border-zinc-700 text-white focus:outline-none focus:border-cyberpunk-yellow text-sm"
              >
                <option value="">未选择</option>
                {poolOptions.map((o) => (
                  <option key={poolValue(o.pool)} value={poolValue(o.pool)}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center justify-between gap-3 pt-1">
              {/* 显式入口。可点的余额数字是「顺手」,这个才是「找得到」。 */}
              <button
                type="button"
                data-testid="account-usage-entry"
                onClick={openUsage}
                disabled={!poolReady}
                className="px-3 py-1.5 bg-zinc-900 border-2 border-zinc-700 hover:border-zinc-500 text-white text-xs font-bold uppercase tracking-tight transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-zinc-700"
              >
                使用明细
              </button>
              {!poolReady && (
                <span className="text-xs text-zinc-500">先选一个计费池</span>
              )}
            </div>

            {/* 出图仍走「API 站点」里那把自填 Key —— 账号额度的出图链路还没接上
                (第二期)。不说清楚的话,用户会以为选了池就等于出图开始扣账号余额。 */}
            <p className="text-xs text-zinc-500 leading-relaxed">
              这里的余额用于云端出图与素材同步。当前出图仍使用下方「API 站点」里配置的
              密钥,尚未切换到账号额度。
            </p>
          </div>

          {quotaError && (
            <p className="text-xs text-red-300 border-l-2 border-red-700 pl-3 py-1">{quotaError}</p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-zinc-500">
            登录后可使用云端出图与素材同步。将在系统浏览器中完成授权,凭证只保存在本机。
          </p>
          <button
            type="button"
            onClick={() => void startLogin()}
            disabled={pending}
            className="px-6 py-2 bg-cyberpunk-yellow hover:opacity-90 text-cyberpunk-black text-sm font-bold uppercase tracking-tight transition-all disabled:opacity-50"
          >
            {pending ? '等待浏览器授权…' : '登录'}
          </button>
        </div>
      )}

      {/* safeStorage 不可用(典型是 Linux 没有系统密码管理器)时的降级。
          不提示的话用户会以为登录压根没生效。 */}
      {sessionOnly && (
        <p className="text-xs text-yellow-300/80 border-l-2 border-cyberpunk-yellow pl-3 py-1">
          凭证仅本次会话有效,重启后需重新登录。
        </p>
      )}

      {/* error 已是主进程按后端 code 映射好的文案,原样显示。 */}
      {error && (
        <p className="text-xs text-red-300 border-l-2 border-red-700 pl-3 py-1">{error}</p>
      )}

      {/* 两个浮层都自己 portal 到 body(理由见它们内部的注释:Codex 聊天面板的
          backdrop-blur 自成层叠上下文、各 tab 靠 display:none 切换),所以挂在这里
          不影响它们的定位;写在 section 末尾只是为了让 JSX 的阅读顺序贴近视觉层级。

          `pool` 直接把 store 里的引用递下去。抽屉的 hook 刻意只依赖 `projectId`
          原始值而不是 pool 对象,所以这里传不稳定引用也不会打爆轮询。 */}
      <UsageDrawer open={usageOpen} pool={selectedPool} onClose={closeUsage} />
      <RechargeModal open={rechargeOpen} onClose={closeRecharge} />
    </section>
  )
}

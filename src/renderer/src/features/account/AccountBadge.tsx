// 头部账号胶囊。登录入口与余额的**常驻**出口。
//
// ## 为什么要有它
//
// 在这之前,登录和余额只有进设置页才看得到 —— 新用户根本不知道可以登录,老用户
// 想瞄一眼还剩多少钱得先离开正在做的事。用户原话:「只有用户打开设置页才能登录
// 和看到扣费,不应该这样」。
//
// ## 参考 Cursor / Codex,但**有意在一处不照抄**
//
// 两家都把用量放在输入框正下方而不是顶栏,而且 Cursor 默认 `auto` —— 平时藏着,
// 接近上限才出现。它们能这么做是因为**只有一个钱包、且必须登录才能用**:用量是
// 一个百分比,平时不用管。
//
// 这里是预付费余额、两条计费路(平台余额 / 自有 Key)、且登录是可选的。所以:
//  - 余额**常显**而不是 auto —— 按张扣钱的人随时想知道还剩多少(用户拍板);
//  - 除了数字还要显示**这次花谁的钱**,那是两家都没有的问题。
//
// 详细账目、切池那些低频操作仍留在设置页 —— 与两家「详情去 dashboard」一致。
//
// ## 配色
//
// 挂在 index.html 那套旧壳的头部里,所以用**字面 hex**(#FCE300 / #27272A /
// #3F3F46),与相邻的「设置」「更新」按钮逐字一致。这里**不能**用设置页那套
// tailwind 主题 token —— 那是另一套上下文,混进来会在同一排按钮里显出色差。

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuthStore } from '../../stores/useAuthStore'
import { useQuotaStore } from '../../stores/useQuotaStore'
import { RechargeModal } from '../../pages-react/settings/RechargeModal'
import { UsageDrawer } from '../../pages-react/settings/UsageDrawer'
import { balanceLevel, balanceText } from './balance'
import { buildPoolOptions, poolLabelOf } from './pools'

/** 余额档位 → 数字颜色。`unknown` 用灰,免得「未知」被误读成「告急」。 */
const BALANCE_TONE: Record<ReturnType<typeof balanceLevel>, string> = {
  unknown: 'text-[#A1A1AA]',
  empty: 'text-[#f87171]',
  low: 'text-[#FCE300]',
  ok: 'text-[#FAFAFA]',
}

/** 头部那排按钮的共同外形。抄自相邻的「设置」按钮,保持一排里不出戏。 */
const CHROME_BUTTON =
  'flex items-center space-x-1 lg:space-x-2 bg-[#27272A] border-2 border-[#3F3F46] px-3 lg:px-4 py-2 rounded-none transition-all cursor-pointer'

export function AccountBadge() {
  const authenticated = useAuthStore((s) => s.authenticated)
  const username = useAuthStore((s) => s.username)
  const displayName = useAuthStore((s) => s.displayName)
  const pending = useAuthStore((s) => s.pending)
  const hydrate = useAuthStore((s) => s.hydrate)
  const ensureSubscriptions = useAuthStore((s) => s.ensureSubscriptions)
  const startLogin = useAuthStore((s) => s.startLogin)

  const balanceYuan = useQuotaStore((s) => s.balanceYuan)
  const selectedPool = useQuotaStore((s) => s.selectedPool)
  const billingSource = useQuotaStore((s) => s.billingSource)
  const organizations = useQuotaStore((s) => s.organizations)
  const personalBillingProjectId = useQuotaStore((s) => s.personalBillingProjectId)
  const loadQuota = useQuotaStore((s) => s.load)

  const [open, setOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [rechargeOpen, setRechargeOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // 与设置页的账号分区同一套:接推送 + 拉当前状态,缺一不可。两处都调是对的 ——
  // 这两个动作都幂等,而胶囊常驻、设置页按需挂载,谁先到不确定。
  useEffect(() => {
    ensureSubscriptions()
    void hydrate()
  }, [ensureSubscriptions, hydrate])

  // 额度那几个端点挂了 authMiddleware,未登录发过去只会拿 401。
  useEffect(() => {
    if (!authenticated) return
    void loadQuota()
  }, [authenticated, loadQuota])

  // 点外面收起。**用 mousedown 而不是 click**:面板里的按钮点下去会先触发这个,
  // 若用 click,收起与按钮自身的 onClick 会在同一拍里打架,表现成「点充值没反应」。
  // mousedown 先于 click,配合下面的 contains 判断,面板内的点击不会被当成外部点击。
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  const goSettings = useCallback(() => {
    setOpen(false)
    // 旧壳的标签页切换走全局事件委托(`data-action="open-settings"`),这里没有
    // 那个 DOM 上下文,所以直接点它 —— 比复制一份切页逻辑可靠。
    document.getElementById('settingsBtn')?.click()
  }, [])

  // 未登录:一个明确的「登录」按钮。这是这次改动最要紧的一条 —— 在这之前,
  // 用户没有任何理由会想到去设置页里找登录。
  if (!authenticated) {
    return (
      <button
        type="button"
        data-testid="account-badge-login"
        onClick={() => void startLogin()}
        disabled={pending}
        title="登录后可用账号余额出图"
        className={`${CHROME_BUTTON} text-[#FAFAFA] hover:bg-[#FCE300] hover:text-black hover:border-[#FCE300] disabled:opacity-50 disabled:cursor-wait`}
      >
        <i className="fas fa-user" />
        <span className="hidden lg:inline font-bold uppercase tracking-tighter">
          {pending ? '授权中…' : '登录'}
        </span>
      </button>
    )
  }

  const usingPlatform = billingSource === 'platform'
  const level = balanceLevel(balanceYuan)
  const name = displayName ?? username ?? '已登录'
  const poolReady = selectedPool !== null
  // 与出图页那条计费提示共用同一份构造,免得同一个池在两处显示成不同的名字。
  const poolName = poolLabelOf(
    buildPoolOptions(organizations, personalBillingProjectId),
    selectedPool,
  )

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        data-testid="account-badge"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={usingPlatform ? `账号余额 · ${name}` : `自有 Key 计费 · ${name}`}
        className={`${CHROME_BUTTON} text-[#FAFAFA] hover:border-[#FCE300]`}
      >
        <i className="fas fa-user text-[#FCE300]" />
        {/* 平台计费才显示数字。自有 Key 时余额不是这次要花的钱,摆一个大额数字
            在那儿反而会让人以为出图走的是它 —— 那正是这次要消灭的歧义。 */}
        {usingPlatform ? (
          <span
            data-testid="account-badge-balance"
            className={`font-bold tabular-nums ${BALANCE_TONE[level]}`}
          >
            {balanceText(balanceYuan)}
          </span>
        ) : (
          <span
            data-testid="account-badge-ownkey"
            className="hidden lg:inline font-bold uppercase tracking-tighter text-[#A1A1AA]"
          >
            自有 Key
          </span>
        )}
        <i className="fas fa-chevron-down text-xs text-[#A1A1AA]" />
      </button>

      {open && (
        <div
          data-testid="account-badge-panel"
          className="absolute right-0 top-full mt-2 w-72 bg-[#09090B] border-2 border-[#3F3F46] rounded-none z-[999999] p-4 space-y-3 text-left"
        >
          <div className="min-w-0">
            <div className="text-sm text-[#FAFAFA] font-medium truncate">{name}</div>
            {/* 组织/计费池名压在账号名下面。
                
                这一行不是装饰 —— 一个账号下挂着多个计费池,而「这次花谁的钱」正是
                头部胶囊要回答的核心问题。只写账号名的话,用户知道自己是谁,却仍然
                不知道钱从哪个池出。
                
                查不到名字时退回泛称,不编一个 —— 一个可能过期的池名比没有更糟。 */}
            <div data-testid="account-badge-pool" className="text-xs text-[#A1A1AA] mt-0.5 truncate">
              {usingPlatform ? (poolName ?? '账号余额') : '出图走自有 Key'}
            </div>
          </div>

          <div className="border-t-2 border-[#3F3F46] pt-3">
            <div className="text-xs text-[#A1A1AA]">计费池余额</div>
            <div
              data-testid="account-badge-panel-balance"
              className={`text-2xl font-bold tabular-nums mt-1 ${BALANCE_TONE[level]}`}
            >
              {balanceText(balanceYuan)}
            </div>
            {/* 余额未知时别催充值 —— 该做的是选池或重试,不是掏钱。 */}
            {level === 'empty' && (
              <p className="text-xs text-[#f87171] mt-1">余额已用尽,充值后才能继续用账号余额出图。</p>
            )}
            {level === 'low' && (
              <p className="text-xs text-[#FCE300] mt-1">余额不多了。</p>
            )}
            {level === 'unknown' && (
              <p className="text-xs text-[#A1A1AA] mt-1">
                {poolReady ? '暂时查不到余额,稍后重试。' : '还没选计费池。'}
              </p>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              data-testid="account-badge-recharge"
              onClick={() => setRechargeOpen(true)}
              disabled={!poolReady}
              className="flex-1 px-3 py-2 bg-[#FCE300] hover:opacity-90 text-black text-xs font-bold uppercase tracking-tighter transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              充值
            </button>
            <button
              type="button"
              data-testid="account-badge-usage"
              onClick={() => setUsageOpen(true)}
              disabled={!poolReady}
              className="flex-1 px-3 py-2 bg-[#27272A] border-2 border-[#3F3F46] hover:border-[#71717A] text-[#FAFAFA] text-xs font-bold uppercase tracking-tighter transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              使用明细
            </button>
          </div>

          {/* 切计费池、切计费来源这些低频且需要解释的操作留在设置页 —— 把那套
              下拉和二选一按钮在这里再实现一遍,只会多一处会漂的副本。 */}
          <button
            type="button"
            data-testid="account-badge-settings"
            onClick={goSettings}
            className="w-full px-3 py-2 bg-[#27272A] border-2 border-[#3F3F46] hover:border-[#71717A] text-[#A1A1AA] hover:text-[#FAFAFA] text-xs font-bold uppercase tracking-tighter transition-colors"
          >
            账号与计费设置
          </button>
        </div>
      )}

      {/* 两个浮层自己 portal 到 body,所以挂在这个 relative 容器里也不会被它裁掉。 */}
      <UsageDrawer open={usageOpen} pool={selectedPool} onClose={() => setUsageOpen(false)} />
      <RechargeModal open={rechargeOpen} onClose={() => setRechargeOpen(false)} />
    </div>
  )
}

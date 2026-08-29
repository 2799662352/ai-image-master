// 设置页 · 账号分区。身份先于 API 站点,所以排在设置页第一节。
//
// 独立成文件而不是写在 SettingsPage(621 行)里,一是那文件已经够长,二是分区
// 只依赖 auth 桥、能单测 —— 整页搬进 jsdom 得先喂饱四套无关 IPC。
//
// 配色跟随所在页面,用设置页那套主题 token(bg-cyberpunk-yellow / border-zinc-700
// ……),不要混进全屏登录页的字面 hex。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { getApiService } from '../../services/api/ApiService'
import { useAuthStore } from '../../stores/useAuthStore'
import { useModelStore } from '../../stores/useModelStore'
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
  const billingSource = useQuotaStore((s) => s.billingSource)
  const loadQuota = useQuotaStore((s) => s.load)
  const selectPool = useQuotaStore((s) => s.selectPool)
  const setBillingSource = useQuotaStore((s) => s.setBillingSource)

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

  /**
   * 切换中禁用两个按钮。
   *
   * 这一步要跨一趟 IPC(主进程去后端换影子账户凭据),不锁住的话用户连点两下会打出
   * 两次 arm —— 后一次的结果覆盖前一次,而 UI 上按下去的顺序早就看不出来了。
   * 用局部 state 而不是 store 的 `loading`:那个是组织列表的转圈,借用会让整块闪一下。
   */
  const [switching, setSwitching] = useState(false)
  const switchBilling = useCallback(
    async (next: 'platform' | 'own-key') => {
      setSwitching(true)
      try {
        await setBillingSource(next)
      } finally {
        setSwitching(false)
      }
    },
    [setBillingSource],
  )

  /**
   * 当前选中的模型是否用不了平台余额。
   *
   * 场景很窄但很痛:站点选了 Miau、开关也开着,偏偏那几个谷歌原生模型的请求会绕开
   * 平台网关(源站直连,判据见 `evaluatePlatformBillingEligibility`)—— 不提示的话
   * 用户点出图只会收到一个没有上下文的 401,而他刚把计费切到平台余额,只会去怀疑
   * 余额或账号。
   *
   * 只认 `model-bypasses-gateway` 这一种原因:站点不对时下面那句 hint 已经说清楚了,
   * 这里再冒一条会让人误以为「换个模型就行」。
   *
   * **每次渲染现算,不做 memo。** 判据是两次对象查表,比维护依赖数组便宜;而依赖数组
   * 这里恰恰容易漏 —— 站点是从 service 现读的,它变了并不会改任何 props/state,
   * memo 反而会把结论钉在过期的站点上。
   */
  const currentModelKey = useModelStore((s) => s.currentModelKey)
  const unsupportedModelName =
    billingSource === 'platform' &&
    getApiService().getPlatformBillingEligibility(currentModelKey).blocker ===
      'model-bypasses-gateway'
      ? (getApiService().getModelConfig(currentModelKey)?.name ?? currentModelKey)
      : null

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

            {/* 出图的钱从哪出。
                
                二选一而不是单个 checkbox:两种模式都是正常状态,不存在「默认那个」在
                语义上更对 —— 让当前态自己亮着,比让用户从一个勾的有无去推断强。
                
                未选池时禁用平台那一侧:没有池就没有影子账户可扣,本地就知道的事不必
                发一趟 IPC 去换一个报错。原因写在下面的 hint 里,不然禁用了也没人知道
                该怎么办。 */}
            <div className="space-y-1 pt-1">
              <div className="text-xs text-zinc-400">出图计费</div>
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid="billing-own-key"
                  aria-pressed={billingSource === 'own-key'}
                  disabled={switching}
                  onClick={() => void switchBilling('own-key')}
                  className={`flex-1 px-3 py-2 border-2 text-xs font-bold uppercase tracking-tight transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    billingSource === 'own-key'
                      ? 'bg-cyberpunk-yellow border-cyberpunk-yellow text-cyberpunk-black'
                      : 'bg-zinc-900 border-zinc-700 text-white hover:border-zinc-500'
                  }`}
                >
                  自有 Key
                </button>
                <button
                  type="button"
                  data-testid="billing-platform"
                  aria-pressed={billingSource === 'platform'}
                  disabled={!poolReady || switching}
                  onClick={() => void switchBilling('platform')}
                  className={`flex-1 px-3 py-2 border-2 text-xs font-bold uppercase tracking-tight transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    billingSource === 'platform'
                      ? 'bg-cyberpunk-yellow border-cyberpunk-yellow text-cyberpunk-black'
                      : 'bg-zinc-900 border-zinc-700 text-white hover:border-zinc-500'
                  }`}
                >
                  平台余额
                </button>
              </div>
              {/* 这句不是免责声明,是必须说清的事实,而且**范围比站点更窄**。
                  
                  曾经写的是「仅对『Miau API』站点生效」—— 那承诺的是**站点级**覆盖,
                  而实现是**按请求路径**的:标记头由 `applyAuthHeaders` 打,只有 6 个出图/
                  TTS 出网点会走它。图像理解(`understandImage` / `analyzeImagesStream` /
                  `understand`)打的就是这个站点,却从不经过那个方法,照旧扣自填 Key 的钱。
                  所以那句话对用户是假的:他以为在这个站点上花的都是账号余额。
                  
                  这里刻意只点名「图像理解」这一个已核实的例外,不写「其余功能一律不覆盖」
                  —— TTS 其实是覆盖的,把话说满会在另一个方向上再假一次。 */}
              <p
                data-testid="billing-hint"
                className="text-xs text-zinc-500 leading-relaxed"
              >
                {!poolReady
                  ? '先在上面选一个计费池,才能用平台余额出图。'
                  : billingSource === 'platform'
                    ? '当前用账号余额出图,仅覆盖「Miau API」站点上的出图请求。图像理解走的是同一个站点,但仍扣自填密钥;其余站点也各走各的密钥。'
                    : '当前用下方「API 站点」里配置的密钥出图,不扣这里的账号余额。'}
              </p>
              {/* 站点对了、开关也开了,模型仍可能用不了 —— 见上面 unsupportedModelName
                  的注释。这条比上面那句更醒目(黄色左边框),因为它说的是「你以为在用
                  平台余额,但这一次不是」,而不是一般性说明。 */}
              {unsupportedModelName && (
                <p
                  data-testid="billing-model-hint"
                  className="text-xs text-yellow-300/80 border-l-2 border-cyberpunk-yellow pl-3 py-1 leading-relaxed"
                >
                  {/* 整句走模板串而不是散在 JSX 文本里:JSX 会把换行缩进折成一个
                      空格,中文句子里会平白多出「端点, 请求」这样的空格。 */}
                  {`当前模型「${unsupportedModelName}」用不了平台余额:` +
                    '它走谷歌原生端点,请求绕开了平台网关。' +
                    '这次出图会改用下方「API 站点」里配置的密钥;' +
                    '想用平台余额请先换一个模型。'}
                </p>
              )}
            </div>
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

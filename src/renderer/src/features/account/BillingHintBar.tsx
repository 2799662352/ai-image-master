// 出图按钮下方的一行:**这一次点下去,花的是谁的钱。**
//
// ## 为什么头部已经有胶囊了还要这一条
//
// 这是 Cursor 和 Codex 共同的做法 —— 用量显示在输入框正下方,而不是顶栏。理由是
// 决策发生在按钮前面那一刻:头部那枚胶囊解决「我想看的时候看得到」,这一条解决
// 「我按下去之前知道会发生什么」。两者不重复。
//
// ## 声量按档位走(照 Cursor 的 `auto` 语义)
//
// 余额充裕时是一行灰字,和背景几乎融为一体 —— 常显但不抢注意力。只有余额偏低 /
// 用尽时才升级成带颜色边框 + 充值按钮。**这一层就是「余额不足时的行内补救」**:
// 用户不必先去撞一个失败,再自己找去哪充钱。
//
// ## 未登录时什么都不渲染
//
// 头部胶囊此刻已经是一枚「登录」按钮了,这里再劝一次就是重复劝导。而且未登录的人
// 大概率正在用自有 Key 正常工作,不该被打扰。

import { useState } from 'react'
import { useAuthStore } from '../../stores/useAuthStore'
import { useQuotaStore } from '../../stores/useQuotaStore'
import { RechargeModal } from '../../pages-react/settings/RechargeModal'
import { balanceLevel, balanceText } from './balance'
import { buildPoolOptions, poolLabelOf } from './pools'

export function BillingHintBar() {
  const authenticated = useAuthStore((s) => s.authenticated)
  const billingSource = useQuotaStore((s) => s.billingSource)
  const balanceYuan = useQuotaStore((s) => s.balanceYuan)
  const selectedPool = useQuotaStore((s) => s.selectedPool)
  const organizations = useQuotaStore((s) => s.organizations)
  const personalBillingProjectId = useQuotaStore((s) => s.personalBillingProjectId)

  const [rechargeOpen, setRechargeOpen] = useState(false)

  if (!authenticated) return null

  // 自有 Key:一句陈述就够。这条**必须有** —— 用户可能刚在设置页切过来,而出图页
  // 上没有任何东西会告诉他这次不走账号余额。
  if (billingSource !== 'platform') {
    return (
      <p data-testid="billing-hint-bar" className="text-xs text-zinc-500 mt-2">
        本次使用「API 站点」里配置的自有 Key 计费。
      </p>
    )
  }

  // 现算不 memo:两次数组遍历,比维护依赖数组便宜,而依赖数组这里恰好容易漏。
  const poolName = poolLabelOf(
    buildPoolOptions(organizations, personalBillingProjectId),
    selectedPool,
  )
  const level = balanceLevel(balanceYuan)
  const wallet = poolName ? `「${poolName}」` : '账号余额'

  if (level === 'ok' || level === 'unknown') {
    return (
      <p data-testid="billing-hint-bar" className="text-xs text-zinc-500 mt-2">
        本次从{wallet}扣费
        {/* 余额未知时**不**把「余额未知」拼进这句 —— 那会让一句本来只是交代
            钱包的话看起来像报错。头部胶囊那边已经说清楚了。 */}
        {level === 'ok' ? ` · 余额 ${balanceText(balanceYuan)}` : ''}
      </p>
    )
  }

  const empty = level === 'empty'
  return (
    <div
      data-testid="billing-hint-bar"
      className={`mt-2 flex items-center justify-between gap-3 border-l-2 pl-3 py-1.5 ${
        empty ? 'border-red-500' : 'border-cyberpunk-yellow'
      }`}
    >
      <p className={`text-xs leading-relaxed ${empty ? 'text-red-300' : 'text-yellow-300/80'}`}>
        {empty
          ? `${wallet}已用尽,这次出图会失败。充值后继续,或到设置页切回自有 Key。`
          : `${wallet}只剩 ${balanceText(balanceYuan)},可能不够这一次。`}
      </p>
      <button
        type="button"
        data-testid="billing-hint-recharge"
        onClick={() => setRechargeOpen(true)}
        disabled={!selectedPool}
        className="shrink-0 px-4 py-1.5 bg-cyberpunk-yellow hover:opacity-90 text-cyberpunk-black text-xs font-bold uppercase tracking-tight transition-all disabled:opacity-40 disabled:cursor-not-allowed"
      >
        充值
      </button>
      <RechargeModal open={rechargeOpen} onClose={() => setRechargeOpen(false)} />
    </div>
  )
}

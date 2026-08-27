// 设置页 · 原生充值弹窗。三步:建单 → 系统浏览器付款 → 轮询到账。
//
// 独立成文件而不是塞进 `AccountSection`:这一块自带一个状态机(建单/等待付款/入账中/
// 成功/关闭/超时/失败)与一个定时器,混进账号分区会让那边的每次渲染都拖着轮询状态跑。
//
// 配色跟随设置页那套 token(bg-cyberpunk-yellow / border-2 border-zinc-700 / 直角),
// 不要混进 Codex 侧的 cyan + rounded-md,也没有 `.miau-*` 类可用(桌面端不存在)。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  MAX_RECHARGE_CNY,
  type QuotaRpc,
  type RechargeOrder,
  type RechargeOrderCreated,
  type RechargeTarget,
} from '../../../../types/authApi'
import { useQuotaStore, type Pool } from '../../stores/useQuotaStore'

/** 预设金额。自定义输入优先于预设,见 `effectiveAmount`。 */
const PRESET_AMOUNTS = [10, 30, 50, 100] as const

const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS = 5 * 60 * 1000
/**
 * 超时按**轮询次数**判,不按 `Date.now()` 的差值判。
 *
 * 一是它由上面两个常量推出来,改间隔不用同时改另一处;二是它不依赖挂钟 ——
 * 机器休眠或系统改时间时,按时间差判会瞬间跳到超时,而订单其实还好着。
 */
const MAX_POLLS = Math.ceil(POLL_TIMEOUT_MS / POLL_INTERVAL_MS)

/**
 * 弹窗的状态机。
 *
 * `waiting`(等付款)与 `crediting`(支付宝已收款、影子账户还没入账)**都要继续轮询** ——
 * 两者的区别只在文案。终态是 `success` / `closed` / `timeout` / `error`。
 */
type Stage =
  | 'idle'
  | 'creating'
  | 'waiting'
  | 'crediting'
  | 'success'
  | 'closed'
  | 'timeout'
  | 'error'

interface RechargeModalProps {
  open: boolean
  onClose: () => void
}

type RechargeApi = {
  createRechargeOrder: (
    amountCny: number,
    target: RechargeTarget,
    subject?: string,
  ) => Promise<QuotaRpc<RechargeOrderCreated>>
  getRechargeOrder: (outTradeNo: string) => Promise<QuotaRpc<RechargeOrder>>
}

function getRechargeApi(): RechargeApi | undefined {
  return (window as Window & { electronAPI?: { auth?: RechargeApi } }).electronAPI?.auth
}

/**
 * 付款页**只能**交给系统浏览器。
 *
 * `will-navigate` 的白名单只放同源与 `file:`,应用内导航会被静默拦下 —— 表现是
 * 「点了支付什么都没发生」,没有任何报错可循。取用方式与 `AccountSection.tsx:106-113`
 * 一致(层层可选链:桥在单测/早期启动里可能还不存在)。
 */
function openInSystemBrowser(url: string): void {
  const api = (
    window as Window & {
      electronAPI?: { shell?: { openExternal?: (u: string) => unknown } }
    }
  ).electronAPI
  void api?.shell?.openExternal?.(url)
}

/**
 * 把当前选中的池映射成后端要的**三选一**项目上下文。
 *
 * 三条分支的字段互斥,不是三个可选字段:
 * - 个人计费落点 → `{ kind: 'personal' }`,**绝不夹带 `projectId`**。夹带了后端就会走进
 *   成员校验分支,而个人落点刻意**不出现在** `/api/user/organizations` 里(那是它的设计
 *   前提)→ 查不到 `joined` → fail-closed 403,整条充值路径不可用。
 * - producer 池 → `producerId` 取的是 **`pool.projectId`**(后端的命名),另一半才是
 *   `producerProjectId`;后端用 `p.project_id === prodId && p.producer_project_id === ppid`
 *   做成员校验(`payment.ts:194-196`)。主进程的 `fetchBalance` 也是同一套映射
 *   (`session.ts:268-270`:`producerId=projectId`)。取错字段不会报错,只会 403。
 * - 其余 → `{ kind: 'project', projectId }`。
 *
 * 未选池返回 `null`:没有项目上下文就不该能发起充值。
 */
function deriveTarget(pool: Pool | null, personalBillingProjectId: number | null): RechargeTarget | null {
  if (!pool) return null
  if (
    personalBillingProjectId !== null &&
    pool.projectId === personalBillingProjectId &&
    pool.producerProjectId === null
  ) {
    return { kind: 'personal' }
  }
  if (pool.producerProjectId !== null) {
    return { kind: 'producer', producerId: pool.projectId, producerProjectId: pool.producerProjectId }
  }
  return { kind: 'project', projectId: pool.projectId }
}

/**
 * 给后端 error code 补一句「下一步该干什么」。
 *
 * `message` 本身已是主进程映射好的可读文案,原样显示;但光有它不够 ——
 * 最典型的是 `FORBIDDEN`:它的真实含义是「你不是该项目的**已加入成员**」(fail-closed 的
 * 成员校验),不是「没权限充值」。只报「无权访问该项目」的话,用户会对着同一个池反复重试。
 */
function failureHint(code: string): string | null {
  switch (code) {
    case 'FORBIDDEN':
      return '你还不是这个计费池的成员。请先在网页端加入,或在上方切换到其它计费池(个人计费不需要加入)。'
    case 'NOT_AUTHENTICATED':
      return '登录状态已失效。请退出后重新登录,再发起充值。'
    case 'INVALID_TARGET':
      return '计费池上下文异常。请回到上方重新选择一次计费池。'
    case 'ALIPAY_GATEWAY_ERROR':
    case 'UPSTREAM_FAILED':
      return '支付渠道暂时不可用。稍后重试即可,不要重复付款。'
    default:
      return null
  }
}

export function RechargeModal({ open, onClose }: RechargeModalProps) {
  // 充值目标直接从 store 推,**不走 prop**:目标必须与当前选中的池严格一致,
  // 多一层 prop 就多一个可以对不上的地方(而对不上的后果是钱进错池)。
  const selectedPool = useQuotaStore((s) => s.selectedPool)
  const personalBillingProjectId = useQuotaStore((s) => s.personalBillingProjectId)
  const organizations = useQuotaStore((s) => s.organizations)

  const [preset, setPreset] = useState<number>(PRESET_AMOUNTS[0])
  const [custom, setCustom] = useState('')
  const [stage, setStage] = useState<Stage>('idle')
  const [outTradeNo, setOutTradeNo] = useState<string | null>(null)
  const [creditError, setCreditError] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null)

  // 轮询次数放 ref 而不是 state:它每 3 秒变一次,进 state 会让轮询 effect 的依赖跟着变、
  // 于是每次都清掉重建 interval,计数永远回到 0 —— 超时线就再也到不了了。
  const pollsRef = useRef(0)

  /**
   * 单调递增的查单序号 —— **只有最后发起的那一跳的结果允许写 state。**
   *
   * 3 秒一跳,任何一跳的响应超过 3 秒就会与下一跳重叠。没有这个守卫时,若第 N 跳(慢,
   * 回 PENDING)在第 N+1 跳(快,回 CREDITED)之后才 resolve:
   *   success → setStage('waiting') → polling 变回 true → interval 重启 → 轮到超时
   * 用户看到「充值成功」闪一下变成「未确认到账」,而钱已经到账、`refreshBalance()` 也调过了。
   * 那一刻他最可能的动作是**再付一次**。
   *
   * 与明细抽屉是同一个模式(那边守的是「切了时间范围却显示上一个范围的数据」)。
   */
  const tickSeqRef = useRef(0)

  const target = useMemo(
    () => deriveTarget(selectedPool, personalBillingProjectId),
    [selectedPool, personalBillingProjectId],
  )

  // 自定义输入优先。空串/纯空格视为「没填」,回落到预设。
  const amount = custom.trim() === '' ? preset : Number.parseFloat(custom)
  /**
   * 写成 `!(amount > 0)` 而不是 `amount <= 0`。
   *
   * 自定义输入过 `parseFloat` 会产出 `NaN`,而 **`NaN <= 0` 是 `false`** —— 用 `<=` 判
   * 会把 NaN 一路放行,发出去一个 `amountCny: NaN`。主进程那层也是同一个写法
   * (`session.ts:634`),两边都拦是因为这里要在用户输入时就地反馈,不等一个 RTT。
   */
  const amountInvalid = !(amount > 0) || amount > MAX_RECHARGE_CNY
  const busy = stage === 'creating'
  const polling = stage === 'waiting' || stage === 'crediting'
  const canSubmit = target !== null && !amountInvalid && !busy && !polling

  /** 充值到哪个池 —— 付款前让用户能核对一眼,钱进错池是不可逆的。 */
  const poolLabel = useMemo(() => {
    if (!selectedPool || !target) return null
    if (target.kind === 'personal') return '个人计费'
    const hit = organizations.find(
      (o) =>
        o.id === selectedPool.projectId &&
        (o.producerProjectId ?? null) === selectedPool.producerProjectId,
    )
    const base = hit ? (hit.studioName ? `${hit.studioName} / ${hit.name}` : hit.name) : `项目 #${selectedPool.projectId}`
    return selectedPool.producerProjectId !== null
      ? `${base}(子项目 #${selectedPool.producerProjectId})`
      : base
  }, [organizations, selectedPool, target])

  const submit = useCallback(async () => {
    if (!target || amountInvalid) return
    const api = getRechargeApi()
    if (!api?.createRechargeOrder) {
      setFailure({ code: 'BRIDGE_UNAVAILABLE', message: '桌面端桥接不可用,请重启应用后再试' })
      setStage('error')
      return
    }

    pollsRef.current = 0
    setFailure(null)
    setCreditError(null)
    setOutTradeNo(null)
    setStage('creating')

    // 主进程刻意回信封而不是裸抛(裸抛经 IPC 会丢掉后端 code),所以这里解信封是主路径,
    // 不是 catch。
    const res = await api.createRechargeOrder(amount, target, '余额充值')
    if (!res.ok) {
      setFailure(res.error)
      setStage('error')
      return
    }

    // `payUrl` **不入 state**:它是支付宝现签的一次性链接(带 `timeout_express`,默认 10m,
    // `alipayService.ts:139-160`)。存下来就一定会有人在重试时复用它 —— 过期后点开是支付宝的
    // 报错页,而用户以为是本应用坏了。重试走的是重新建单。
    openInSystemBrowser(res.data.payUrl)
    setOutTradeNo(res.data.outTradeNo)
    setCreditError(res.data.creditError)
    setStage(res.data.status === 'PAID' ? 'crediting' : 'waiting')
  }, [amount, amountInvalid, target])

  const tick = useCallback(async () => {
    const api = getRechargeApi()
    if (!api?.getRechargeOrder || !outTradeNo) return

    pollsRef.current += 1
    const overdue = pollsRef.current >= MAX_POLLS
    const mySeq = ++tickSeqRef.current

    const res = await api.getRechargeOrder(outTradeNo)
    // 已经有更晚发起的一跳了 —— 这次的结果是旧的,丢掉。见 `tickSeqRef` 上方那段。
    if (mySeq !== tickSeqRef.current) return

    if (!res.ok) {
      // 单次查单失败不判死:钱可能已经在路上,断网抖一下就宣告失败会诱使用户重复付款。
      // 只在到了超时线时才升级成终态。
      if (overdue) setStage('timeout')
      return
    }

    const o = res.data
    setCreditError(o.creditError)

    // 🚨 **只有 `CREDITED` 算成功。** `PAID` 表示支付宝收到钱、但入账影子账户失败
    // (此时 `creditError` 非空),状态就停在那里。把 `PAID` 当成功等于告诉用户余额已到账
    // 而实际没到 —— 他会去出图、拿到一个余额不足的错误,然后以为是应用在骗他。
    if (o.status === 'CREDITED') {
      setStage('success')
      // 不刷的话用户充完钱回到设置页看到的还是旧余额,会以为钱没到。
      void useQuotaStore.getState().refreshBalance()
      return
    }
    if (o.status === 'CLOSED') {
      setStage('closed')
      return
    }
    if (overdue) {
      setStage('timeout')
      return
    }
    setStage(o.status === 'PAID' ? 'crediting' : 'waiting')
  }, [outTradeNo])

  // 轮询。依赖里只有 `polling`(布尔)与 `outTradeNo`,所以 waiting ↔ crediting 之间来回
  // 不会重建 interval —— 重建会把节奏和 `pollsRef` 的语义一起打乱。
  useEffect(() => {
    if (!open || !polling || !outTradeNo) return
    const timer = window.setInterval(() => {
      void tick()
    }, POLL_INTERVAL_MS)
    // 必须清:`setInterval` 活在 window 上,弹窗关掉/组件卸载后它照样在打接口,
    // 并把 setState 打到已经没了的树上。
    return () => {
      window.clearInterval(timer)
    }
  }, [open, polling, outTradeNo, tick])

  // 关闭即遗忘。留着上一单的「等待付款」不只是脏状态:那张 payUrl 到重开时很可能已经过期,
  // 而 UI 会继续显示「等着你付款」。
  useEffect(() => {
    if (open) return
    pollsRef.current = 0
    setStage('idle')
    setOutTradeNo(null)
    setCreditError(null)
    setFailure(null)
    setCustom('')
    setPreset(PRESET_AMOUNTS[0])
  }, [open])

  // 轮询中不响应 Esc/点遮罩:此时误关会丢掉正在跟的订单号。显式的关闭按钮始终可用。
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !polling) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [open, polling, onClose])

  // 所有 hook 之后才允许提前返回 —— 顺序变了 React 会直接报错。
  if (!open) return null

  const hint = !target
    ? '请先在上方选择计费池,再发起充值。'
    : amountInvalid
      ? custom.trim() !== '' && !(amount > 0)
        ? '请输入有效的充值金额。'
        : `单笔充值上限 ¥${MAX_RECHARGE_CNY}。`
      : null

  const status = describeStage(stage, creditError)

  // z 取 50000:与既有模态同带(`TemplatePickerModal.tsx:79`、`Lightbox.tsx:80`)。
  // 下界是聊天面板/工作区浮层的 40000 —— 低于它会被盖住;上界是全屏登录覆盖层的 75000
  // (`DesktopLoginPage.tsx:139`,有防回归测试 `DesktopLoginPage.test.tsx:96`),
  // **绝不能 ≥ 75000**:登录覆盖层出现时必须压住一切。
  //
  // portal 到 body 而不是就地渲染:聊天面板的 <aside> 带 backdrop-blur、自成 stacking
  // context,内部元素无论 z 多大都被祖先钳在 40000 层(血泪注释在 `PetOverlay.tsx:403-408`);
  // 且各 tab 容器靠 `display:none` 切换、不 unmount(`react-app/main.tsx:153-156`)。
  return createPortal(
    <div
      data-testid="recharge-modal"
      className="fixed inset-0 z-[50000] flex items-center justify-center bg-[#09090B]/90 p-4"
      onClick={() => {
        if (!polling) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="充值"
        className="w-full max-w-md bg-[#09090B] border-2 border-zinc-700 flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b-2 border-zinc-700 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-white font-bold uppercase tracking-tight">充值</h2>
            {poolLabel && (
              <p className="text-xs text-zinc-400 mt-0.5 truncate">充值到 {poolLabel}</p>
            )}
          </div>
          <button
            type="button"
            data-testid="recharge-close"
            aria-label="关闭"
            onClick={onClose}
            className="shrink-0 px-3 py-1 bg-zinc-800 border-2 border-zinc-700 hover:bg-zinc-700 text-white text-xs font-bold uppercase tracking-tight transition-colors"
          >
            关闭
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div className="space-y-2">
            <span className="block text-xs text-zinc-400">充值金额（元）</span>
            <div className="grid grid-cols-4 gap-2">
              {PRESET_AMOUNTS.map((v) => {
                const active = custom.trim() === '' && preset === v
                return (
                  <button
                    key={v}
                    type="button"
                    data-testid={`recharge-preset-${v}`}
                    disabled={busy || polling}
                    onClick={() => {
                      setPreset(v)
                      // 选了预设就清掉自定义,否则自定义会继续压着预设,
                      // 用户看到高亮跳了但金额没变。
                      setCustom('')
                    }}
                    className={`px-2 py-2 border-2 text-sm font-bold tabular-nums transition-colors disabled:opacity-50 ${
                      active
                        ? 'bg-cyberpunk-yellow border-cyberpunk-yellow text-cyberpunk-black'
                        : 'bg-zinc-800 border-zinc-700 text-white hover:bg-zinc-700'
                    }`}
                  >
                    ¥{v}
                  </button>
                )
              })}
            </div>
            <input
              data-testid="recharge-custom"
              type="text"
              inputMode="decimal"
              value={custom}
              disabled={busy || polling}
              onChange={(e) => setCustom(e.target.value)}
              placeholder={`自定义金额，上限 ¥${MAX_RECHARGE_CNY}`}
              className="w-full px-3 py-2 bg-zinc-900 border-2 border-zinc-700 text-white placeholder:text-zinc-600 focus:outline-none focus:border-cyberpunk-yellow text-sm tabular-nums disabled:opacity-50"
            />
            {hint && (
              <p data-testid="recharge-hint" className="text-xs text-yellow-300/80">
                {hint}
              </p>
            )}
          </div>

          {/* 状态区。等待付款 / 入账中 / 成功 / 已关闭 / 超时 各有各的文案 ——
              这几种情形对用户的下一步动作完全不同。 */}
          {status && (
            <div
              data-testid="recharge-status"
              className={`border-l-2 pl-3 py-1 text-xs leading-relaxed ${status.tone}`}
            >
              <p>{status.text}</p>
              {status.detail && <p className="mt-1 text-zinc-400">{status.detail}</p>}
              {outTradeNo && stage !== 'idle' && (
                <p className="mt-1 text-zinc-500 tabular-nums">订单号 {outTradeNo}</p>
              )}
            </div>
          )}

          {failure && (
            <div
              data-testid="recharge-error"
              className="border-l-2 border-red-700 pl-3 py-1 text-xs leading-relaxed text-red-300"
            >
              <p>{failure.message}</p>
              {failureHint(failure.code) && (
                <p className="mt-1 text-zinc-400">{failureHint(failure.code)}</p>
              )}
            </div>
          )}

          <p className="text-xs text-zinc-500 leading-relaxed">
            将在系统浏览器中打开支付宝。付款完成后这里会自动确认到账（每 3 秒检查一次，最多 5
            分钟）。
          </p>
        </div>

        <div className="px-5 py-3 border-t-2 border-zinc-700 flex items-center justify-end gap-2">
          {/* 失败/关闭/超时都给同一个出口:**重新建单**。旧的 payUrl 不复用。 */}
          {(stage === 'error' || stage === 'closed' || stage === 'timeout') && (
            <button
              type="button"
              data-testid="recharge-retry"
              onClick={() => void submit()}
              className="px-4 py-2 bg-zinc-800 border-2 border-zinc-700 hover:bg-zinc-700 text-white text-sm font-bold uppercase tracking-tight transition-colors"
            >
              重新发起
            </button>
          )}
          <button
            type="button"
            data-testid="recharge-submit"
            disabled={!canSubmit}
            onClick={() => void submit()}
            className="px-6 py-2 bg-cyberpunk-yellow hover:opacity-90 text-cyberpunk-black text-sm font-bold uppercase tracking-tight transition-all disabled:opacity-50"
          >
            {busy ? '创建订单…' : polling ? '等待付款…' : '去支付'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** 状态文案与色带。抽出来是为了让 JSX 那一段只管布局。 */
function describeStage(
  stage: Stage,
  creditError: string | null,
): { text: string; detail?: string; tone: string } | null {
  switch (stage) {
    case 'idle':
      return null
    case 'creating':
      return { text: '正在创建支付宝订单…', tone: 'border-zinc-700 text-zinc-300' }
    case 'waiting':
      return {
        text: '等待付款。已在系统浏览器中打开支付宝收银台。',
        detail: '付款后无需回来点任何按钮，这里会自动确认。',
        tone: 'border-cyberpunk-yellow text-yellow-300/90',
      }
    case 'crediting':
      // PAID 但还没 CREDITED。**这不是成功** —— 钱在支付宝那边收到了,影子账户还没进账。
      return {
        text: '支付宝已收到款项，正在入账到计费池…',
        detail: creditError
          ? `入账暂未完成：${creditError}。系统会继续重试，请不要重复付款。`
          : '入账通常几秒内完成。',
        tone: 'border-cyberpunk-yellow text-yellow-300/90',
      }
    case 'success':
      return {
        text: '充值成功，余额已到账并刷新。',
        tone: 'border-green-700 text-green-300',
      }
    case 'closed':
      return {
        text: '订单已关闭，本次充值未完成。',
        detail: '如果你确实付了款，请稍后在网页端查看充值记录，不要重复付款。',
        tone: 'border-red-700 text-red-300',
      }
    case 'timeout':
      return {
        text: '5 分钟内未确认到账。',
        detail:
          '若已完成付款，钱不会丢——请稍后在网页端的充值记录里核对；也可以重新发起一笔新订单。',
        tone: 'border-red-700 text-red-300',
      }
    case 'error':
      return null
    default: {
      // 加了新 stage 又漏写文案时,这里是编译错误,而不是一个空白的状态区。
      const exhaustive: never = stage
      throw new Error(`未处理的充值状态 ${String(exhaustive)}`)
    }
  }
}

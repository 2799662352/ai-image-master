// 设置页 · 原生充值弹窗。
//
// 按 `AccountSection.test.tsx` 的范式:`Object.defineProperty(window, 'electronAPI', …)`
// 伪造 preload 桥,**不 mock store** —— 值全在「store 与 UI 接线对不对」。充值目标是从
// `useQuotaStore` 推导的,把 store 也 mock 掉就等于把被测的推导逻辑替换成常量。
//
// 🚨 **mock 的形状来自 `src/types/authApi.ts`,不是来自实现怎么读的。**
// 上游在这上面栽过一次:查单的后端响应实际多包一层 `data.order`,而测试用了扁平 mock,
// 于是「漏剥一层」的实现和「同样漏剥一层」的测试一起全绿,直到拿后端源码对账才露出来
// (计划 §1.3)。这一层的真源是 `authApi.ts`:主进程的 `fetchRechargeOrder` 已经把那层剥掉,
// 交到渲染层的就是扁平的 `RechargeOrder` —— 所以这里用扁平 mock 是**对的**,理由是类型契约,
// 不是「实现是这么读的」。
//
// 最值得钉住的几条:
// - `CREDITED` 才是成功,`PAID` 不是(支付宝收了钱、入账影子账户失败时停在 PAID);
// - 三种充值目标字段互斥,尤其 personal **不能夹带 projectId**(会撞进 fail-closed 403);
// - 自定义金额是 `parseFloat` 的直接来源 → NaN,而 `NaN <= 0` 是 false;
// - 关闭弹窗必须停轮询(interval 活在 window 上,组件没了它还在打接口)。

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_RECHARGE_CNY,
  type RechargeOrder,
  type RechargeOrderCreated,
} from '../../../../../types/authApi'
import { useQuotaStore, __resetQuotaStoreForTesting } from '../../../stores/useQuotaStore'
import { RechargeModal } from '../RechargeModal'

const PAY_URL = 'https://openapi.alipay.com/gateway.do?out_trade_no=RC-1&sign=one-time-1'
const PAY_URL_2 = 'https://openapi.alipay.com/gateway.do?out_trade_no=RC-2&sign=one-time-2'

/** 形状照 `RechargeOrderCreated`:`data` 直接就是订单,外加一个 `payUrl`。 */
function created(over: Partial<RechargeOrderCreated> = {}): RechargeOrderCreated {
  return {
    outTradeNo: 'RC-1',
    status: 'PENDING',
    totalAmount: '10.00',
    creditError: null,
    payUrl: PAY_URL,
    ...over,
  }
}

/** 形状照 `RechargeOrder` —— 主进程已经剥掉后端的 `data.order` 那层。 */
function order(over: Partial<RechargeOrder> = {}): RechargeOrder {
  return { outTradeNo: 'RC-1', status: 'PENDING', totalAmount: '10.00', creditError: null, ...over }
}

const auth = {
  createRechargeOrder: vi.fn(),
  getRechargeOrder: vi.fn(),
  getBalance: vi.fn(),
  getOrganizations: vi.fn(),
  getPaymentConfig: vi.fn(),
}
const shell = { openExternal: vi.fn() }
const onClose = vi.fn()

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', { value: { auth, shell }, configurable: true })
  Object.values(auth).forEach((m) => m.mockReset())
  shell.openExternal.mockReset().mockResolvedValue({ success: true })
  onClose.mockReset()

  auth.createRechargeOrder.mockResolvedValue({ ok: true, data: created() })
  auth.getRechargeOrder.mockResolvedValue({ ok: true, data: order() })
  auth.getBalance.mockResolvedValue({ ok: true, data: { balanceYuan: 10.26, balanceQuota: 5_130_000 } })

  localStorage.clear()
  __resetQuotaStoreForTesting()
  useQuotaStore.setState(useQuotaStore.getInitialState(), true)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  __resetQuotaStoreForTesting()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  localStorage.clear()
})

/** 个人计费落点:`projectId === personalBillingProjectId` 且没有 producerProjectId。 */
function pickPersonalPool(): void {
  useQuotaStore.setState({
    selectedPool: { projectId: 342, producerProjectId: null },
    personalBillingProjectId: 342,
  })
}

/** 普通 project 池:不是个人落点、也没有 producerProjectId。 */
function pickProjectPool(): void {
  useQuotaStore.setState({
    selectedPool: { projectId: 700, producerProjectId: null },
    personalBillingProjectId: 342,
    organizations: [{ id: 700, name: 'Seedance', studioName: 'S', balanceYuan: 12, joined: true }],
  })
}

/** producer 池:两半都在。故意让两半是不同的数,取错字段就会被断言抓住。 */
function pickProducerPool(): void {
  useQuotaStore.setState({
    selectedPool: { projectId: 700, producerProjectId: 5 },
    personalBillingProjectId: 342,
    organizations: [
      { id: 700, name: 'Seedance', studioName: 'S', balanceYuan: 12, joined: true, producerProjectId: 5 },
    ],
  })
}

function openModal() {
  return render(<RechargeModal open onClose={onClose} />)
}

async function clickPay(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('recharge-submit'))
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function statusText(): string {
  return screen.getByTestId('recharge-status').textContent ?? ''
}

describe('RechargeModal', () => {
  it('open=false 时什么都不渲染', () => {
    pickPersonalPool()
    render(<RechargeModal open={false} onClose={onClose} />)
    expect(screen.queryByTestId('recharge-modal')).toBeNull()
  })

  // 聊天面板的 <aside> 带 backdrop-blur 自成 stacking context,留在页面组件里的浮层
  // 无论 z 多大都被钳在 40000 层(PetOverlay.tsx:403-408);且各 tab 容器靠 display:none
  // 切换、不 unmount(main.tsx:153-156)。所以必须 portal 到 body。
  it('portal 到 document.body,z 取 50000 且不越过登录覆盖层的 75000', () => {
    pickPersonalPool()
    const { container } = openModal()

    expect(container.innerHTML).toBe('')
    const overlay = screen.getByTestId('recharge-modal')
    expect(overlay.parentElement).toBe(document.body)

    const z = Number(/z-\[(\d+)\]/.exec(overlay.className)?.[1])
    expect(z).toBe(50000)
    expect(z).toBeLessThan(75000)
  })

  // 用量/建单都要项目上下文,没选池发过去只会拿一个看不懂的 400/403。
  it('未选池时不能发起充值', async () => {
    openModal()
    expect((screen.getByTestId('recharge-submit') as HTMLButtonElement).disabled).toBe(true)
    await clickPay()
    expect(auth.createRechargeOrder).not.toHaveBeenCalled()
    expect(screen.getByTestId('recharge-hint').textContent).toMatch(/计费池/)
  })

  describe('充值目标三选一', () => {
    // personal 夹带 projectId 会走进后端的成员校验分支,而个人落点刻意不在组织列表里
    // → 查不到 joined → fail-closed 403,整条充值路径不可用。用 toEqual 精确钉住:
    // 多一个字段就红。
    it('个人计费池只发 { kind: "personal" },绝不夹带 projectId', async () => {
      pickPersonalPool()
      openModal()
      await clickPay()

      expect(auth.createRechargeOrder).toHaveBeenCalledTimes(1)
      expect(auth.createRechargeOrder.mock.calls[0][0]).toBe(10)
      expect(auth.createRechargeOrder.mock.calls[0][1]).toEqual({ kind: 'personal' })
    })

    it('普通 project 池发 { kind: "project", projectId }', async () => {
      pickProjectPool()
      openModal()
      await clickPay()

      expect(auth.createRechargeOrder.mock.calls[0][1]).toEqual({ kind: 'project', projectId: 700 })
    })

    // producerId 取的是 pool.projectId(后端的命名),不是 producerProjectId ——
    // 两半故意不同值,取错字段立刻红。
    it('producer 池成对发 producerId + producerProjectId,且 producerId = pool.projectId', async () => {
      pickProducerPool()
      openModal()
      await clickPay()

      expect(auth.createRechargeOrder.mock.calls[0][1]).toEqual({
        kind: 'producer',
        producerId: 700,
        producerProjectId: 5,
      })
    })
  })

  describe('金额校验', () => {
    it('预设金额可切换,发出去的是选中的那个', async () => {
      pickPersonalPool()
      openModal()
      fireEvent.click(screen.getByTestId('recharge-preset-50'))
      await clickPay()

      expect(auth.createRechargeOrder.mock.calls[0][0]).toBe(50)
    })

    it('自定义金额覆盖预设', async () => {
      pickPersonalPool()
      openModal()
      fireEvent.change(screen.getByTestId('recharge-custom'), { target: { value: '128.5' } })
      await clickPay()

      expect(auth.createRechargeOrder.mock.calls[0][0]).toBe(128.5)
    })

    // 自定义输入是 parseFloat 的直接来源 → NaN。**`NaN <= 0` 是 false**,
    // 所以校验必须写 `!(amount > 0)`;写成 `amount <= 0` 会把 NaN 一路放行,
    // 发出去一个 amountCny: NaN。
    it('非数字输入(NaN)不发请求', async () => {
      pickPersonalPool()
      openModal()
      fireEvent.change(screen.getByTestId('recharge-custom'), { target: { value: 'abc' } })

      expect((screen.getByTestId('recharge-submit') as HTMLButtonElement).disabled).toBe(true)
      await clickPay()
      expect(auth.createRechargeOrder).not.toHaveBeenCalled()
    })

    it.each(['0', '-5'])('金额 %s 不发请求', async (v) => {
      pickPersonalPool()
      openModal()
      fireEvent.change(screen.getByTestId('recharge-custom'), { target: { value: v } })
      await clickPay()

      expect(auth.createRechargeOrder).not.toHaveBeenCalled()
    })

    it('恰好等于上限可以提交,上限 +1 被拦下', async () => {
      pickPersonalPool()
      openModal()

      fireEvent.change(screen.getByTestId('recharge-custom'), {
        target: { value: String(MAX_RECHARGE_CNY) },
      })
      await clickPay()
      expect(auth.createRechargeOrder).toHaveBeenCalledTimes(1)
      expect(auth.createRechargeOrder.mock.calls[0][0]).toBe(MAX_RECHARGE_CNY)
    })

    it('超过上限时不发请求,并在提示里给出上限数字', async () => {
      pickPersonalPool()
      openModal()
      fireEvent.change(screen.getByTestId('recharge-custom'), {
        target: { value: String(MAX_RECHARGE_CNY + 1) },
      })
      await clickPay()

      expect(auth.createRechargeOrder).not.toHaveBeenCalled()
      expect(screen.getByTestId('recharge-hint').textContent).toContain(String(MAX_RECHARGE_CNY))
    })

    // 上限必须 import `MAX_RECHARGE_CNY` 而不是写死 4000:主进程与渲染层共吃一份,
    // 两边各写一个字面量必然漂移(理由写在常量的注释里)。这条把常量替换掉再验行为 ——
    // 组件若写死 4000,被降到 50 的上限就拦不住 51。
    it('上限吃 types 里的常量,不是组件里写死的数字', async () => {
      vi.resetModules()
      vi.doMock('../../../../../types/authApi', async () => {
        const actual =
          await vi.importActual<Record<string, unknown>>('../../../../../types/authApi')
        return { ...actual, MAX_RECHARGE_CNY: 50 }
      })
      try {
        const [{ RechargeModal: Patched }, { useQuotaStore: patchedStore }] = await Promise.all([
          import('../RechargeModal'),
          import('../../../stores/useQuotaStore'),
        ])
        patchedStore.setState({
          selectedPool: { projectId: 342, producerProjectId: null },
          personalBillingProjectId: 342,
        })
        render(<Patched open onClose={onClose} />)
        fireEvent.change(screen.getByTestId('recharge-custom'), { target: { value: '51' } })
        await clickPay()

        expect(auth.createRechargeOrder).not.toHaveBeenCalled()
      } finally {
        vi.doUnmock('../../../../../types/authApi')
        vi.resetModules()
      }
    })
  })

  describe('三步流程', () => {
    // will-navigate 只允许同源与 file:,应用内跳转会被静默拦下 ——
    // 表现是「点了支付什么都没发生」。
    it('建单成功后把 payUrl 交给系统浏览器', async () => {
      pickPersonalPool()
      openModal()
      await clickPay()

      expect(shell.openExternal).toHaveBeenCalledTimes(1)
      expect(shell.openExternal.mock.calls[0][0]).toBe(PAY_URL)
      expect(statusText()).toMatch(/等待|支付/)
    })

    it('建单后每 3 秒查一次单', async () => {
      vi.useFakeTimers()
      pickPersonalPool()
      openModal()
      await clickPay()

      expect(auth.getRechargeOrder).not.toHaveBeenCalled()
      await advance(3000)
      expect(auth.getRechargeOrder).toHaveBeenCalledTimes(1)
      expect(auth.getRechargeOrder).toHaveBeenLastCalledWith('RC-1')
      await advance(3000)
      expect(auth.getRechargeOrder).toHaveBeenCalledTimes(2)
    })

    it('CREDITED 才算成功,并刷新余额', async () => {
      vi.useFakeTimers()
      pickPersonalPool()
      openModal()
      await clickPay()

      auth.getRechargeOrder.mockResolvedValue({ ok: true, data: order({ status: 'CREDITED' }) })
      await advance(3000)

      expect(statusText()).toMatch(/成功/)
      // 不刷新的话用户充完钱看到的还是旧余额,会以为钱没到。
      expect(auth.getBalance).toHaveBeenCalledTimes(1)

      // 终态之后不该继续轮询。
      const calls = auth.getRechargeOrder.mock.calls.length
      await advance(9000)
      expect(auth.getRechargeOrder.mock.calls.length).toBe(calls)
    })

    // 🚨 支付宝收到钱、但入账影子账户失败时状态停在 PAID(creditError 非空)。
    // 报成功 = 告诉用户余额已到账而实际没到。
    it('PAID + creditError 显示入账中、继续轮询,绝不报成功', async () => {
      vi.useFakeTimers()
      pickPersonalPool()
      openModal()
      await clickPay()

      auth.getRechargeOrder.mockResolvedValue({
        ok: true,
        data: order({ status: 'PAID', creditError: 'shadow account credit failed' }),
      })
      await advance(3000)

      expect(statusText()).toMatch(/入账/)
      expect(statusText()).not.toMatch(/成功/)
      expect(auth.getBalance).not.toHaveBeenCalled()

      await advance(3000)
      expect(auth.getRechargeOrder).toHaveBeenCalledTimes(2)
    })

    it('PAID 但 creditError 为空也不算成功', async () => {
      vi.useFakeTimers()
      pickPersonalPool()
      openModal()
      await clickPay()

      auth.getRechargeOrder.mockResolvedValue({ ok: true, data: order({ status: 'PAID' }) })
      await advance(3000)

      expect(statusText()).not.toMatch(/成功/)
      expect(auth.getBalance).not.toHaveBeenCalled()
    })

    it('CLOSED 时停轮询并给出重新发起的出口', async () => {
      vi.useFakeTimers()
      pickPersonalPool()
      openModal()
      await clickPay()

      auth.getRechargeOrder.mockResolvedValue({ ok: true, data: order({ status: 'CLOSED' }) })
      await advance(3000)

      expect(statusText()).toMatch(/关闭|未完成/)
      expect(screen.getByTestId('recharge-retry')).toBeTruthy()

      await advance(9000)
      expect(auth.getRechargeOrder).toHaveBeenCalledTimes(1)
    })

    it('5 分钟未到账则超时收尾,不再轮询', async () => {
      vi.useFakeTimers()
      pickPersonalPool()
      openModal()
      await clickPay()

      await advance(5 * 60 * 1000)
      expect(statusText()).toMatch(/未确认|超时/)
      const calls = auth.getRechargeOrder.mock.calls.length
      expect(calls).toBe(100)

      await advance(30_000)
      expect(auth.getRechargeOrder.mock.calls.length).toBe(calls)
    })

    // payUrl 是支付宝现签的一次性链接(带 timeout_express,默认 10m)。
    // 重试必须重新建单,复用旧链接点开是支付宝的报错页。
    it('重试重新建单并打开新的 payUrl', async () => {
      pickPersonalPool()
      auth.createRechargeOrder
        .mockResolvedValueOnce({
          ok: false,
          error: { code: 'ALIPAY_GATEWAY_ERROR', message: '支付宝网关超时' },
        })
        .mockResolvedValueOnce({
          ok: true,
          data: created({ outTradeNo: 'RC-2', payUrl: PAY_URL_2 }),
        })

      openModal()
      await clickPay()
      expect(shell.openExternal).not.toHaveBeenCalled()

      await act(async () => {
        fireEvent.click(screen.getByTestId('recharge-retry'))
      })

      expect(auth.createRechargeOrder).toHaveBeenCalledTimes(2)
      expect(shell.openExternal).toHaveBeenCalledTimes(1)
      expect(shell.openExternal.mock.calls[0][0]).toBe(PAY_URL_2)
    })
  })

  describe('轮询生命周期', () => {
    // interval 活在 window 上:不清就会在弹窗关掉之后继续打接口,
    // 并把 setState 打到已经卸载的树上。
    it('关闭弹窗后不再查单', async () => {
      vi.useFakeTimers()
      pickPersonalPool()
      const { rerender } = openModal()
      await clickPay()
      await advance(3000)
      expect(auth.getRechargeOrder).toHaveBeenCalledTimes(1)

      rerender(<RechargeModal open={false} onClose={onClose} />)
      await advance(30_000)

      expect(auth.getRechargeOrder).toHaveBeenCalledTimes(1)
    })

    it('卸载后不再查单', async () => {
      vi.useFakeTimers()
      pickPersonalPool()
      const { unmount } = openModal()
      await clickPay()
      await advance(3000)

      unmount()
      await advance(30_000)

      expect(auth.getRechargeOrder).toHaveBeenCalledTimes(1)
    })

    // 关闭即遗忘:重开时残留的「等待付款」会指向一张已经过期的 payUrl。
    it('重新打开后回到初始态,不复用上一单', async () => {
      vi.useFakeTimers()
      pickPersonalPool()
      const { rerender } = openModal()
      await clickPay()
      await advance(3000)

      rerender(<RechargeModal open={false} onClose={onClose} />)
      rerender(<RechargeModal open onClose={onClose} />)
      await advance(9000)

      // 回到 idle:状态区整块消失(不是显示一个残留的「等待付款」)。
      expect(screen.queryByTestId('recharge-status')).toBeNull()
      expect(auth.getRechargeOrder).toHaveBeenCalledTimes(1)
    })
  })

  describe('错误呈现', () => {
    // 后端这个 403 的真实含义是「你不是该项目的已加入成员」(fail-closed 成员校验),
    // 笼统报「无权限」会让用户对着同一个池反复重试。
    it('FORBIDDEN 引导换池/加入,而不是笼统报错', async () => {
      pickProjectPool()
      auth.createRechargeOrder.mockResolvedValue({
        ok: false,
        error: { code: 'FORBIDDEN', message: '无权访问该项目' },
      })
      openModal()
      await clickPay()

      const text = screen.getByTestId('recharge-error').textContent ?? ''
      expect(text).toContain('无权访问该项目')
      expect(text).toMatch(/加入|切换/)
      expect(shell.openExternal).not.toHaveBeenCalled()
    })

    it('NOT_AUTHENTICATED 引导重新登录', async () => {
      pickPersonalPool()
      auth.createRechargeOrder.mockResolvedValue({
        ok: false,
        error: { code: 'NOT_AUTHENTICATED', message: '登录已失效' },
      })
      openModal()
      await clickPay()

      expect(screen.getByTestId('recharge-error').textContent ?? '').toMatch(/登录/)
    })

    // 单次查单失败(断网抖一下)不能判死:钱可能已经在路上,报失败会诱使用户重复付款。
    it('查单单次失败继续轮询,不当成失败', async () => {
      vi.useFakeTimers()
      pickPersonalPool()
      openModal()
      await clickPay()

      auth.getRechargeOrder.mockResolvedValueOnce({
        ok: false,
        error: { code: 'UPSTREAM_FAILED', message: '网络抖动' },
      })
      await advance(3000)
      expect(screen.queryByTestId('recharge-error')).toBeNull()

      auth.getRechargeOrder.mockResolvedValue({ ok: true, data: order({ status: 'CREDITED' }) })
      await advance(3000)
      expect(statusText()).toMatch(/成功/)
    })
  })

  it('点关闭按钮把关闭交给父组件', () => {
    pickPersonalPool()
    openModal()
    fireEvent.click(screen.getByTestId('recharge-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('渲染出的 DOM 里不含 token 之类的机密字段', async () => {
    pickPersonalPool()
    openModal()
    await clickPay()
    expect(document.body.innerHTML).not.toMatch(/token|jwt|sk-/i)
  })
})

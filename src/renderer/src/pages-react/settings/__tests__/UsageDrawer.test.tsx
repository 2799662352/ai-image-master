// 设置页 · 使用明细抽屉。
//
// 按 `AccountSection.test.tsx` 的范式伪造 preload 桥
// (`Object.defineProperty(window, 'electronAPI', …)`),不 mock hook —— 值全在
// 「数据层与 UI 接线对不对」,把 hook 也 mock 掉就只剩渲染快照了。
//
// 这里钉住的几条,每条都对应一个「看起来正常但是错的」失效模式:
// - 不 portal 到 body → 塞在设置页里,被聊天面板的 stacking context 钳住 / 跟着
//   `display:none` 的 tab 容器一起消失,表现是「点了没反应」;
// - 汇总标题写成「总费用」→ 那个数不含退款,叫总费用是错的口径;
// - 错误态复用空态文案 → 用户区分不了「真没花钱」和「接口挂了」;
// - producer 池不给说明条 → 用户以为看到的是这个池的账,其实是整个 project 的。

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  QuotaRpc,
  UsageLogPage,
  UsageLogRow,
  UsageModelSummary,
} from '../../../../../types/authApi'
import type { Pool } from '../../../stores/useQuotaStore'
import { UsageDrawer } from '../UsageDrawer'

const POOL: Pool = { projectId: 342, producerProjectId: null }
const PRODUCER_POOL: Pool = { projectId: 700, producerProjectId: 5 }

const ROW_CONSUME: UsageLogRow = {
  id: 9001,
  createdAt: 1_700_000_000,
  type: 2,
  modelName: 'gemini-3.1-flash-image-preview',
  quota: 25_000,
  promptTokens: 1200,
  completionTokens: 340,
  feature: 'image_gen',
  tokenName: 'desktop',
  projectId: 342,
  producerProjectId: null,
  content: '图片 generate',
  settleStatus: 0,
  preConsumedQuota: null,
}

/** 退款:`quota` 为负,`modelName` 是空串(明细里它是 `string`,不是 `string | null`)。 */
const ROW_REFUND: UsageLogRow = {
  id: 9002,
  createdAt: 1_700_000_600,
  type: 6,
  modelName: '',
  quota: -20_000,
  promptTokens: 0,
  completionTokens: 0,
  feature: null,
  tokenName: null,
  projectId: 342,
  producerProjectId: null,
  content: '视频任务失败退款 task_a1b2',
  settleStatus: 0,
  preConsumedQuota: null,
}

const SUMMARY: UsageModelSummary[] = [
  { modelName: 'gemini-3.1-flash-image-preview', totalQuota: 25_000, totalRequests: 3, totalTokens: 1540 },
  { modelName: null, totalQuota: 5_000, totalRequests: 1, totalTokens: 120 },
]

function logPage(rows: UsageLogRow[], over: Partial<Omit<UsageLogPage, 'rows'>> = {}): UsageLogPage {
  return { rows, total: rows.length, page: 0, pageSize: 50, ...over }
}

function ok<T>(data: T): QuotaRpc<T> {
  return { ok: true, data }
}

function fail(code: string, message: string): QuotaRpc<never> {
  return { ok: false, error: { code, message } }
}

const auth = {
  getUsageLogs: vi.fn(),
  getUsageSummary: vi.fn(),
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', { value: { auth }, configurable: true })
  auth.getUsageLogs.mockReset().mockResolvedValue(ok(logPage([ROW_CONSUME, ROW_REFUND], { total: 2 })))
  auth.getUsageSummary.mockReset().mockResolvedValue(ok(SUMMARY))
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

async function open(pool: Pool | null = POOL, onClose = vi.fn()) {
  const utils = render(<UsageDrawer open pool={pool} onClose={onClose} />)
  if (pool) await waitFor(() => expect(auth.getUsageLogs).toHaveBeenCalled())
  return { ...utils, onClose }
}

describe('UsageDrawer', () => {
  it('open=false 时什么都不渲染,也不发请求', async () => {
    render(<UsageDrawer open={false} pool={POOL} onClose={vi.fn()} />)
    expect(screen.queryByTestId('usage-drawer-root')).toBeNull()
    expect(auth.getUsageLogs).not.toHaveBeenCalled()
  })

  /**
   * 必须 portal 到 `document.body`。两个独立理由:
   * ① 聊天面板 `<aside>` 带 `backdrop-blur`,自成 stacking context —— 在它内部的元素
   *    无论 z 多大都被钳在 40000 层(见 `PetOverlay.tsx:403-408`);
   * ② 各 tab 容器靠 `display:none` 切换而不 unmount(`main.tsx:153-156`),塞进页面
   *    组件里会跟着一起隐藏。
   * 两种情况的表现都是「点了使用明细什么都没发生」。
   */
  it('portal 到 document.body,不留在调用方的容器里', async () => {
    const { container } = await open()
    expect(container.querySelector('[data-testid="usage-drawer-root"]')).toBeNull()
    const root = screen.getByTestId('usage-drawer-root')
    expect(document.body.contains(root)).toBe(true)
  })

  /**
   * z 取 50000(与既有 modal 同带:`index.html` 的 settingsModal / `Lightbox.tsx:80`)。
   * **绝不 ≥ 75000** —— 那是全屏登录覆盖层(`DesktopLoginPage.tsx:139`),盖住它会让
   * 「未登录」这件事被一个查不到数据的抽屉挡住。
   */
  it('z-index 落在 modal 带里,不侵占登录覆盖层的 75000', async () => {
    await open()
    const root = screen.getByTestId('usage-drawer-root')
    expect(root.className).toContain('z-[50000]')

    const z = Number(/z-\[(\d+)\]/.exec(root.className)?.[1])
    expect(z).toBeLessThan(75000)
  })

  it('没选池时给提示而不是空列表,也不发请求', async () => {
    await open(null)
    expect(screen.getByTestId('usage-no-pool')).toBeTruthy()
    expect(auth.getUsageLogs).not.toHaveBeenCalled()
  })

  /**
   * 汇总口径。
   *
   * 汇总 SQL 带 `WHERE type = LogTypeConsume`,明细的 where **没有** type 过滤 ——
   * 一条退款会出现在列表里、却不进这个数。叫「总费用」是错的口径。
   */
  it('汇总标题写「消费合计（不含退款）」,不写「总费用」', async () => {
    await open()
    await waitFor(() => expect(screen.getByTestId('usage-summary-quota')).toBeTruthy())

    expect(screen.getByText('消费合计（不含退款）')).toBeTruthy()
    expect(screen.queryByText('总费用')).toBeNull()
  })

  it('汇总三个数字是分组数组 reduce 出来的', async () => {
    await open()
    await waitFor(() => expect(screen.getByTestId('usage-summary-quota').textContent).toContain('0.0600'))

    expect(screen.getByTestId('usage-summary-requests').textContent).toContain('4')
    expect(screen.getByTestId('usage-summary-tokens').textContent).toContain('1,660')
  })

  /**
   * producer 池的说明条。
   *
   * 用量端点只收 `projectId`、不收 `producerProjectId`(`UsageQuery` 的注释),
   * 而池键是两半 —— 选中 producer 池时查出来的是该 project 下**全部**子项目的流水。
   * 客户端过滤救不了汇总(服务端预聚合),只能在 UI 上明说。
   */
  it('producer 池时给出「含全部子项目」的说明条', async () => {
    await open(PRODUCER_POOL)
    const notice = screen.getByTestId('usage-producer-notice')
    expect(notice.textContent).toContain('子项目')
  })

  it('普通 project 池不显示那条说明', async () => {
    await open(POOL)
    expect(screen.queryByTestId('usage-producer-notice')).toBeNull()
  })

  it('退款行有醒目标记', async () => {
    await open()
    await waitFor(() => expect(screen.getAllByTestId('usage-log-row').length).toBe(2))
    expect(screen.getAllByTestId('usage-refund-badge').length).toBe(1)
  })

  /**
   * 退款金额加 `+` 前缀。
   *
   * `quota` 为负,直接把负号跟 `+` 拼在一起会得到 `+¥-0.0400` —— 网页端
   * (`UsageDrawer.tsx:381`)就是这么渲染的。量级两端一致(0.0400),符号只保留一个。
   */
  it('退款金额显示 +¥0.0400,不是 +¥-0.0400', async () => {
    await open()
    await waitFor(() => expect(screen.getAllByTestId('usage-log-row').length).toBe(2))

    const refundRow = screen.getAllByTestId('usage-log-row')[1]
    const amount = within(refundRow).getByTestId('usage-log-amount')
    expect(amount.textContent).toBe('+¥0.0400')
  })

  it('消费金额不加符号前缀', async () => {
    await open()
    await waitFor(() => expect(screen.getAllByTestId('usage-log-row').length).toBe(2))

    const row = screen.getAllByTestId('usage-log-row')[0]
    expect(within(row).getByTestId('usage-log-amount').textContent).toBe('¥0.0500')
  })

  /**
   * 退款行的 modelName 是空串,唯一能说清「退的是哪笔」的字段是 content。
   * 主文案取它,而不是「未标注模型」—— 那句话对一笔退款是误导。
   */
  it('退款行主文案取 content,说清退的是哪笔', async () => {
    await open()
    await waitFor(() => expect(screen.getAllByTestId('usage-log-row').length).toBe(2))

    const refundRow = screen.getAllByTestId('usage-log-row')[1]
    expect(within(refundRow).getByTestId('usage-log-model').textContent).toBe('视频任务失败退款 task_a1b2')
    expect(refundRow.textContent).not.toContain('未标注模型')
  })

  it('退款行连 content 都没有时落到「退款」,不显示「未标注模型」', async () => {
    auth.getUsageLogs.mockResolvedValue(ok(logPage([{ ...ROW_REFUND, content: '' }], { total: 1 })))
    await open()
    await waitFor(() => expect(screen.getAllByTestId('usage-log-row').length).toBe(1))
    expect(within(screen.getAllByTestId('usage-log-row')[0]).getByTestId('usage-log-model').textContent).toBe('退款')
  })

  /**
   * 网关对异步任务(视频/高清)的退款不是另一行 type=6,而是把原消费行改成 cancelled、
   * quota 归 0。只认 type=6 的话,一次失败的视频在明细里就是一行 ¥0 的「消费」——
   * 用户看不出钱退回来了。
   */
  describe('settle_status(异步任务的原地结算)', () => {
    const ROW_CANCELLED: UsageLogRow = {
      ...ROW_CONSUME,
      id: 9003,
      modelName: 'doubao-seedance-2-5-260628',
      quota: 0,
      settleStatus: 2,
      preConsumedQuota: 2_704_100,
      content: '视频 textGenerate, 生成时长seconds: 5.00',
    }
    const ROW_PENDING: UsageLogRow = {
      ...ROW_CONSUME,
      id: 9004,
      modelName: 'wan3.0-video',
      quota: 2_000_000,
      settleStatus: 1,
    }

    it('cancelled 的消费行按退款渲染:「已退款」标记 + 退回的预扣额,而不是 ¥0', async () => {
      auth.getUsageLogs.mockResolvedValue(ok(logPage([ROW_CANCELLED], { total: 1 })))
      await open()
      await waitFor(() => expect(screen.getAllByTestId('usage-log-row').length).toBe(1))

      const row = screen.getAllByTestId('usage-log-row')[0]
      expect(within(row).getByTestId('usage-refund-badge').textContent).toBe('已退款')
      expect(within(row).getByTestId('usage-log-amount').textContent).toBe('+¥5.4082')
      // 模型名保留 —— 用户要知道退的是哪个模型那笔。
      expect(within(row).getByTestId('usage-log-model').textContent).toBe('doubao-seedance-2-5-260628')
      expect(row.textContent).not.toContain('¥0.0000')
    })

    it('cancelled 但没挖到预扣额时显示 ¥0,不编数字', async () => {
      auth.getUsageLogs.mockResolvedValue(ok(logPage([{ ...ROW_CANCELLED, preConsumedQuota: null }], { total: 1 })))
      await open()
      await waitFor(() => expect(screen.getAllByTestId('usage-log-row').length).toBe(1))
      const row = screen.getAllByTestId('usage-log-row')[0]
      expect(within(row).getByTestId('usage-log-amount').textContent).toBe('¥0')
      expect(within(row).getByTestId('usage-refund-badge')).toBeTruthy()
    })

    it('cancelled 行计入「本页 N 笔退款」', async () => {
      auth.getUsageLogs.mockResolvedValue(ok(logPage([ROW_CONSUME, ROW_REFUND, ROW_CANCELLED], { total: 3 })))
      await open()
      await waitFor(() => expect(screen.getAllByTestId('usage-log-row').length).toBe(3))
      // 0.0400(type=6) + 5.4082(cancelled 预扣) = 5.4482
      expect(screen.getByTestId('usage-page-refunds').textContent).toBe('本页 2 笔退款 +¥5.4482')
    })

    it('pending 行标「结算中」,金额照常显示', async () => {
      auth.getUsageLogs.mockResolvedValue(ok(logPage([ROW_PENDING], { total: 1 })))
      await open()
      await waitFor(() => expect(screen.getAllByTestId('usage-log-row').length).toBe(1))
      const row = screen.getAllByTestId('usage-log-row')[0]
      expect(within(row).getByTestId('usage-pending-badge').textContent).toBe('结算中')
      expect(within(row).getByTestId('usage-log-amount').textContent).toBe('¥4.0000')
      expect(within(row).queryByTestId('usage-refund-badge')).toBeNull()
      expect(screen.queryByTestId('usage-page-refunds')).toBeNull()
    })

    it('settled 的普通消费行没有任何结算标记', async () => {
      await open()
      await waitFor(() => expect(screen.getAllByTestId('usage-log-row').length).toBe(2))
      const row = screen.getAllByTestId('usage-log-row')[0]
      expect(within(row).queryByTestId('usage-pending-badge')).toBeNull()
      expect(within(row).queryByTestId('usage-refund-badge')).toBeNull()
    })
  })

  /**
   * 记录区头部给本页退款一个绿色计数。标「本页」是刻意的:列表分页,这个数只对当前页
   * 成立;后端汇总端点不给退款合计,写成「N 笔退款」会被读成时间范围内的总数。
   */
  it('本页有退款时头部显示「本页 N 笔退款 +¥x」;没有就不显示', async () => {
    await open()
    await waitFor(() => expect(screen.getAllByTestId('usage-log-row').length).toBe(2))
    expect(screen.getByTestId('usage-page-refunds').textContent).toBe('本页 1 笔退款 +¥0.0400')

    cleanup()
    auth.getUsageLogs.mockResolvedValue(ok(logPage([ROW_CONSUME], { total: 1 })))
    await open()
    await waitFor(() => expect(screen.getAllByTestId('usage-log-row').length).toBe(1))
    expect(screen.queryByTestId('usage-page-refunds')).toBeNull()
  })

  describe('按模型汇总的折叠', () => {
    const many: UsageModelSummary[] = [
      { modelName: 'cheap-a', totalQuota: 5_000, totalRequests: 1, totalTokens: 10 },
      { modelName: 'big-1', totalQuota: 90_000, totalRequests: 9, totalTokens: 900 },
      { modelName: 'mid-2', totalQuota: 40_000, totalRequests: 4, totalTokens: 400 },
      { modelName: 'mid-3', totalQuota: 30_000, totalRequests: 3, totalTokens: 300 },
      { modelName: 'cheap-b', totalQuota: 6_000, totalRequests: 1, totalTokens: 20 },
      { modelName: 'mid-4', totalQuota: 20_000, totalRequests: 2, totalTokens: 200 },
      { modelName: 'mid-5', totalQuota: 10_000, totalRequests: 1, totalTokens: 100 },
    ]

    it('超过 5 个模型时只露花费最高的 5 个,其余折进「展开」并注明藏了多少钱', async () => {
      auth.getUsageSummary.mockResolvedValue(ok(many))
      await open()
      await waitFor(() => expect(screen.getAllByTestId('usage-summary-model').length).toBe(5))

      const names = screen.getAllByTestId('usage-summary-model').map((el) => el.textContent ?? '')
      // 按花费降序:大头在前,两个便宜的被折起来。
      expect(names[0]).toContain('big-1')
      expect(names.some((n) => n.includes('cheap-a'))).toBe(false)
      expect(names.some((n) => n.includes('cheap-b'))).toBe(false)

      const toggle = screen.getByTestId('usage-summary-toggle')
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(toggle.getAttribute('aria-controls')).toBe('usage-summary-models')
      expect(toggle.textContent).toContain('展开其余 2 个模型')
      // 折叠不能变成藏账:5_000 + 6_000 quota = ¥0.0220
      expect(toggle.textContent).toContain('合计 ¥0.0220')
    })

    it('点「展开」后全部露出、按钮变「收起」;再点收回', async () => {
      auth.getUsageSummary.mockResolvedValue(ok(many))
      await open()
      await waitFor(() => expect(screen.getAllByTestId('usage-summary-model').length).toBe(5))

      await act(async () => {
        screen.getByTestId('usage-summary-toggle').click()
      })
      expect(screen.getAllByTestId('usage-summary-model').length).toBe(7)
      const toggle = screen.getByTestId('usage-summary-toggle')
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(toggle.textContent).toContain('收起')
      expect(toggle.textContent).not.toContain('合计')

      await act(async () => {
        toggle.click()
      })
      expect(screen.getAllByTestId('usage-summary-model').length).toBe(5)
    })

    it('5 个以内不出现折叠按钮', async () => {
      auth.getUsageSummary.mockResolvedValue(ok(many.slice(0, 5)))
      await open()
      await waitFor(() => expect(screen.getAllByTestId('usage-summary-model').length).toBe(5))
      expect(screen.queryByTestId('usage-summary-toggle')).toBeNull()
    })
  })

  // `createdAt` 是 Unix **秒**。忘了乘 1000 的话所有记录都会显示成 1970-01-20。
  it('时间按秒解释,不按毫秒', async () => {
    await open()
    await waitFor(() => expect(screen.getAllByTestId('usage-log-row').length).toBe(2))

    const d = new Date(ROW_CONSUME.createdAt * 1000)
    const mmdd = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(screen.getAllByTestId('usage-log-row')[0].textContent).toContain(mmdd)
  })

  /**
   * 空态与错误态必须在 DOM 上可区分。
   *
   * 网页端两个请求各自 `.catch(() => null)`,失败后照样显示「暂无记录」——
   * 用户看不出是真没花钱还是接口挂了,于是会去反复刷新一个坏掉的东西。
   */
  it('真的没有记录时显示空态', async () => {
    auth.getUsageLogs.mockResolvedValue(ok(logPage([], { total: 0 })))
    await open()
    await waitFor(() => expect(screen.getByTestId('usage-logs-empty')).toBeTruthy())
    expect(screen.queryByTestId('usage-logs-error')).toBeNull()
  })

  it('明细查询失败时显示错误文案而不是空态', async () => {
    auth.getUsageLogs.mockResolvedValue(fail('HTTP_403', '无权访问该项目'))
    await open()
    await waitFor(() => expect(screen.getByTestId('usage-logs-error')).toBeTruthy())

    expect(screen.getByTestId('usage-logs-error').textContent).toContain('无权访问该项目')
    expect(screen.queryByTestId('usage-logs-empty')).toBeNull()
  })

  it('汇总失败、明细成功时,汇总位报错、列表照常出数', async () => {
    auth.getUsageSummary.mockResolvedValue(fail('NOT_AUTHENTICATED', '登录已过期,请重新登录'))
    await open()
    await waitFor(() => expect(screen.getByTestId('usage-summary-error')).toBeTruthy())

    expect(screen.getByTestId('usage-summary-error').textContent).toContain('登录已过期')
    expect(screen.getAllByTestId('usage-log-row').length).toBe(2)
    expect(screen.queryByTestId('usage-logs-error')).toBeNull()
  })

  /**
   * 页码的除数取**响应回来的** `pageSize`,不是本地那个 50。
   * 后端默认 20、上限 100,写死 50 会在这两种情况下把总页数算错。
   */
  it('总页数用响应里的 pageSize 算', async () => {
    auth.getUsageLogs.mockResolvedValue(ok(logPage([ROW_CONSUME], { total: 45, pageSize: 20 })))
    await open()
    await waitFor(() => expect(screen.getByTestId('usage-page-indicator')).toBeTruthy())

    // 0 基的 page 显示成 1 基。
    expect(screen.getByTestId('usage-page-indicator').textContent).toBe('1 / 3')
  })

  it('翻页把 0 基的 page 递给主进程', async () => {
    auth.getUsageLogs.mockResolvedValue(ok(logPage([ROW_CONSUME], { total: 120, pageSize: 50 })))
    await open()
    await waitFor(() => expect(screen.getByTestId('usage-next')).toBeTruthy())

    await act(async () => {
      screen.getByTestId('usage-next').click()
    })
    await waitFor(() => expect(auth.getUsageLogs).toHaveBeenCalledTimes(2))
    expect(auth.getUsageLogs.mock.calls[1][0].page).toBe(1)
  })

  it('切换时间范围会重查,并把 page 归零', async () => {
    auth.getUsageLogs.mockResolvedValue(ok(logPage([ROW_CONSUME], { total: 120, pageSize: 50 })))
    await open()
    await waitFor(() => expect(screen.getByTestId('usage-next')).toBeTruthy())

    await act(async () => {
      screen.getByTestId('usage-next').click()
    })
    await waitFor(() => expect(auth.getUsageLogs).toHaveBeenCalledTimes(2))

    await act(async () => {
      screen.getByTestId('usage-range-7d').click()
    })
    await waitFor(() => expect(auth.getUsageLogs).toHaveBeenCalledTimes(3))
    expect(auth.getUsageLogs.mock.calls[2][0].page).toBe(0)
  })

  it('点关闭按钮回调 onClose', async () => {
    const { onClose } = await open()
    await act(async () => {
      screen.getByTestId('usage-close').click()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('点遮罩也关闭', async () => {
    const { onClose } = await open()
    await act(async () => {
      screen.getByTestId('usage-backdrop').click()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // 明细里退款行的 modelName 是空串,直接渲染会得到一行「什么都没有」的记录。
  it('模型名为空的行给占位而不是留白', async () => {
    auth.getUsageLogs.mockResolvedValue(ok(logPage([ROW_REFUND], { total: 1 })))
    await open()
    await waitFor(() => expect(screen.getAllByTestId('usage-log-row').length).toBe(1))
    expect(within(screen.getAllByTestId('usage-log-row')[0]).getByTestId('usage-log-model').textContent).toBeTruthy()
  })

  it('样式走设置页的 cyberpunk token,不混 Codex 侧的 rounded/cyan', async () => {
    await open()
    const root = screen.getByTestId('usage-drawer-root')
    expect(root.innerHTML).toContain('border-zinc-700')
    // 直角是这套主题的一部分;圆角是 Codex 侧那套。
    expect(root.innerHTML).not.toMatch(/rounded-md|border-cyan-/)
  })
})

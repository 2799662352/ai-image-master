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

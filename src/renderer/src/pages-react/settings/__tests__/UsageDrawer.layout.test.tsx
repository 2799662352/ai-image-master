// 设置页 · 使用明细抽屉 · 展开「其余模型」之后的版面。
//
// 病根(2026-10-28 用户截图):汇总区是 `shrink-0`,展开后 N 个模型行全部摊开、不肯收缩;
// 下面的「调用记录」是 `min-h-0 flex-1`,于是被挤到 0 高,整块内容还溢出面板之外、
// 没有任何地方能滚 —— 账号用过的模型一多(截图里是 57 个)抽屉就彻底不能用了。
// 之前加的「前 5 条 + 展开」只管了折叠态,展开态没有上界。
//
// jsdom 不做布局,所以这里钉的是**版面契约**(类名 + 结构),真实的像素行为另用真浏览器量。
// 每条断言都对应一种「改回去就破版」的改法:
// - 展开后的列表没有自己的滚动区 / 没有上界 → 回到「无限长、把记录区挤没」;
// - 「收起」按钮放进了滚动区 → 列表一长按钮就滚出视野,收不回去;
// - 汇总区仍是 `shrink-0` → 空间不够时它不让,记录区被挤到 0;
// - 记录区没有高度下限 → 同上,只是换个说法;
// - 滚动区键盘够不着 → 只有鼠标用户能看完后面的模型。

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  QuotaRpc,
  UsageLogPage,
  UsageLogRow,
  UsageModelSummary,
} from '../../../../../types/authApi'
import type { Pool } from '../../../stores/useQuotaStore'
import { MODEL_SUMMARY_VISIBLE, UsageDrawer } from '../UsageDrawer'

const POOL: Pool = { projectId: 96, producerProjectId: 13 }

const ROW: UsageLogRow = {
  id: 1,
  createdAt: 1_700_000_000,
  type: 2,
  modelName: 'qwen3.8-max',
  quota: 25_000,
  promptTokens: 10,
  completionTokens: 5,
  feature: null,
  tokenName: null,
  projectId: 96,
  producerProjectId: 13,
  content: '',
  settleStatus: 0,
  preConsumedQuota: null,
}

/** 截图里是 62 个模型(5 个露出 + 「展开其余 57 个」)。 */
const MODEL_COUNT = 62

function manyModels(n: number): UsageModelSummary[] {
  return Array.from({ length: n }, (_, i) => ({
    modelName: `model-${String(i).padStart(2, '0')}`,
    totalQuota: (n - i) * 1_000,
    totalRequests: i + 1,
    totalTokens: 100 * (i + 1),
  }))
}

function ok<T>(data: T): QuotaRpc<T> {
  return { ok: true, data }
}

const auth = {
  getUsageLogs: vi.fn(),
  getUsageSummary: vi.fn(),
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', { value: { auth }, configurable: true })
  const page: UsageLogPage = { rows: [ROW], total: 1, page: 0, pageSize: 50 }
  auth.getUsageLogs.mockReset().mockResolvedValue(ok(page))
  auth.getUsageSummary.mockReset().mockResolvedValue(ok(manyModels(MODEL_COUNT)))
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

async function openDrawer() {
  render(<UsageDrawer open pool={POOL} onClose={vi.fn()} />)
  await waitFor(() =>
    expect(screen.getAllByTestId('usage-summary-model').length).toBe(MODEL_SUMMARY_VISIBLE),
  )
}

async function expand() {
  await act(async () => {
    screen.getByTestId('usage-summary-toggle').click()
  })
}

/** 被 `aria-controls` 指着的那个元素 —— 也就是「模型列表的滚动区」本身。 */
function modelList(): HTMLElement {
  const el = document.getElementById('usage-summary-models')
  if (!el) throw new Error('找不到 #usage-summary-models')
  return el
}

describe('UsageDrawer 展开「其余模型」后的版面', () => {
  it('展开后 62 条一条不少,且都装在自己的滚动区里', async () => {
    await openDrawer()
    await expand()

    const list = modelList()
    expect(within(list).getAllByTestId('usage-summary-model')).toHaveLength(MODEL_COUNT)
    expect(list.className).toContain('overflow-y-auto')
  })

  it('展开态有上界,且上界是「视口高度 − 其余固定部分」,封顶也跟着视口走', async () => {
    await openDrawer()
    await expand()

    // max-h-[clamp(下限rem, calc(100dvh - 其余固定部分rem), 封顶dvh)]:
    // - 用 dvh 不用 px:窗口高矮不同,写死像素在小窗口上等于没限;
    // - 中间项让列表在矮窗口里把空间让给下面的调用记录(真浏览器 700px 高时刚好放下);
    // - 下限 rem:窗口再矮也不会被压成一条缝(展开至少 6 行,下限不会比内容高)。
    const m = modelList().className.match(
      /max-h-\[clamp\((\d+(?:\.\d+)?)rem,calc\(100dvh_-_(\d+(?:\.\d+)?)rem\),(\d+)dvh\)\]/,
    )
    expect(m).not.toBeNull()
    const [, floorRem, chromeRem, capDvh] = m as RegExpMatchArray
    expect(Number(floorRem)).toBeGreaterThanOrEqual(6)
    // 其余固定部分(标题 + 口径提醒 + 区间按钮 + 汇总卡 + 切换按钮 + 记录区下限 12rem)实测约 30.6rem。
    expect(Number(chromeRem)).toBeGreaterThanOrEqual(30)
    expect(Number(capDvh)).toBeLessThanOrEqual(50)
  })

  it('不靠 flex 收缩来腾地方:列表没有 min-h-* 下限(收缩 + 子元素下限会让内容溢出去盖住记录区)', async () => {
    await openDrawer()
    await expand()

    expect(modelList().className).not.toMatch(/(^|\s)min-h-/)
  })

  it('折叠态不加上界 —— 5 行本来就放得下,不该凭空多出一块滚动区', async () => {
    await openDrawer()

    expect(modelList().className).not.toMatch(/max-h-/)
  })

  it('滚动区不把滚动链传给后面的页面(模态里滚到头不该带动背景)', async () => {
    await openDrawer()
    await expand()

    expect(modelList().className).toContain('overscroll-contain')
  })

  it('「收起」按钮在滚动区之外,列表再长也始终看得见、点得到', async () => {
    await openDrawer()
    await expand()

    const toggle = screen.getByTestId('usage-summary-toggle')
    expect(modelList().contains(toggle)).toBe(false)
    expect(toggle.getAttribute('aria-controls')).toBe('usage-summary-models')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('汇总区不参与 flex 收缩(shrink-0,没有 min-h-0)', async () => {
    await openDrawer()

    // 曾试过让汇总区 min-h-0 去收缩:520px 高的真浏览器里它被压得比子元素的下限还小,
    // 内容溢出汇总区、盖到下面的调用记录上(而抽屉自己的 scrollHeight 不报溢出,单看数字发现不了)。
    // 现在汇总区高度有界(列表有 max-h),自己不必收缩;放不下就由记录区下限 + 抽屉整体滚动兜底。
    const section = screen.getByTestId('usage-summary-section')
    expect(section.className).toContain('shrink-0')
    expect(section.className).not.toContain('min-h-0')
  })

  it('调用记录区有高度下限,空间再紧也不会被挤成 0', async () => {
    await openDrawer()
    await expand()

    const logs = screen.getByTestId('usage-logs-section')
    expect(logs.className).toMatch(/min-h-\[\d+(\.\d+)?rem\]/)
    expect(logs.className).not.toContain('min-h-0')
    // 记录本身没丢:展开模型之后,下面那一行照样在。
    expect(within(logs).getAllByTestId('usage-log-row')).toHaveLength(1)
  })

  it('展开后滚动区键盘可达、有名字(屏幕阅读器读得出是什么区域)', async () => {
    await openDrawer()
    await expand()

    const list = modelList()
    expect(list.getAttribute('tabindex')).toBe('0')
    expect(list.getAttribute('role')).toBe('region')
    expect(list.getAttribute('aria-label')).toBe('按模型汇总')
  })

  it('折叠态不多出一个没用的 Tab 停靠点', async () => {
    await openDrawer()

    const list = modelList()
    expect(list.hasAttribute('tabindex')).toBe(false)
    expect(list.hasAttribute('role')).toBe(false)
  })

  it('抽屉整体不会因为内容过长而溢出视口(兜底:实在放不下就整体滚)', async () => {
    await openDrawer()

    const aside = screen.getByTestId('usage-drawer-root').querySelector('aside')
    expect(aside).not.toBeNull()
    expect(aside?.className).toContain('overflow-y-auto')
  })
})

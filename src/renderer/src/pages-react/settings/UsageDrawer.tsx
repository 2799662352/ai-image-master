// 设置页 · 使用明细抽屉。
//
// 只吃 props(`open` / `pool` / `onClose`),**不自己读 `useQuotaStore`**:池由
// `AccountSection` 传进来,这样抽屉能脱开 store 单测,也不会因为「谁先初始化」而
// 在打开瞬间查一个还没恢复的池。
//
// 配色跟随所在页面,用设置页那套 token(bg-cyberpunk-yellow / border-2 /
// border-zinc-700 / 直角)。**不要**混进 Codex 侧那套 cyan + rounded-md,
// 也没有 `.miau-*` 类可用 —— 那是网页端的。

import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { UsageLogRow, UsageModelSummary } from '../../../../types/authApi'
import type { Pool } from '../../stores/useQuotaStore'
import {
  LOG_TYPE_REFUND,
  SETTLE_STATUS_CANCELLED,
  SETTLE_STATUS_PENDING,
  USAGE_RANGES,
  formatQuotaCny,
  formatUsageTime,
  useUsageData,
} from './useUsageData'

interface Props {
  open: boolean
  /** `null` = 还没选计费池。用量接口 `projectId` 必填才有意义,此时不发请求。 */
  pool: Pool | null
  onClose: () => void
}

/** 后端 `feature` 是内部代号,直接显示用户看不懂。认不出的原样透出,别吞。 */
const FEATURE_LABELS: Record<string, string> = {
  oiioii: 'Agent',
  workshop: '工坊',
  image_gen: '图片',
  video_gen: '视频',
}

/**
 * 「这一行代表一笔退回」有两种长相,必须一起认:
 *  - `type === 6`:独立的退款行(Midjourney、无 ConsumeLogId 的旧任务),`quota` 为负;
 *  - 消费行 `settleStatus === cancelled`:异步任务失败后,网关**原地**把那条消费日志
 *    改成 cancelled、`quota` 归 0,退回的金额只在 `preConsumedQuota` 里。
 * 只认第一种的话,视频任务的退款在明细里永远是一行 ¥0 的「消费」。
 */
function isRefundLike(row: UsageLogRow): boolean {
  return row.type === LOG_TYPE_REFUND || row.settleStatus === SETTLE_STATUS_CANCELLED
}

/** 退回的量级(正数 quota)。 */
function refundedQuota(row: UsageLogRow): number {
  if (row.type === LOG_TYPE_REFUND) return Math.abs(row.quota)
  if (row.settleStatus === SETTLE_STATUS_CANCELLED) return row.preConsumedQuota ?? 0
  return 0
}

function amountText(row: UsageLogRow): string {
  if (row.type === LOG_TYPE_REFUND) {
    // 退款的 `quota` 是负数。取量级再补 `+`,否则拼出来是 `+¥-0.0400` —— 网页端
    // (`UsageDrawer.tsx:381`)就是这么渲染的,一个自相矛盾的字符串。量级两端一致。
    return `+¥${formatQuotaCny(Math.abs(row.quota))}`
  }
  if (row.settleStatus === SETTLE_STATUS_CANCELLED) {
    // 实付已归 0;把退回的预扣额亮出来,不然这一行就是一个解释不了的 ¥0。
    const back = row.preConsumedQuota
    return back ? `+¥${formatQuotaCny(back)}` : '¥0'
  }
  return `¥${formatQuotaCny(row.quota)}`
}

/**
 * 按模型分组的汇总默认只露这么多条。
 *
 * 这块和下面的「调用记录」抢同一个抽屉高度,记录区是 `flex-1`,汇总每多一条模型它就
 * 少一行。一天用过十来个模型的用户,打开抽屉看到的是一整屏进度条、记录只剩一条缝。
 * 5 条覆盖绝大多数人的"大头"(按花费降序),其余折进「展开」—— 渐进披露,数据一条
 * 不少,只是别一上来全摊开。
 */
export const MODEL_SUMMARY_VISIBLE = 5

/** 花得多的排前面:折叠后露出来的必须是大头,否则折叠就是在藏重点。 */
function sortedByCost(summary: readonly UsageModelSummary[]): UsageModelSummary[] {
  return [...summary].sort((a, b) => b.totalQuota - a.totalQuota)
}

/** 本页退款汇总。**只对当前页成立** —— 列表是分页的,别把它当成时间范围内的总数。 */
function pageRefunds(rows: readonly UsageLogRow[]): { count: number; quota: number } {
  let count = 0
  let quota = 0
  for (const row of rows) {
    if (!isRefundLike(row)) continue
    count += 1
    quota += refundedQuota(row)
  }
  return { count, quota }
}

function SummaryCard({
  testId,
  label,
  value,
  sub,
  accent,
}: {
  testId: string
  label: string
  value: string
  sub?: string
  accent?: boolean
}) {
  return (
    <div data-testid={testId} className="bg-zinc-800 border-2 border-zinc-700 px-3 py-2.5">
      <div className="text-[11px] leading-tight text-zinc-400">{label}</div>
      <div
        className={`mt-1 text-lg font-bold leading-none tabular-nums ${
          accent ? 'text-cyberpunk-yellow' : 'text-white'
        }`}
      >
        {value}
      </div>
      <div className="mt-1 h-3 text-[10px] leading-3 text-zinc-500">{sub ?? ''}</div>
    </div>
  )
}

export function UsageDrawer({ open, pool, onClose }: Props) {
  // hook 必须无条件调用 —— 早退分支放在它后面。
  const usage = useUsageData({ open, pool })
  const [modelsExpanded, setModelsExpanded] = useState(false)

  if (!open) return null

  const models = sortedByCost(usage.summary)
  const hiddenModels = models.slice(MODEL_SUMMARY_VISIBLE)
  const visibleModels = modelsExpanded ? models : models.slice(0, MODEL_SUMMARY_VISIBLE)
  const hiddenQuota = hiddenModels.reduce((sum, s) => sum + Math.max(0, s.totalQuota), 0)
  const refunds = pageRefunds(usage.rows)

  /**
   * portal 到 `document.body`。两个独立理由,任一都足以让抽屉「点了没反应」:
   *
   * ① 聊天面板 `AgentChatPanel` 的 `<aside>` 带 `backdrop-blur`,**自成 stacking
   *    context** —— 在它内部的元素无论 z 多大都被钳在 40000 层(血泪注释见
   *    `features/agent-chat/pets/PetOverlay.tsx:403-408`);
   * ② 各 tab 容器靠 `display:none` 切换而**不 unmount**(`react-app/main.tsx:153-156`),
   *    塞进页面组件里会跟着一起隐藏。
   *
   * z 取 **50000**,与既有 modal 同带(`renderer/index.html` 的 settingsModal、
   * `features/agent-chat/Lightbox.tsx:80`)。上界是 **75000** —— 那是全屏登录覆盖层
   * (`pages-react/DesktopLoginPage.tsx:139`),盖住它会让「未登录」被一个查不到数据的
   * 抽屉挡住,那里有防回归测试。下界是聊天面板那一带的 40001,低于它会被聊天面板压住。
   * 这个仓库没有集中的 z-index 注册表,全是散落的魔法数字,所以上下界写在这里。
   */
  const shell = (children: ReactNode) =>
    createPortal(
      <div
        data-testid="usage-drawer-root"
        role="dialog"
        aria-modal="true"
        aria-label="使用明细"
        className="fixed inset-0 z-[50000] flex justify-end"
      >
        <div
          data-testid="usage-backdrop"
          aria-hidden="true"
          onClick={onClose}
          className="absolute inset-0 bg-black/70"
        />
        <aside className="relative flex h-full w-[620px] max-w-[95vw] flex-col border-l-2 border-zinc-700 bg-zinc-900">
          {children}
        </aside>
      </div>,
      document.body,
    )

  const header = (
    <div className="flex shrink-0 items-center justify-between gap-4 border-b-2 border-zinc-700 px-5 py-4">
      <div className="min-w-0">
        <div className="text-sm font-bold uppercase tracking-tight text-white">使用明细</div>
        <div className="mt-0.5 truncate text-xs text-zinc-400">
          {pool
            ? `项目 #${pool.projectId}${pool.producerProjectId !== null ? ` · 子项目 #${pool.producerProjectId}` : ''}`
            : '未选择计费池'}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          data-testid="usage-refresh"
          onClick={usage.refresh}
          disabled={usage.loading || !pool}
          className="border-2 border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-bold uppercase tracking-tight text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
        >
          {usage.loading ? '刷新中' : '刷新'}
        </button>
        <button
          type="button"
          data-testid="usage-close"
          onClick={onClose}
          className="bg-cyberpunk-yellow px-3 py-1.5 text-xs font-bold uppercase tracking-tight text-cyberpunk-black transition-all hover:opacity-90"
        >
          关闭
        </button>
      </div>
    </div>
  )

  if (!pool) {
    return shell(
      <>
        {header}
        <div className="flex flex-1 items-center justify-center px-8">
          <p data-testid="usage-no-pool" className="text-center text-sm leading-relaxed text-zinc-400">
            请先在「账号」里选择一个计费池。
            <br />
            <span className="text-xs text-zinc-500">用量按项目查询,没有项目就没有可查的范围。</span>
          </p>
        </div>
      </>,
    )
  }

  return shell(
    <>
      {header}

      {/*
        producer 池的口径说明。用量端点**只收 `projectId`**、不收 `producerProjectId`
        (见 `UsageQuery` 的注释),而池键是两半 —— 选中 producer 池时查出来的是该 project
        下全部子项目的流水。客户端过滤只能救列表、救不了汇总(服务端预聚合),还会让两者
        互相矛盾、`total` 与分页全错。所以不过滤,只如实说明。
      */}
      {pool.producerProjectId !== null && (
        <p
          data-testid="usage-producer-notice"
          className="shrink-0 border-b-2 border-zinc-800 bg-zinc-800/60 px-5 py-2 text-xs leading-relaxed text-yellow-300/80"
        >
          <span className="font-bold">口径提醒：</span>
          用量只能按项目查询,以下是项目 #{pool.projectId} 下
          <span className="font-bold">全部子项目</span>的流水,无法单独拆出当前池(子项目 #
          {pool.producerProjectId})。
        </p>
      )}

      <div className="flex shrink-0 gap-2 px-5 pt-3">
        {USAGE_RANGES.map((r) => (
          <button
            key={r.value}
            type="button"
            data-testid={`usage-range-${r.value}`}
            onClick={() => usage.setRange(r.value)}
            className={
              r.value === usage.range
                ? 'bg-cyberpunk-yellow px-3 py-1 text-xs font-bold uppercase tracking-tight text-cyberpunk-black'
                : 'border-2 border-zinc-700 bg-zinc-800 px-3 py-1 text-xs font-bold uppercase tracking-tight text-zinc-300 transition-colors hover:bg-zinc-700'
            }
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="shrink-0 px-5 pt-3">
        {usage.summaryError ? (
          <p
            data-testid="usage-summary-error"
            className="border-l-2 border-red-700 bg-zinc-800 px-3 py-2 text-xs leading-relaxed text-red-300"
          >
            汇总加载失败：{usage.summaryError}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              {/*
                标题是「消费合计（不含退款）」而不是「总费用」:汇总 SQL 带
                `WHERE type = LogTypeConsume`,而明细的 where 没有 type 过滤 ——
                一条退款会出现在下面的列表里、却不进这个数。
                也**不**在这里拿当前页硬算净额:列表是分页的,算出来的净额只对当前页成立,
                比毛额更误导。
              */}
              <SummaryCard
                testId="usage-summary-quota"
                label="消费合计（不含退款）"
                value={`¥${formatQuotaCny(usage.totalQuota)}`}
                accent
              />
              <SummaryCard
                testId="usage-summary-requests"
                label="请求次数"
                value={String(usage.totalRequests)}
                sub={`${usage.summary.length} 个模型`}
              />
              <SummaryCard
                testId="usage-summary-tokens"
                label="Token 合计"
                value={usage.totalTokens.toLocaleString()}
                sub="输入 + 输出"
              />
            </div>

            {models.length > 0 && (
              <div className="mt-3 space-y-1">
                <div id="usage-summary-models" className="space-y-1">
                {visibleModels.map((s) => {
                  const share =
                    usage.totalQuota > 0 ? (Math.max(0, s.totalQuota) / usage.totalQuota) * 100 : 0
                  return (
                    <div
                      key={s.modelName ?? '__ungrouped__'}
                      data-testid="usage-summary-model"
                      className="border-2 border-zinc-800 bg-zinc-800/40 px-3 py-1.5"
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-xs text-zinc-200">
                          {/* 汇总的 modelName 可以是 null(GROUP BY 出来的那一组)。 */}
                          {s.modelName ?? '未分组'}
                        </span>
                        <span className="shrink-0 text-xs font-bold tabular-nums text-cyberpunk-yellow">
                          ¥{formatQuotaCny(s.totalQuota)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <div className="h-1 flex-1 bg-zinc-700">
                          <div className="h-full bg-cyberpunk-yellow" style={{ width: `${share}%` }} />
                        </div>
                        <span className="shrink-0 text-[10px] tabular-nums text-zinc-500">
                          {s.totalRequests} 次
                        </span>
                      </div>
                    </div>
                  )
                })}
                </div>

                {/*
                  WAI-ARIA Disclosure:按钮带 aria-expanded / aria-controls,箭头靠
                  Tailwind 的 `group-aria-expanded:` 变体转向,不另维护一份 open 样式。
                  收起态把「藏了多少钱」写在按钮上 —— 折叠不能变成藏账。
                */}
                {hiddenModels.length > 0 && (
                  <button
                    type="button"
                    data-testid="usage-summary-toggle"
                    aria-expanded={modelsExpanded}
                    aria-controls="usage-summary-models"
                    onClick={() => setModelsExpanded((v) => !v)}
                    className="group flex w-full items-center justify-between border-2 border-dashed border-zinc-700 bg-zinc-900 px-3 py-1.5 text-left text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:bg-zinc-800"
                  >
                    <span>
                      {modelsExpanded
                        ? '收起'
                        : `展开其余 ${hiddenModels.length} 个模型`}
                      {!modelsExpanded && hiddenQuota > 0 && (
                        <span className="ml-2 tabular-nums text-zinc-500">
                          合计 ¥{formatQuotaCny(hiddenQuota)}
                        </span>
                      )}
                    </span>
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 16 16"
                      className="h-3.5 w-3.5 shrink-0 fill-none stroke-current stroke-[1.75] transition-transform duration-150 group-aria-expanded:rotate-180"
                    >
                      <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col border-t-2 border-zinc-800">
        <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-2">
          <span className="text-xs font-bold uppercase tracking-tight text-zinc-400">调用记录</span>
          <span className="flex items-center gap-2 text-xs tabular-nums text-zinc-500">
            {/*
              退款计数标「本页」:列表分页,这个数只对当前页成立。不写成「N 笔退款」——
              那会被读成时间范围内的总数,而后端汇总端点不给退款合计,这里算不出来。
            */}
            {refunds.count > 0 && (
              <span
                data-testid="usage-page-refunds"
                className="border-2 border-green-700/60 bg-green-900/30 px-1.5 py-px text-[10px] font-bold text-green-300"
              >
                本页 {refunds.count} 笔退款 +¥{formatQuotaCny(refunds.quota)}
              </span>
            )}
            <span>共 {usage.total} 条</span>
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          {/*
            三态各自独立呈现,顺序不能换。**错误态必须与空态在 DOM 上可区分** ——
            网页端把两个请求各自 `.catch(() => null)`,失败后照样显示「暂无记录」,
            用户区分不了「真没花钱」和「接口挂了」,只会去反复刷新一个坏掉的东西。
          */}
          {usage.logsError ? (
            <div
              data-testid="usage-logs-error"
              className="border-l-2 border-red-700 bg-zinc-800 px-3 py-3 text-xs leading-relaxed text-red-300"
            >
              <div className="font-bold">明细加载失败</div>
              <div className="mt-1">{usage.logsError}</div>
              <button
                type="button"
                onClick={usage.refresh}
                className="mt-2 border-2 border-zinc-700 bg-zinc-900 px-3 py-1 text-xs font-bold uppercase tracking-tight text-white transition-colors hover:bg-zinc-800"
              >
                重试
              </button>
            </div>
          ) : usage.loading && usage.rows.length === 0 ? (
            <p data-testid="usage-logs-loading" className="py-10 text-center text-xs text-zinc-500">
              加载中…
            </p>
          ) : usage.rows.length === 0 ? (
            <p data-testid="usage-logs-empty" className="py-10 text-center text-xs text-zinc-500">
              这个时间范围内没有记录。
            </p>
          ) : (
            <div className="space-y-1">
              {usage.rows.map((row, i) => {
                const isRefund = isRefundLike(row)
                const isPending = !isRefund && row.settleStatus === SETTLE_STATUS_PENDING
                return (
                  <div
                    key={`${row.id}-${i}`}
                    data-testid="usage-log-row"
                    className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 border-2 border-zinc-800 bg-zinc-800/40 px-3 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        data-testid="usage-log-model"
                        className="truncate text-xs font-medium text-white"
                      >
                        {/* 退款行的 modelName 是空串(类型是 string,不是 string|null),原样渲染
                            是一行空白。它唯一能说清「退的是哪笔」的字段是 content,主文案取它;
                            连 content 都没有才落到「退款」二字。消费行照旧显示模型名。 */}
                        {row.modelName || (isRefund ? row.content || '退款' : '未标注模型')}
                      </span>
                      {isRefund ? (
                        <span
                          data-testid="usage-refund-badge"
                          className="shrink-0 border-2 border-green-600 bg-green-900/40 px-1.5 text-[10px] font-bold uppercase tracking-tight text-green-300"
                        >
                          {row.type === LOG_TYPE_REFUND ? '退款' : '已退款'}
                        </span>
                      ) : isPending ? (
                        // 异步任务还没跑完:这笔是预扣,可能变(成功差额结算 / 失败整笔退回)。
                        <span
                          data-testid="usage-pending-badge"
                          className="shrink-0 border-2 border-zinc-600 px-1.5 text-[10px] tracking-tight text-zinc-400"
                        >
                          结算中
                        </span>
                      ) : row.feature ? (
                        <span className="shrink-0 border-2 border-zinc-700 px-1.5 text-[10px] text-zinc-400">
                          {FEATURE_LABELS[row.feature] ?? row.feature}
                        </span>
                      ) : null}
                    </div>
                    <div
                      data-testid="usage-log-amount"
                      className={`text-right text-xs font-bold tabular-nums ${
                        isRefund ? 'text-green-300' : 'text-cyberpunk-yellow'
                      }`}
                    >
                      {amountText(row)}
                    </div>
                    <div className="flex min-w-0 gap-3 text-[11px] tabular-nums text-zinc-500">
                      <span>{formatUsageTime(row.createdAt)}</span>
                      {isRefund ? (
                        <span className="text-green-400/70">结算退款</span>
                      ) : (
                        <>
                          <span>↑{row.promptTokens.toLocaleString()}</span>
                          <span>↓{row.completionTokens.toLocaleString()}</span>
                        </>
                      )}
                    </div>
                    <div className="truncate text-right text-[11px] text-zinc-600">
                      {row.tokenName ?? ''}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {usage.totalPages > 1 && (
          <div className="flex shrink-0 items-center justify-center gap-3 border-t-2 border-zinc-800 px-5 py-3">
            <button
              type="button"
              data-testid="usage-prev"
              disabled={usage.page <= 0}
              onClick={() => usage.setPage(usage.page - 1)}
              className="border-2 border-zinc-700 bg-zinc-800 px-3 py-1 text-xs font-bold uppercase tracking-tight text-white transition-colors hover:bg-zinc-700 disabled:opacity-40"
            >
              上一页
            </button>
            {/* page 是 0 基,显示成 1 基;分母用响应回来的 pageSize 算(见 useUsageData)。 */}
            <span data-testid="usage-page-indicator" className="text-xs tabular-nums text-zinc-400">
              {usage.page + 1} / {usage.totalPages}
            </span>
            <button
              type="button"
              data-testid="usage-next"
              disabled={usage.page + 1 >= usage.totalPages}
              onClick={() => usage.setPage(usage.page + 1)}
              className="border-2 border-zinc-700 bg-zinc-800 px-3 py-1 text-xs font-bold uppercase tracking-tight text-white transition-colors hover:bg-zinc-700 disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        )}
      </div>
    </>,
  )
}

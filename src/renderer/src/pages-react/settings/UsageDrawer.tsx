// 设置页 · 使用明细抽屉。
//
// 只吃 props(`open` / `pool` / `onClose`),**不自己读 `useQuotaStore`**:池由
// `AccountSection` 传进来,这样抽屉能脱开 store 单测,也不会因为「谁先初始化」而
// 在打开瞬间查一个还没恢复的池。
//
// 配色跟随所在页面,用设置页那套 token(bg-cyberpunk-yellow / border-2 /
// border-zinc-700 / 直角)。**不要**混进 Codex 侧那套 cyan + rounded-md,
// 也没有 `.miau-*` 类可用 —— 那是网页端的。

import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { UsageLogRow } from '../../../../types/authApi'
import type { Pool } from '../../stores/useQuotaStore'
import {
  LOG_TYPE_REFUND,
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

function amountText(row: UsageLogRow): string {
  if (row.type !== LOG_TYPE_REFUND) return `¥${formatQuotaCny(row.quota)}`
  // 退款的 `quota` 是负数。取量级再补 `+`,否则拼出来是 `+¥-0.0400` —— 网页端
  // (`UsageDrawer.tsx:381`)就是这么渲染的,一个自相矛盾的字符串。量级两端一致。
  return `+¥${formatQuotaCny(Math.abs(row.quota))}`
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

  if (!open) return null

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

            {usage.summary.length > 0 && (
              <div className="mt-3 space-y-1">
                {usage.summary.map((s) => {
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
            )}
          </>
        )}
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col border-t-2 border-zinc-800">
        <div className="flex shrink-0 items-center justify-between px-5 py-2">
          <span className="text-xs font-bold uppercase tracking-tight text-zinc-400">调用记录</span>
          <span className="text-xs tabular-nums text-zinc-500">共 {usage.total} 条</span>
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
                const isRefund = row.type === LOG_TYPE_REFUND
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
                        {/* 明细里退款行的 modelName 是空串(类型是 string,不是 string|null),
                            原样渲染会得到一行看起来空白的记录。 */}
                        {row.modelName || '未标注模型'}
                      </span>
                      {isRefund ? (
                        <span
                          data-testid="usage-refund-badge"
                          className="shrink-0 border-2 border-green-600 bg-green-900/40 px-1.5 text-[10px] font-bold uppercase tracking-tight text-green-300"
                        >
                          退款
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

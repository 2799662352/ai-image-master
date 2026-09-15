/**
 * StatusCard —— 生成页与批量页共用的「一张卡、四种状态」(设计稿 M5 · 状态卡族 v2)。
 *
 * 从 `pages-react/batch/BatchResultGrid.ResultCard` 抽出来:顶行(序号 / 状态徽章 /
 * 操作)与底部 prompt 不动;图区四态换成 Marathon 结构语言 ——
 *   WAIT  灰斜纹 + 十字 + 队列位
 *   RUN   黄斜纹 + 转圈 + 已用 / 预计 + 底部 3px 进度条
 *   OK    调用方给的缩略图 + 角标(转存状态等由 `overlay` 传入)
 *   ERR   红斜纹 + 红十字 + 原因(3 行截断,hover 全文)+「重试」/「复制错误」
 * 卡底可选一行 mono 元数据(渠道 · 比例 · 分辨率 · 耗时)。
 *
 * 纯展示:不认识 BatchItem / ResultUploadMeta / GenerateRun 任何一个业务模型,
 * 图怎么解析(数据万象 / 本地副本兜底链)由调用方决定后作为 `media` 传进来。
 */
import type { MouseEvent, ReactNode } from 'react'
import { useElapsedSeconds } from './useElapsedSeconds'

export type StatusCardStatus = 'pending' | 'running' | 'done' | 'error'

export interface StatusCardProps {
  /** 原始序号(0 基),渲染成 #001。 */
  index: number
  status: StatusCardStatus
  prompt: string
  /** 完成态的缩略图元素;调用方负责解析 src。 */
  media?: ReactNode
  /** 叠在图区里的额外元素(转存角标 / 图层徽章 / hover 工具条),绝对定位由调用方自己写。 */
  overlay?: ReactNode
  /** 失败原因(error 态);非 error 态传入时显示为卡底红字备注。 */
  error?: string
  /** 卡底 mono 元数据行。 */
  meta?: string
  /** running:开始时刻(epoch ms),驱动「已用 xs」。 */
  startedAt?: number
  /** running:预计耗时(秒),有则显示「/ ~40s」并驱动进度条。 */
  expectedSeconds?: number
  /** pending:队列位文案,如「QUEUE #2 · 前面还有 1 个」。 */
  queueLabel?: string
  /** 点图区(仅 done)。 */
  onOpen?: () => void
  onEdit?: () => void
  editTitle?: string
  onDownload?: () => void
  onRemove?: () => void
  onRetry?: () => void
  onCopyError?: () => void
  className?: string
  'data-testid'?: string
}

const BADGE: Record<StatusCardStatus, { cls: string; label: string }> = {
  pending: { cls: 'border-zinc-700 text-zinc-400 bg-zinc-900', label: 'WAIT' },
  running: { cls: 'border-cyberpunk-yellow/50 text-cyberpunk-yellow bg-cyberpunk-yellow/10', label: 'RUN' },
  done: { cls: 'border-green-700/60 text-green-300 bg-green-950/30', label: 'OK' },
  error: { cls: 'border-red-700/60 text-red-300 bg-red-950/30', label: 'ERR' },
}

const SQUARE_BTN =
  'flex h-5 items-center justify-center border border-zinc-700 bg-zinc-900 font-mono text-[10px] font-bold uppercase leading-none tracking-wider transition-colors'

function stop(e: MouseEvent, fn?: () => void): void {
  e.stopPropagation()
  fn?.()
}

function Ticks({ tone }: { tone: string }) {
  return (
    <>
      <span aria-hidden className={`st-tick st-tick-tl ${tone}`}>+</span>
      <span aria-hidden className={`st-tick st-tick-tr ${tone}`}>+</span>
      <span aria-hidden className={`st-tick st-tick-bl ${tone}`}>+</span>
      <span aria-hidden className={`st-tick st-tick-br ${tone}`}>+</span>
    </>
  )
}

export function StatusCard(props: StatusCardProps) {
  const { index, status, prompt, media, overlay, error, meta, startedAt, expectedSeconds, queueLabel } = props
  const badge = BADGE[status]
  const isDone = status === 'done'
  const isError = status === 'error'
  const isRunning = status === 'running'
  const elapsed = useElapsedSeconds(startedAt, isRunning)
  const progress = expectedSeconds ? Math.min(0.95, elapsed / expectedSeconds) : undefined
  const openable = isDone && !!props.onOpen

  return (
    <div
      data-testid={props['data-testid']}
      data-status={status}
      className={`flex flex-col gap-1.5 border-2 p-2 ${
        isError ? 'border-red-700/60 bg-red-950/20' : 'border-zinc-700 bg-zinc-900/60'
      } ${props.className ?? ''}`}
    >
      {/* 顶行:序号 / 状态 / 操作 */}
      <div className="flex items-center justify-between gap-1.5">
        <span className="bg-zinc-950 px-1.5 py-0.5 font-mono text-[10px] font-bold tabular-nums text-cyberpunk-yellow">
          #{String(index + 1).padStart(3, '0')}
        </span>
        <span className={`border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider ${badge.cls}`}>
          {badge.label}
        </span>
        <div className="ml-auto flex gap-1">
          {props.onEdit && (
            <button
              type="button"
              onClick={(e) => stop(e, props.onEdit)}
              aria-label="重编辑此项 (prompt + 比例 + 参考图)"
              title={props.editTitle ?? '把此项的 prompt / 比例 / 参考图全部灌回输入框'}
              className={`${SQUARE_BTN} px-1 text-cyberpunk-yellow hover:bg-cyberpunk-yellow hover:text-cyberpunk-black`}
            >
              ↺ EDIT
            </button>
          )}
          {isDone && props.onDownload && (
            <button
              type="button"
              onClick={(e) => stop(e, props.onDownload)}
              aria-label="下载图片"
              title="下载"
              className={`${SQUARE_BTN} w-5 text-sm text-cyberpunk-yellow hover:bg-cyberpunk-yellow hover:text-cyberpunk-black`}
            >
              ↓
            </button>
          )}
          {props.onRemove && (
            <button
              type="button"
              onClick={(e) => stop(e, props.onRemove)}
              aria-label="移除"
              title="移除"
              className={`${SQUARE_BTN} w-5 text-sm text-zinc-400 hover:border-red-700/60 hover:bg-red-900/50 hover:text-red-200`}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* 图区 */}
      <div
        role={openable ? 'button' : undefined}
        tabIndex={openable ? 0 : undefined}
        onClick={openable ? props.onOpen : undefined}
        onKeyDown={
          openable
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  props.onOpen?.()
                }
              }
            : undefined
        }
        className={`group relative aspect-square overflow-hidden border-2 border-zinc-800 bg-zinc-950 ${openable ? 'cursor-zoom-in' : ''}`}
      >
        {status === 'pending' && (
          <div className="st-hatch absolute inset-0 flex flex-col items-center justify-center gap-2 text-zinc-500">
            <Ticks tone="text-zinc-600" />
            <span aria-hidden className="st-cross" style={{ width: 22, height: 22 }} />
            <span className="font-mono text-xs uppercase tracking-wider">等待</span>
            {queueLabel && <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-zinc-600">{queueLabel}</span>}
          </div>
        )}

        {isRunning && (
          <div className="st-hatch-y absolute inset-0 flex flex-col items-center justify-center gap-2 text-cyberpunk-yellow">
            <Ticks tone="text-cyberpunk-yellow/70" />
            <span aria-hidden className="st-spin h-8 w-8 rounded-full border-2 border-cyberpunk-yellow border-t-transparent" />
            <span className="font-mono text-xs uppercase tracking-wider">生成中</span>
            <span className="font-mono text-[10px] tabular-nums text-cyberpunk-yellow/80" data-testid="status-card-elapsed">
              {elapsed}s{expectedSeconds ? ` / ~${expectedSeconds}s` : ''}
            </span>
            <div className="absolute inset-x-0 bottom-0 h-[3px] overflow-hidden bg-black/40">
              {progress !== undefined ? (
                <div className="h-full bg-cyberpunk-yellow transition-[width] duration-1000" style={{ width: `${Math.round(progress * 100)}%` }} />
              ) : (
                <div className="st-sweep h-full w-1/3 bg-cyberpunk-yellow" />
              )}
            </div>
          </div>
        )}

        {isDone && media}
        {isDone && overlay}

        {isError && (
          <div className="st-hatch-r absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-3 text-center text-red-300">
            <Ticks tone="text-red-700" />
            <span aria-hidden className="st-cross text-red-500" style={{ width: 26, height: 26 }} />
            <span
              className="line-clamp-3 break-words font-mono text-[10px] leading-tight"
              title={error || 'FAILED'}
              style={{ cursor: error ? 'help' : 'default' }}
            >
              {error || 'FAILED'}
            </span>
            {(props.onRetry || props.onCopyError) && (
              <div className="mt-1 flex gap-1.5">
                {props.onRetry && (
                  <button
                    type="button"
                    onClick={(e) => stop(e, props.onRetry)}
                    className="h-6 border border-red-700 px-2 font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-red-300 transition-colors hover:bg-red-900/50 hover:text-red-100"
                  >
                    重试
                  </button>
                )}
                {props.onCopyError && (
                  <button
                    type="button"
                    onClick={(e) => stop(e, props.onCopyError)}
                    className="h-6 border border-zinc-700 px-2 font-mono text-[9px] font-bold uppercase tracking-[0.1em] text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white"
                  >
                    复制错误
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* prompt */}
      <p className="m-0 line-clamp-2 min-h-[2.6em] break-words font-mono text-[11px] leading-snug text-zinc-300">{prompt}</p>

      {meta && <p className="m-0 truncate font-mono text-[9px] uppercase tracking-[0.06em] text-zinc-500">{meta}</p>}

      {error && !isError && <p className="m-0 break-words font-mono text-[10px] text-red-400">ERR: {error}</p>}
    </div>
  )
}

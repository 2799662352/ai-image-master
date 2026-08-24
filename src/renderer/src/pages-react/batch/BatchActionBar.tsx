import type { ReactNode } from 'react'

interface Props {
  total: number
  done: number
  failed: number
  running: boolean
  pendingCount: number
  willEnqueue: number
  onGenerate: () => void
  onCancel?: () => void
  leftSlot?: ReactNode
  /**
   * 已选中待拆的图 —— 主按钮改名「拆图」并**恒可点**,批次正在跑也一样。
   *
   * 这条「恒可点」是刻意的:平时批次一跑,主按钮就退化成不可点的「正在生成」状态
   * 指示器(只剩取消),那会把拆分堵死 —— 想连着拆第二张得先等整批跑完。拆分只是
   * 往队列里塞一张,由空闲 worker 捡走,没有任何理由要等。
   */
  splitArmed?: boolean
}

/**
 * BatchActionBar - 主操作区:左槽(预算) + 大 GENERATE 按钮 + 进度条 + 警告
 * 替代 PunkActionBar 的黑底 5 像素粗边 + cream 投影 zine 风。
 */
export default function BatchActionBar({
  total,
  done,
  failed,
  running,
  pendingCount,
  willEnqueue,
  onGenerate,
  onCancel,
  leftSlot,
  splitArmed = false,
}: Props) {
  const progress = total > 0 ? Math.round(((done + failed) / total) * 100) : 0

  // 运行中也允许"加入队列"，依赖 useBatchStore 的 live claim — 这就是修
  // "发送一个任务必须等它完成才能发第二个" 的 UX 出口。
  const canEnqueueDuringRun = running && willEnqueue > 0
  const canStart = !running && (willEnqueue > 0 || pendingCount > 0)
  const buttonEnabled = splitArmed || canEnqueueDuringRun || canStart

  let buttonText: string
  if (splitArmed) {
    buttonText = '拆图 // 图层分离'
  } else if (running) {
    buttonText = canEnqueueDuringRun
      ? `加入队列 × ${willEnqueue}`
      : `正在生成 (${done}/${total})`
  } else {
    buttonText = willEnqueue > 0 ? `开始生成 × ${willEnqueue}` : '继续排队'
  }

  // 运行中 + 没有新增 = 主按钮是纯状态指示 (dim yellow), 不可点。
  // 其它情况主按钮都全亮 yellow 可点。
  const buttonStyle =
    running && !canEnqueueDuringRun && !splitArmed
      ? 'flex-1 flex items-center justify-center gap-3 px-6 py-4 bg-cyberpunk-yellow/40 text-cyberpunk-black font-orbitron font-bold text-xl uppercase tracking-tight cursor-not-allowed'
      : `flex-1 min-w-[280px] flex items-center justify-center gap-3 px-6 py-4 ${
          splitArmed ? 'bg-amber-400' : 'bg-cyberpunk-yellow'
        } text-cyberpunk-black font-orbitron font-bold text-xl uppercase tracking-tight hover:bg-cyberpunk-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed`

  return (
    <div className="border-2 border-zinc-700 bg-zinc-900/60 p-4 space-y-3">
      <div className="flex flex-wrap items-stretch gap-3">
        {leftSlot && (
          <div className="flex items-center flex-shrink-0">{leftSlot}</div>
        )}

        <div className="flex-1 min-w-[280px] flex gap-2">
          <button
            type="button"
            onClick={onGenerate}
            disabled={!buttonEnabled}
            className={buttonStyle}
          >
            {/* ▶▶▶ 是「正在跑、点不动」的样子;可点时用尾部单个 ▶。
                splitArmed 属于可点,别让它顶着运行中的进度样式。 */}
            {running && !canEnqueueDuringRun && !splitArmed && (
              <span className="font-mono">▶▶▶</span>
            )}
            <span>{buttonText}</span>
            {(splitArmed || !(running && !canEnqueueDuringRun)) && (
              <span className="font-mono">▶</span>
            )}
          </button>
          {running && (
            <button
              type="button"
              onClick={onCancel}
              className="px-5 py-4 border-2 border-red-700/60 bg-red-950/30 text-red-300 font-orbitron font-bold uppercase tracking-tight hover:bg-red-900/40 hover:text-red-200 transition-colors flex items-center gap-2"
            >
              <span>■</span>
              <span>取消</span>
            </button>
          )}
        </div>
      </div>

      {/* 进度条 */}
      {total > 0 && (
        <div>
          <div className="relative h-2 bg-zinc-800 border border-zinc-700 overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 bg-cyberpunk-yellow transition-all duration-200"
              style={{ width: `${progress}%` }}
              role="progressbar"
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
          <div className="mt-1.5 flex justify-between font-mono text-[10px] uppercase tracking-wider text-zinc-500">
            <span>{progress}% 完成</span>
            <span>
              OK {done} · ERR {failed} · WAIT {pendingCount}
            </span>
          </div>
        </div>
      )}

      <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-500 text-center">
        ⚠ 保持页面打开 · 关闭页面 = 任务终止 · 失败仍计费
      </p>
    </div>
  )
}

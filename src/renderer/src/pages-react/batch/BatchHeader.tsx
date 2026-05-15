interface Props {
  total: number
  done: number
  failed: number
  running: number
  pending: number
  onClearAll: () => void
  onClearResults: () => void
}

type StatTone = 'idle' | 'ok' | 'err' | 'run' | 'wait'

const STAT_STYLES: Record<StatTone, string> = {
  idle: 'border-zinc-700 text-zinc-300 bg-zinc-900/60',
  ok:   'border-green-700/60 text-green-300 bg-green-950/30',
  err:  'border-red-700/60 text-red-300 bg-red-950/30',
  run:  'border-cyberpunk-yellow/50 text-cyberpunk-yellow bg-cyberpunk-yellow/10',
  wait: 'border-zinc-700 text-zinc-400 bg-zinc-900/40',
}

function Stat({
  label,
  value,
  tone = 'idle',
}: {
  label: string
  value: number
  tone?: StatTone
}) {
  return (
    <div
      className={`flex items-center gap-2 px-3 py-1.5 border-2 font-mono ${STAT_STYLES[tone]}`}
    >
      <span className="text-[10px] uppercase tracking-[0.18em] opacity-80">{label}</span>
      <span className="text-lg font-bold leading-none tabular-nums">
        {String(value).padStart(3, '0')}
      </span>
    </div>
  )
}

/**
 * BatchHeader - 顶部 HUD:标题、5 个状态计数、清除按钮
 * 替代 PunkHeader 的"BATCH 一括生成 / 実行 / 危 / hazard tape"拼贴
 */
export default function BatchHeader({
  total,
  done,
  failed,
  running,
  pending,
  onClearAll,
  onClearResults,
}: Props) {
  return (
    <header className="space-y-3">
      {/* 标题行 */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] font-mono uppercase tracking-[0.3em] text-cyberpunk-yellow/70">
            // BATCH MODE
          </div>
          <h1 className="text-2xl md:text-3xl font-orbitron text-cyberpunk-yellow uppercase tracking-tight">
            批量生成
          </h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={onClearResults}
            disabled={total === 0}
            className="px-3 py-1.5 border-2 border-zinc-700 bg-zinc-900 text-zinc-300 font-mono text-[11px] uppercase tracking-wider hover:border-zinc-500 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            清除结果
          </button>
          <button
            type="button"
            onClick={onClearAll}
            disabled={total === 0}
            className="px-3 py-1.5 border-2 border-red-700/60 bg-red-950/30 text-red-300 font-mono text-[11px] uppercase tracking-wider hover:border-red-500 hover:text-red-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            清空全部
          </button>
        </div>
      </div>

      {/* 状态计数 */}
      <div className="flex flex-wrap gap-2">
        <Stat label="QUEUE" value={total} tone="idle" />
        <Stat label="OK"    value={done}    tone="ok" />
        <Stat label="ERR"   value={failed}  tone="err" />
        <Stat label="RUN"   value={running} tone="run" />
        <Stat label="WAIT"  value={pending} tone="wait" />
      </div>

      {/* 细分隔线 */}
      <div className="h-px bg-zinc-800" />
    </header>
  )
}

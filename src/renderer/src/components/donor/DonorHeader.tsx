interface Props {
  total: number
  cloud: number
  local: number
  failed: number
  uploading: number
  onOpenStorage: () => void
  onClear: () => void
}

/**
 * HUD 顶栏:
 * - 大标题 HISTORY.DAT 带色散
 * - ID/REC 装饰数据流
 * - 5 个状态计数块 (双层边框 + 切角)
 * - 云存储配置入口 + 清空按钮 (hover 反色)
 */
export default function DonorHeader({ total, cloud, local, failed, uploading, onOpenStorage, onClear }: Props) {
  const pad = (n: number) => n.toString().padStart(4, '0')

  return (
    <header className="relative mb-3">
      {/* ===== 顶部 HUD 行 ===== */}
      <div className="flex items-center justify-between mb-1 d-mono text-[11px] text-[color:var(--donor-ink-mute)]">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="d-neon-text-c">[ SYS // ONLINE ]</span>
          <span>ID // 00734-SK</span>
          <span className="hidden sm:inline">CH-03 / HISTORY_BUFFER</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="d-neon-text-m">● REC</span>
          <span className="d-caret">{new Date().toLocaleTimeString('ja-JP', { hour12: false })}</span>
        </div>
      </div>

      {/* ===== 主标题 + 操作按钮 ===== */}
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <div className="text-[11px] d-mono text-[color:var(--donor-cyan)] opacity-70 tracking-[0.3em]">
            ARCHIVE // 記録庫
          </div>
          <h1
            className="d-chromatic font-black text-[40px] md:text-[56px] leading-[0.95] tracking-tight"
            data-text="HISTORY.DAT"
            style={{ fontFamily: 'var(--donor-font-jp)' }}
          >
            HISTORY.DAT
          </h1>
          <div className="mt-1 flex items-center gap-3 d-mono text-[12px] text-[color:var(--donor-ink-dim)]">
            <span className="d-bi-label">
              履歴 <em>/HIST</em>
            </span>
            <span>//</span>
            <span className="d-hud-digit">TOTAL:{pad(total)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={onOpenStorage}
            className="d-hover-invert-cyan d-clip-parallelogram px-4 py-2 d-mono text-[12px] tracking-[0.15em] uppercase"
          >
            [ STORAGE.CFG ]
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={total === 0}
            className="d-hover-invert d-clip-parallelogram px-4 py-2 d-mono text-[12px] tracking-[0.15em] uppercase disabled:opacity-40 disabled:cursor-not-allowed"
          >
            [ WIPE.ALL ]
          </button>
        </div>
      </div>

      {/* ===== 状态计数贴片 ===== */}
      <div className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-2">
        <StatBlock label="CLOUD" labelJp="雲" value={cloud} color="cyan" />
        <StatBlock label="LOCAL" labelJp="本地" value={local} color="green" />
        <StatBlock label="UPLOAD" labelJp="送信中" value={uploading} color="amber" />
        <StatBlock label="FAILED" labelJp="失敗" value={failed} color="red" />
      </div>

      {/* 分隔线 */}
      <div className="mt-4 h-[2px] relative">
        <div className="absolute inset-0 bg-[color:var(--donor-magenta)] opacity-60" />
        <div className="absolute inset-x-0 top-full h-[1px] bg-[color:var(--donor-cyan)] opacity-40" />
      </div>
    </header>
  )
}

function StatBlock({
  label,
  labelJp,
  value,
  color,
}: {
  label: string
  labelJp: string
  value: number
  color: 'cyan' | 'green' | 'amber' | 'red'
}) {
  const colorMap: Record<typeof color, string> = {
    cyan: 'var(--donor-cyan)',
    green: 'var(--donor-green)',
    amber: 'var(--donor-amber)',
    red: 'var(--donor-red)',
  }
  return (
    <div
      className="d-clip-tag relative px-3 py-2 border border-[color:var(--donor-border-outer)]"
      style={{ background: 'rgba(20,8,28,0.55)' }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="d-bi-label text-[11px] tracking-widest" style={{ color: colorMap[color] }}>
          {labelJp}
          <em>/{label}</em>
        </span>
        <span
          className="d-mono font-bold text-[22px] leading-none"
          style={{
            color: colorMap[color],
            textShadow: `0 0 6px ${colorMap[color]}88`,
          }}
        >
          {value.toString().padStart(3, '0')}
        </span>
      </div>
    </div>
  )
}

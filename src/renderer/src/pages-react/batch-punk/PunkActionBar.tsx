import type { ReactNode } from 'react'

interface Props {
  total: number
  done: number
  failed: number
  running: boolean
  pendingCount: number
  willEnqueue: number          // 点 GENERATE 后会新增的任务数 (card mode = count, multi mode = lines × per)
  onGenerate: () => void
  onCancel?: () => void
  /** 主按钮左侧的插槽,用来塞预算收据等附加信息 */
  leftSlot?: ReactNode
}

/**
 * PunkActionBar - 巨型 GENERATE 按钮 + 进度条 + 提示
 */
export default function PunkActionBar({
  total,
  done,
  failed,
  running,
  pendingCount,
  willEnqueue,
  onGenerate,
  onCancel,
  leftSlot,
}: Props) {
  const progress = total > 0 ? Math.round(((done + failed) / total) * 100) : 0
  const canRun = !running && (willEnqueue > 0 || pendingCount > 0)

  return (
    <div
      style={{
        marginTop: 10,
        marginBottom: 24,
        padding: '1.2rem 1.4rem',
        background: 'var(--punk-black)',
        border: '5px solid var(--punk-black)',
        boxShadow: '8px 8px 0 var(--punk-cream)',
        position: 'relative',
      }}
    >
      {/* 主按钮区:左收据 + 右大按钮(窄屏自动堆叠) */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'stretch',
          gap: 16,
        }}
      >
        {leftSlot && (
          <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center' }}>
            {leftSlot}
          </div>
        )}
        {running ? (
          <div style={{ flex: '1 1 320px', display: 'flex', gap: 10 }}>
            <button
              type="button"
              disabled
              className="p-btn p-btn--pink p-btn--xl"
              style={{
                flex: '1 1 auto',
                fontSize: 28,
                padding: '1.1rem 2rem',
                letterSpacing: '0.04em',
                gap: 14,
                opacity: 0.85,
              }}
            >
              <span className="p-mono">▶▶▶</span>
              <span>EXECUTING ({done}/{total})</span>
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="p-btn p-btn--xl"
              style={{
                flex: '0 0 auto',
                fontSize: 18,
                padding: '1.1rem 1.6rem',
                letterSpacing: '0.04em',
                gap: 8,
                background: 'var(--punk-red)',
                color: 'var(--punk-cream)',
                border: '4px solid var(--punk-black)',
                boxShadow: '5px 5px 0 var(--punk-cream)',
                cursor: 'pointer',
                fontWeight: 900,
              }}
            >
              <span>■</span>
              <span>CANCEL</span>
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onGenerate}
            disabled={!canRun}
            className="p-btn p-btn--pink p-btn--xl"
            style={{
              flex: '1 1 320px',
              fontSize: 28,
              padding: '1.1rem 2rem',
              letterSpacing: '0.04em',
              gap: 14,
            }}
          >
            <span className="p-heart">♥</span>
            <span>{willEnqueue > 0 ? `GENERATE × ${willEnqueue}` : 'RESUME PENDING'}</span>
            <span className="p-mono">▶</span>
          </button>
        )}
      </div>

      {/* 进度条 (仅 total > 0 时显示) */}
      {total > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="p-progress">
            <div
              className="p-progress__bar"
              style={{ width: `${progress}%` }}
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
              role="progressbar"
            />
          </div>
          <div
            className="p-mono"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginTop: 6,
              fontSize: 11,
              color: 'var(--punk-cream)',
              fontWeight: 900,
            }}
          >
            <span>// {progress}% COMPLETE</span>
            <span>OK {done} · ERR {failed} · WAIT {pendingCount}</span>
          </div>
        </div>
      )}

      {/* 警告小字 */}
      <p
        className="p-mono"
        style={{
          marginTop: 10,
          fontSize: 10,
          color: 'var(--punk-cream)',
          opacity: 0.75,
          fontWeight: 700,
          textTransform: 'uppercase',
          textAlign: 'center',
        }}
      >
        ⚠ Keep page open · 关闭页面 = 任务终止 · 失败仍计费
      </p>
    </div>
  )
}

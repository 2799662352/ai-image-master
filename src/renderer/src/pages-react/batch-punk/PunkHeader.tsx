interface Props {
  total: number
  done: number
  failed: number
  running: number
  pending: number
  onClearAll: () => void
  onClearResults: () => void
}

/**
 * PunkHeader - 批量生成页眉
 * 拼贴元素:大标题 + 倾斜汉字 stamp + 勘亭红印 + 速度计数 + 操作按钮
 */
export default function PunkHeader({
  total,
  done,
  failed,
  running,
  pending,
  onClearAll,
  onClearResults,
}: Props) {
  return (
    <header style={{ position: 'relative', marginBottom: 28 }}>
      {/* ===== 顶部 ribbon: hazard 标签 + 速度计数 ===== */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 18,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="p-hazard-tape p-tilt-l-3">CAUTION // BATCH MODE</span>
          <span className="p-hazard-tape p-tilt-r-2" style={{ background: 'var(--punk-pink)', color: 'var(--punk-cream)' }}>
            DOHNA-DOHNA SYS
          </span>
          <span className="p-mono" style={{ fontSize: 12, color: 'var(--punk-black)', fontWeight: 900 }}>
            REC // {new Date().toTimeString().slice(0, 5)}
          </span>
        </div>

        {/* 操作按钮 */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="p-btn"
            onClick={onClearResults}
            disabled={total === 0}
            style={{ fontSize: 12, padding: '0.4rem 0.9rem', borderWidth: 3 }}
          >
            CLR.RESULTS
          </button>
          <button
            type="button"
            className="p-btn p-btn--pink"
            onClick={onClearAll}
            disabled={total === 0}
            style={{ fontSize: 12, padding: '0.4rem 0.9rem', borderWidth: 3 }}
          >
            <span className="p-heart">♥</span> WIPE.ALL
          </button>
        </div>
      </div>

      {/* ===== 主标题区 (拼贴) ===== */}
      <div style={{ position: 'relative', minHeight: 130 }}>
        {/* 装饰大汉字 (绝对定位,不占流) */}
        <div
          aria-hidden="true"
          className="p-kanji-stamp p-tilt-l-5"
          style={{
            position: 'absolute',
            right: 8,
            top: -8,
            fontSize: 168,
            opacity: 0.92,
            color: 'var(--punk-black)',
            textShadow: '6px 6px 0 var(--punk-cream)',
            zIndex: 1,
            pointerEvents: 'none',
          }}
        >
          実行
        </div>

        {/* 标题贴纸 1: BATCH (黑底品红字) */}
        <div
          className="p-sticker p-sticker--black p-tilt-l-2"
          style={{
            display: 'inline-block',
            padding: '0.4rem 1.4rem',
            position: 'relative',
            zIndex: 2,
          }}
        >
          <span
            className="p-display p-italic"
            style={{
              fontSize: 56,
              lineHeight: 1,
              color: 'var(--punk-pink)',
              letterSpacing: '-0.04em',
            }}
          >
            BATCH
          </span>
        </div>

        {/* 标题贴纸 2: 一括生成 (米白底黑字, 倾斜) */}
        <div
          className="p-sticker p-tilt-r-3"
          style={{
            display: 'inline-block',
            marginLeft: 14,
            marginTop: -6,
            padding: '0.3rem 1rem',
            position: 'relative',
            zIndex: 2,
          }}
        >
          <span className="p-jp" style={{ fontSize: 28 }}>
            一括<span style={{ color: 'var(--punk-pink-deep)' }}>生</span>成
          </span>
        </div>

        {/* 副标题: 抽卡机 / GACHA MODE */}
        <div
          className="p-callout p-tilt-l-2"
          style={{
            display: 'inline-block',
            marginTop: 20,
            marginLeft: 10,
            position: 'relative',
            zIndex: 2,
            fontSize: 13,
          }}
        >
          // KEEP.PAGE.OPEN // GACHA.READY //
        </div>

        {/* 勘亭红印 (右上,倾斜) */}
        <div
          aria-hidden="true"
          className="p-hanko"
          style={{
            position: 'absolute',
            right: 100,
            top: 60,
            zIndex: 3,
          }}
        >
          危
        </div>
      </div>

      {/* ===== 状态徽章行 ===== */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginTop: 22,
          flexWrap: 'wrap',
        }}
      >
        <span className="p-badge p-badge--wait">
          <span className="p-mono">QUEUE</span>
          <span className="p-mono">{String(total).padStart(3, '0')}</span>
        </span>
        <span className="p-badge p-badge--ok">
          <span className="p-mono">OK</span>
          <span className="p-mono">{String(done).padStart(3, '0')}</span>
        </span>
        <span className="p-badge p-badge--err">
          <span className="p-mono">ERR</span>
          <span className="p-mono">{String(failed).padStart(3, '0')}</span>
        </span>
        <span className="p-badge p-badge--run">
          <span className="p-mono">RUN</span>
          <span className="p-mono">{String(running).padStart(3, '0')}</span>
        </span>
        <span className="p-badge p-badge--wait" style={{ background: 'var(--punk-yellow)' }}>
          <span className="p-mono">WAIT</span>
          <span className="p-mono">{String(pending).padStart(3, '0')}</span>
        </span>
      </div>
    </header>
  )
}

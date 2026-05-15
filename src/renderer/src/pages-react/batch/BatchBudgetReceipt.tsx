import { useEffect, useRef } from 'react'
import { formatPrice } from '../../utils/model-price'

interface Props {
  modelName: string
  /** USD 单价;0 表示未知,UI 退到 "$ ?" */
  unitPrice: number
  count: number
  mode: 'card' | 'multi'
}

/**
 * BatchBudgetReceipt - 紧贴 GENERATE 按钮的预算小贴片。
 * 替代 PunkBudgetReceipt 的纸条+红印 zine 风,现在是干净的 zinc 卡片。
 * 总价变化时主数字弹跳一次(prefers-reduced-motion 下不动)。
 */
export function BatchBudgetReceipt({ modelName, unitPrice, count, mode }: Props) {
  const known = unitPrice > 0
  const total = known ? unitPrice * count : 0
  const totalRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const el = totalRef.current
    if (!el) return
    el.classList.remove('batch-receipt-bump')
    void el.offsetWidth
    el.classList.add('batch-receipt-bump')
  }, [total])

  const shotLabel = mode === 'card' ? 'shot' : 'take'

  return (
    <div
      className="flex flex-col gap-1 px-4 py-2.5 border-2 border-zinc-700 bg-zinc-900/60 min-w-[200px]"
      role="status"
      aria-live="polite"
      aria-label={`预计生成 ${count} 张${known ? `,共计 ${formatPrice(total)}` : ',价格未知'}`}
    >
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-zinc-500">
        <span>// receipt</span>
        <span>#{String(count).padStart(3, '0')}</span>
      </div>
      <div
        className="font-mono text-[11px] text-zinc-400 truncate"
        title={modelName}
      >
        {modelName || '—'}
      </div>
      <div className="flex items-baseline gap-2">
        <span
          ref={totalRef}
          className="text-xl font-orbitron font-bold text-cyberpunk-yellow tabular-nums leading-none"
        >
          {known ? formatPrice(total) : '$ ?'}
        </span>
        <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">
          USD
        </span>
      </div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
        {count} {shotLabel} × {known ? formatPrice(unitPrice) : '价格未知'}
      </div>
      <style>{`
        @keyframes batch-receipt-bump-kf {
          0% { transform: scale(1); }
          50% { transform: scale(1.08); }
          100% { transform: scale(1); }
        }
        .batch-receipt-bump {
          animation: batch-receipt-bump-kf 0.24s ease-out;
          display: inline-block;
        }
        @media (prefers-reduced-motion: reduce) {
          .batch-receipt-bump { animation: none !important; }
        }
      `}</style>
    </div>
  )
}

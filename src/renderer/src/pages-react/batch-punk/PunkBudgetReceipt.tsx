import { useEffect, useRef } from 'react'
import { formatPrice } from '../../utils/model-price'

interface Props {
  modelName: string
  /** USD 单价;0 表示未知,UI 会退到 "$ ?" */
  unitPrice: number
  count: number
  mode: 'card' | 'multi'
}

/**
 * 朋克拼贴风预算收据贴片。
 * 紧贴 GENERATE 按钮显示「N SHOT × $unit = $total」。
 * 总价变化时主数字会触发一次 0.28s 弹跳(prefers-reduced-motion 下不动)。
 */
export function PunkBudgetReceipt({ modelName, unitPrice, count, mode }: Props) {
  const known = unitPrice > 0
  const total = known ? unitPrice * count : 0
  const totalRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const el = totalRef.current
    if (!el) return
    el.classList.remove('p-receipt-bump')
    void el.offsetWidth
    el.classList.add('p-receipt-bump')
  }, [total])

  const headTag = mode === 'card' ? 'RECEIPT // 抽卡' : 'RECEIPT // 連射'
  const shotLabel = mode === 'card' ? 'SHOT' : 'TAKE'

  return (
    <div
      className={`p-receipt ${known ? '' : 'p-receipt-unknown'}`}
      role="status"
      aria-live="polite"
      aria-label={`预计生成 ${count} 张${known ? `,共计 ${formatPrice(total)}` : ',价格未知'}`}
    >
      {/* 右上角红色 hanko 印章,替代旧 DO IT 飘标 */}
      <div className="p-receipt-stamp" aria-hidden="true">
        <span className="p-receipt-stamp__big">実行</span>
        <span className="p-receipt-stamp__small">DO IT</span>
      </div>

      <div className="p-receipt-head">
        <span>{headTag}</span>
        <span>#{String(count).padStart(3, '0')}</span>
      </div>

      <div className="p-receipt-model" title={modelName}>
        MODEL // {modelName || '—'}
      </div>

      <div className="p-receipt-total">
        <span ref={totalRef} className="p-receipt-total-num">
          {known ? formatPrice(total) : '$ ?'}
        </span>
        <span className="p-receipt-total-unit">USD</span>
      </div>

      <div className="p-receipt-breakdown">
        {count} {shotLabel}
        <span className="p-x">×</span>
        {known ? formatPrice(unitPrice) : '価格不明'}
      </div>
    </div>
  )
}

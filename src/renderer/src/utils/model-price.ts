/**
 * 单张出图的实际价格(USD)解析。
 *
 * 优先级:
 *   1. model.price 字段(权威值,新模型应都填)
 *   2. model.displayName 中 `$X.XX/张` 兜底解析(老模型未补 price 时)
 *   3. 都没有 → 0,UI 用 0 判定为「未知」
 *
 * 不抛错;入参可以是 null/undefined/任意结构。
 */
export function extractPriceFromModel(model: unknown): number {
  if (!model || typeof model !== 'object') return 0

  const m = model as { price?: unknown; displayName?: unknown }

  if (typeof m.price === 'number' && Number.isFinite(m.price) && m.price >= 0) {
    return m.price
  }

  if (typeof m.displayName === 'string') {
    const match = m.displayName.match(/\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*张/)
    if (match) {
      const v = parseFloat(match[1])
      if (Number.isFinite(v) && v >= 0) return v
    }
  }

  return 0
}

/**
 * 将价格格式化为「$0.060」这样三位小数的字符串。
 * 适合在收据 UI 中等宽展示。
 */
export function formatPrice(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return '$ ?'
  return `$${price.toFixed(3)}`
}

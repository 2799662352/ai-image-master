/**
 * Codex stores config in TOML and TOML has no `null` type. Cursor exports —
 * and many other MCP exports — frequently emit `"some_field": null` to mean
 * "unset". If we forward those nulls to Codex's `config/batchWrite`, Codex
 * rejects the entire batch with:
 *
 *   invalid value: invalid type: null, expected any valid TOML value
 *
 * Strategy: recursively drop any property whose value is `null` (or `undefined`)
 * before sending. We preserve all other types (booleans, numbers, strings,
 * arrays, nested objects). Arrays keep their indices but null/undefined items
 * are filtered out — TOML arrays also can't hold null.
 */
export function stripNullDeep<T>(value: T): T {
  if (value === null || value === undefined) {
    return value
  }
  if (Array.isArray(value)) {
    const out = value
      .filter((item) => item !== null && item !== undefined)
      .map((item) => stripNullDeep(item))
    return out as unknown as T
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined) continue
      result[k] = stripNullDeep(v)
    }
    return result as unknown as T
  }
  return value
}

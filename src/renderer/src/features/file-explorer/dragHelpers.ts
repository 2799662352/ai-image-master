const FILE_TYPE = 'application/x-catimation-file-paths'
const QUOTE_TYPE = 'application/x-catimation-quote'

/**
 * Serialize one or more file paths into the drag DataTransfer.
 *
 * - Internal MIME (`application/x-catimation-file-paths`) carries a JSON
 *   string array; lets `parseFileDrop` recover N paths losslessly.
 * - `text/plain` is a newline-joined fallback so external targets (chat input,
 *   editors, terminal) still see something useful when N>=1.
 */
export function serializeFileDrag(dt: DataTransfer, paths: string[]): void {
  if (paths.length === 0) return
  dt.setData(FILE_TYPE, JSON.stringify(paths))
  dt.setData('text/plain', paths.join('\n'))
}

/**
 * Returns the dragged paths in original order. Always an array (possibly empty)
 * so callers can iterate uniformly without null checks.
 */
export function parseFileDrop(dt: DataTransfer): string[] {
  const raw = dt.getData(FILE_TYPE)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
      return parsed as string[]
    }
  } catch {
    // Older payload format (single path) — graceful fallback
    return [raw]
  }
  return []
}

export function serializeQuoteDrag(dt: DataTransfer, quote: string): void {
  dt.setData(QUOTE_TYPE, quote)
}

export function parseQuoteDrop(dt: DataTransfer): string | null {
  return dt.getData(QUOTE_TYPE) || null
}

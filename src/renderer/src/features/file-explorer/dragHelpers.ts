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

/**
 * True when a drag carries something our drop targets can actually act on:
 * internal file paths, a quote, or OS files.
 *
 * Exists so drop targets can light up a "you can drop here" affordance without
 * re-hardcoding the MIME literals — this module owns the vocabulary. Deliberately
 * does NOT decide whether a given target accepts the payload (FileTreeNode still
 * refuses rows that have no destination dir); it only answers "is this one of ours".
 */
export function dragCarriesDroppablePayload(dt: DataTransfer): boolean {
  const types = dt.types
  return types.includes(FILE_TYPE) || types.includes(QUOTE_TYPE) || types.includes('Files')
}

export function serializeQuoteDrag(dt: DataTransfer, quote: string): void {
  dt.setData(QUOTE_TYPE, quote)
}

export function parseQuoteDrop(dt: DataTransfer): string | null {
  return dt.getData(QUOTE_TYPE) || null
}

/**
 * Resolve a `FileList` from an external OS drag-drop into absolute file paths
 * via Electron's `webUtils.getPathForFile` (exposed at electronAPI.getFilePath).
 *
 * Returns [] when:
 *   - The renderer is running on a build without the bridge (Electron < 32 or
 *     a stripped preload), in which case we log a warning so future debugging
 *     isn't a guessing game.
 *   - Every File is synthetic (clipboard paste with no on-disk path → '').
 *
 * Callers should always check `paths.length === 0` and bail rather than
 * dispatching an IPC with no work to do.
 */
export function resolveExternalPaths(files: FileList): string[] {
  const getFilePath = (window as Window & {
    electronAPI?: { getFilePath?: (f: File) => string }
  }).electronAPI?.getFilePath
  if (!getFilePath) {
    console.warn(
      '[file-explorer] electronAPI.getFilePath unavailable — external OS file drop ignored. ' +
        'Renderer may be running on Electron < 32 or a stripped preload.',
    )
    return []
  }
  return Array.from(files)
    .map((f) => getFilePath(f))
    .filter((p): p is string => Boolean(p))
}

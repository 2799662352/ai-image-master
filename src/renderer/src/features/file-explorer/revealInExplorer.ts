/**
 * Helpers for "click a link in chat → reveal that file in the left FILES panel".
 *
 * The assistant emits markdown links (e.g. `[镜头摆设](file:///C:/.../uploads/x.png)`)
 * that MarkdownContent renders as blue `<a>`s. We want a click on a link that
 * points at a LOCAL file to select + scroll-to that file in the file-explorer
 * tree instead of doing nothing / opening an external browser tab.
 *
 * `osPathFromHref` is a PURE resolver (unit-tested) that turns the various
 * link `href` shapes the model can produce into an absolute OS path, or `''`
 * when the href is not a local file (http(s)/blob/data/mailto/etc.).
 *
 * It intentionally accepts `file://` — unlike `references/referenceUtils.ts`'s
 * `localPathFromUri`, which rejects `file:` because that path is for attachment
 * URIs (always `local-file://`). Here the href is authored by the model, so
 * plain `file://` is the most common shape and must be supported.
 *
 * Like `localPathFromUri`, we do pure string parsing (NOT `new URL()`):
 * Chromium folds Windows drive letters for standard schemes
 * (`new URL('file:///C:/x').pathname` → `/x`), which silently corrupts paths.
 */
export function osPathFromHref(href: string | undefined | null): string {
  if (typeof href !== 'string' || href.length === 0) return ''

  // `file://[host]/path` and `local-file:///path`.
  const fileMatch = /^(file:\/\/|local-file:\/\/)/i.exec(href)
  if (fileMatch) {
    let rest = href.slice(fileMatch[0].length)
    // Drop an authority/host component if present (`file://host/path`); the
    // common `file:///path` leaves `rest` starting with `/`.
    if (!rest.startsWith('/')) {
      const slash = rest.indexOf('/')
      rest = slash >= 0 ? rest.slice(slash) : ''
    }
    let decoded: string
    try {
      decoded = decodeURIComponent(rest)
    } catch {
      return ''
    }
    return normalizeDecodedPath(decoded)
  }

  // Non-local schemes — let the caller fall back to default link behaviour.
  if (/^(blob|data|https?|mailto|tel|ftp|about|javascript):/i.test(href)) return ''

  // Raw paths the model sometimes drops straight into a markdown link target.
  return normalizeDecodedPath(href)
}

/**
 * Normalize a decoded path string to an absolute OS path, or `''` if it is not
 * a recognisable absolute local path (relative links, anchors, etc.). Blocks
 * `..` traversal segments defensively.
 */
function normalizeDecodedPath(input: string): string {
  if (input.length === 0) return ''
  if (input.split(/[\\/]/).some((segment) => segment === '..')) return ''

  // Windows drive path that lost its leading slash via `file:///C:/...`
  // (decoded becomes `/C:/Users/...`). Strip the spurious leading slash.
  const winLed = /^\/([A-Za-z]:[\\/].*)$/.exec(input)
  if (winLed) return winLed[1]

  // Bare Windows path (`C:\foo` or `C:/foo`).
  if (/^[A-Za-z]:[\\/]/.test(input)) return input

  // POSIX absolute path.
  if (input.startsWith('/') && !input.startsWith('//')) return input

  return ''
}

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|avif|bmp|svg|ico)$/i

/**
 * True when an href/path points at an image by extension (query string and
 * hash are ignored). Used to route remote (http/https) image links to the
 * in-chat lightbox instead of an external browser tab.
 */
export function isImageHref(href: string | undefined | null): boolean {
  if (typeof href !== 'string' || href.length === 0) return false
  const noQuery = href.split(/[?#]/)[0]
  return IMAGE_EXT_RE.test(noQuery)
}

/**
 * True when `dir` is an ancestor directory of `target` (same separator family).
 * Used by FileTreeNode to decide whether to auto-expand on a reveal request.
 */
export function isAncestorPath(dir: string, target: string): boolean {
  if (!dir || !target || dir === target) return false
  const sep = dir.includes('\\') || target.includes('\\') ? '\\' : '/'
  const dirWithSep = dir.endsWith(sep) ? dir : dir + sep
  return target.startsWith(dirWithSep)
}

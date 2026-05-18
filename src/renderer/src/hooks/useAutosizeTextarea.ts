import { useLayoutEffect, type RefObject } from 'react'

/**
 * useAutosizeTextarea — grows a <textarea> with its content, between
 * minRows and maxRows. Above maxRows it switches to internal scrolling.
 *
 * Implementation notes:
 * - We measure line-height from the live element (handles font scaling,
 *   zoom, system font fallbacks). vh-based or fixed-px clamps would drift
 *   on the user's machine.
 * - We reset height to "auto" first so the browser recomputes scrollHeight
 *   from the wrapped text. Without this, the height only ever grows.
 * - useLayoutEffect so the height is right on the same paint as the new
 *   value (prevents a 1-frame flicker when pasting a long block).
 *
 * NOTE: pair with `style={{ overflow: 'hidden' }}` while under maxRows or
 * the textarea draws an unnecessary scrollbar. We toggle that here.
 */
export function useAutosizeTextarea(
  ref: RefObject<HTMLTextAreaElement>,
  value: string,
  opts: { minRows?: number; maxRows?: number } = {},
): void {
  const { minRows = 4, maxRows = 24 } = opts

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    // Read line-height once per layout pass; falls back to font-size * 1.5
    // for "normal" line-heights (browsers report the literal string).
    const cs = window.getComputedStyle(el)
    const lhRaw = cs.lineHeight
    const lh = lhRaw === 'normal'
      ? parseFloat(cs.fontSize) * 1.5
      : parseFloat(lhRaw)
    const paddingY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    const borderY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)

    const minHeight = lh * minRows + paddingY + borderY
    const maxHeight = lh * maxRows + paddingY + borderY

    // Reset so scrollHeight reflects content, not the old (taller) box.
    el.style.height = 'auto'
    const next = Math.min(maxHeight, Math.max(minHeight, el.scrollHeight + borderY))
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight + borderY > maxHeight ? 'auto' : 'hidden'
  }, [ref, value, minRows, maxRows])
}

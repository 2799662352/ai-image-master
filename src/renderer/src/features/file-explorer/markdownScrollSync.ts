/**
 * 编辑器 ↔ 预览 的滚动同步。
 *
 * VS Code 干同一件事要跨 iframe 用 postMessage 来回传行号(它的预览是 webview),
 * 我们和预览在同一个 document 里,直接读 DOM 与 CodeMirror 的行块坐标就行 ——
 * 没有消息往返,也就没有它那种"拖快了预览追不上"的滞后。
 *
 * 对齐锚点是预览里每个块级元素上的 `data-line`(源码行号,1 起),类名 `.code-line`
 * 沿用 VS Code 的叫法。两个锚点之间按像素**线性插值**:一个 200 行的段落在源码里
 * 占 1 行、在预览里占 3 屏,不插值就会一跳一跳。
 */

/** 预览里一个块的位置(相对预览容器顶部)。 */
export interface PreviewAnchor {
  /** 源码行号,1 起。 */
  line: number
  /** 相对预览滚动容器内容顶部的偏移。 */
  top: number
}

/**
 * 源码行 → 预览滚动位置。
 *
 * 落在两个锚点之间时按行号比例插值;在首个锚点之前回 0;在末个锚点之后回它的
 * top(再往下没有可对齐的东西,继续外推只会把文档甩过头)。
 */
export function previewTopForLine(anchors: readonly PreviewAnchor[], line: number): number {
  if (anchors.length === 0) return 0
  if (line <= anchors[0].line) return 0

  for (let i = 0; i < anchors.length - 1; i++) {
    const cur = anchors[i]
    const next = anchors[i + 1]
    if (line >= next.line) continue
    const span = next.line - cur.line
    if (span <= 0) return cur.top
    const ratio = (line - cur.line) / span
    return cur.top + (next.top - cur.top) * ratio
  }

  return anchors[anchors.length - 1].top
}

/**
 * 预览滚动位置 → 源码行。`previewTopForLine` 的逆运算,同样线性插值。
 *
 * 用于「用户滚预览,编辑器跟着走」。返回值向下取整到整行 —— 行号是离散的,
 * 给个 12.4 行没有意义。
 */
export function lineForPreviewTop(anchors: readonly PreviewAnchor[], top: number): number {
  if (anchors.length === 0) return 1
  if (top <= anchors[0].top) return anchors[0].line

  for (let i = 0; i < anchors.length - 1; i++) {
    const cur = anchors[i]
    const next = anchors[i + 1]
    if (top >= next.top) continue
    const span = next.top - cur.top
    if (span <= 0) return cur.line
    const ratio = (top - cur.top) / span
    return Math.floor(cur.line + (next.line - cur.line) * ratio)
  }

  return anchors[anchors.length - 1].line
}

/**
 * 从预览容器里采集锚点。
 *
 * `offsetTop` 是相对**最近的定位祖先**的,而预览根节点自己是 static —— 所以这里
 * 用 getBoundingClientRect 相减,把「相对滚动容器内容顶部」算准。少了这一步,
 * 预览外面哪天多包一层 relative 就会整体偏移,而且偏移量随滚动位置变化,极难查。
 */
export function collectPreviewAnchors(container: HTMLElement): PreviewAnchor[] {
  const containerTop = container.getBoundingClientRect().top - container.scrollTop
  const out: PreviewAnchor[] = []
  for (const el of container.querySelectorAll<HTMLElement>('[data-line]')) {
    const line = Number(el.dataset.line)
    if (!Number.isFinite(line)) continue
    const top = el.getBoundingClientRect().top - containerTop
    // 同一行多个锚点(如列表项与其段落)只留第一个,避免插值区间塌成 0 宽
    if (out.length > 0 && out[out.length - 1].line === line) continue
    out.push({ line, top })
  }
  return out
}

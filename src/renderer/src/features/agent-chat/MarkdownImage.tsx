import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useNearViewport } from '../../components/shared/media/useNearViewport'
import { useResolvedMediaSrc } from '../../components/shared/media/useResolvedMediaSrc'
import { parseFileCitation } from '../../../../shared/fileCitation'
import type { AttachmentRef } from '../../../../types/agent-timeline'
import { useFileExplorerStore } from '../file-explorer/store'
import { toRenderableUri } from '../file-explorer/uri'
import { ImageHoverActions } from './ImageHoverActions'
import { useAgentChatStore } from './store'

/**
 * 助手正文里的 `![alt](src)`。
 *
 * 之前 `MarkdownContent` 没有覆写 `img`,react-markdown 直接吐一个裸 `<img>`:
 *  - 点它什么都不发生(聊天里其它缩略图——生成图卡、附件卡——都能点开灯箱,唯独正文里
 *    嵌的图不行,这就是「有些图片点不开、也没法复制」);
 *  - 本地盘符路径(`Q:\…`)被 react-markdown 编码成 `Q:%5C…`,浏览器当相对 URL 加载 → 裂图;
 *    `file://` 在 dev 窗口是 http 源,同样「Not allowed to load local resource」。
 *
 * 这里和别的聊天缩略图走同一条链路:地址先规整成原始地址(https / local-file://),
 * 再经 `useResolvedMediaSrc` 换成能加载的 blob:;点击进灯箱;悬停出「复制 / 下载」。
 * 参照 react-markdown 官方给的做法(remarkjs/react-markdown#764:`components={{ img }}`)。
 */

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
}

export function mimeFromHref(href: string): string {
  const ext = href.split(/[?#]/)[0].split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_MIME_BY_EXT[ext] ?? 'image/png'
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * 把 markdown 里的图片地址变成「原始地址」:https / blob: / data: 原样;
 * 本地的一律规整成 `local-file:///C:/…`(也是主进程「复制 / 另存为」认得的形态)。
 * react-markdown 已把裸路径里的 `\` 和中文编码成 `%5C` / `%E8…`,这里先解回来。
 */
export function markdownImageUri(src: string, workspaceRoot: string | null): string {
  if (!src) return ''
  if (/^(https?:|blob:|data:)/i.test(src)) return src
  const decoded = safeDecode(src)
  const citation = parseFileCitation(/^(file|local-file):/i.test(src) ? src : decoded, { workspaceRoot })
  return toRenderableUri(citation ? citation.path : decoded)
}

function nameFromUri(uri: string, alt: string | undefined): string {
  const last = safeDecode(uri.split(/[?#]/)[0].split(/[\\/]/).pop() ?? '')
  return last && !last.startsWith('data:') ? last : alt || 'image'
}

/** 本地图读盘最多等这么久,超过就当加载失败(给个明确的占位,而不是永远转圈)。 */
const LOAD_TIMEOUT_MS = 8000

export function MarkdownImage({ src, alt }: { src?: string; alt?: string }): JSX.Element {
  const workspaceRoot = useFileExplorerStore((s) => s.workspaceRoot)
  const uri = useMemo(() => markdownImageUri(src ?? '', workspaceRoot), [src, workspaceRoot])
  const name = useMemo(() => nameFromUri(uri, alt), [uri, alt])
  const holderRef = useRef<HTMLSpanElement | null>(null)
  const near = useNearViewport(holderRef)
  // fullFidelity:行内就是按原图显示(不是 256px 小图),且和灯箱共用同一份缓存、不二次读盘。
  // 还没靠近可视区时传空串 = 不读盘,只显示骨架。
  const resolved = useResolvedMediaSrc(near ? uri : '', 'image', { fullFidelity: true })

  const [errored, setErrored] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  useEffect(() => {
    setErrored(false)
    setTimedOut(false)
  }, [uri])
  useEffect(() => {
    // 没开始读(还没靠近)就不计时,否则滚动前的图会被误判成「无法加载」。
    if (!near || !uri || resolved != null) return undefined
    const t = setTimeout(() => setTimedOut(true), LOAD_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [near, uri, resolved])

  if (!uri || errored || (resolved == null && timedOut)) {
    return (
      <span className="inline-flex max-w-full items-center gap-1 rounded border border-zinc-700/50 bg-zinc-900/60 px-2 py-1 text-[12px] text-zinc-400">
        <span aria-hidden="true">🖼</span>
        <span className="truncate">{alt || name}</span>
        <span className="shrink-0 text-zinc-500">(图片无法加载)</span>
      </span>
    )
  }

  const open = (): void => {
    const ref: AttachmentRef = {
      id: `chat-md-image-${uri}`,
      kind: 'image',
      name,
      mime: mimeFromHref(uri),
      size: 0,
      uri,
    }
    useAgentChatStore.getState().openPreview([ref], 0)
  }

  return (
    <span ref={holderRef} className="group relative my-1 inline-block max-w-full align-top" data-testid="md-image">
      {resolved == null ? (
        <span
          role="img"
          aria-label={`${alt || name}(加载中)`}
          className="block h-24 w-40 animate-pulse rounded border border-zinc-700/50 bg-zinc-800/60"
        />
      ) : (
        <button
          type="button"
          onClick={open}
          aria-label={`放大 ${name}`}
          title="点击放大"
          className="block max-w-full cursor-zoom-in rounded border border-zinc-700/50 bg-transparent p-0"
        >
          <img
            src={resolved}
            alt={alt ?? name}
            loading="lazy"
            decoding="async"
            onError={() => setErrored(true)}
            className="block h-auto max-h-[70vh] max-w-full rounded object-contain"
          />
        </button>
      )}
      {resolved != null ? <ImageHoverActions uri={uri} name={name} /> : null}
    </span>
  )
}

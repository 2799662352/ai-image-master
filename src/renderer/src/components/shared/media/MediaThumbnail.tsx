/**
 * MediaThumbnail —— 通用媒体缩略图原语。
 *
 * 设计目标:
 *  - **零业务耦合**: 不知道 BatchItem / AttachmentRef / EraseItem 任一具体模型
 *  - **单一职责**: 渲染一张图片或视频的缩略图,处理点击
 *  - **video 的"略缩"用浏览器原生 metadata 加载**:
 *    `preload="metadata"` 让浏览器只下载首帧元数据,几乎无开销。
 *    没有外部 poster 时, Chromium / Electron 会自动用第一帧作为静止画面。
 *  - 视频角标用 SVG 三角箭头,清晰提示是可播媒体。
 *
 * 调用方负责:
 *  - 给出 `src`(可能是 `http(s)://`、`local-file://`、`blob:`、`data:`)
 *  - 自行决定 `kind`(从 mime / 扩展名推断,见 `classifyMediaKind`)
 *  - 在 `onClick` 里串接 Lightbox / 文件预览 / 下载等具体行为
 */
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useMemo } from 'react'
import { buildMediaCandidates } from './mediaFallback'
import { useMediaCandidates } from './useMediaCandidates'

export type MediaThumbnailKind = 'image' | 'video'

export interface MediaThumbnailProps {
  /**
   * 缩略图主要 URL 来源。
   * 视频时若有更轻量的封面图,优先用 `posterSrc`;否则浏览器会自行抓首帧。
   */
  src: string
  /**
   * 主源失败后依次尝试的兜底源(如:去掉数据万象参数的裸 URL、本地副本
   * `local-file:///…`)。见 `mediaFallback.ts` 顶部注释 —— 预签名 COS 链接会过期,
   * 翻墙时 COS 可能不可达,本地副本是最稳的一层。全部失败才画占位卡。
   */
  fallbackSrcs?: ReadonlyArray<string | undefined>
  kind: MediaThumbnailKind
  /** 浏览器悬浮 tooltip + alt 文本 */
  name?: string
  /** 视频专用:静态封面图(优先于浏览器自动首帧) */
  posterSrc?: string
  /**
   * 激活回调(单击 / Enter / Space 都触发同一个,业务侧不需要关心事件对象)。
   * 给空回调视为「装饰用」,鼠标不会显 cursor-pointer。
   * Lightbox / reveal 由上游组合,不在这里做任何 store 调用 —— 保持纯展示。
   */
  onClick?: () => void
  /**
   * 透传外层 div 的 className。默认尺寸 16 × 16(64 × 64 px,跟现有
   * AttachmentCard 一致),业务需要更大可直接覆盖。
   */
  className?: string
}

function PlayBadge() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex items-center justify-center"
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-black/55 backdrop-blur-sm">
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="currentColor"
          className="ml-[1px] text-white drop-shadow"
          aria-hidden="true"
        >
          <path d="M4 2.5v11l9-5.5z" />
        </svg>
      </span>
    </span>
  )
}

/**
 * 全链失败后的占位:不让浏览器画那个「裂图 + alt 文字」。同一尺寸、同一边框,
 * 中间一枚断图图标 + 「重载」。`title` 说清两种最常见的原因,用户知道该等一等
 * 还是该关代理。
 */
function BrokenPlaceholder({ name, onRetry }: { name?: string; onRetry: () => void }) {
  return (
    <span
      data-testid="media-thumbnail-broken"
      title={`${name ?? '缩略图'} 加载失败:链接已过期或网络不可达(开着代理时 COS 可能连不上)。点「重载」再试。`}
      className="flex h-full w-full flex-col items-center justify-center gap-1 bg-zinc-900/70 text-zinc-500"
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 15V6a2 2 0 0 0-2-2H8M3 9v10a2 2 0 0 0 2 2h14a2 2 0 0 0 1.4-.6M3 3l18 18M9 9a2 2 0 1 0 0 .01M21 15l-5-5L5 21" />
      </svg>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onRetry()
        }}
        className="rounded border border-zinc-700/70 px-1 font-mono text-[9px] uppercase leading-4 tracking-wider text-zinc-400 hover:border-cyan-400/50 hover:text-cyan-200"
      >
        重载
      </button>
    </span>
  )
}

export function MediaThumbnail({
  src,
  fallbackSrcs,
  kind,
  name,
  posterSrc,
  onClick,
  className,
}: MediaThumbnailProps) {
  // 候选链按内容记忆:调用方通常每次 render 都传一个新数组。
  const fallbackKey = (fallbackSrcs ?? []).join('\n')
  const candidates = useMemo(
    () => buildMediaCandidates(src, fallbackSrcs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [src, fallbackKey],
  )
  // `kind` is already 'image' | 'video' — pass through as the mime hint so
  // the resolver can disambiguate ambiguous extensions when the main-process
  // mime probe returns application/octet-stream.
  const { src: resolvedSrc, reloadKey, onError, exhausted, retry } = useMediaCandidates(candidates, kind)

  if (typeof src !== 'string' || src.length === 0) return null

  const interactive = typeof onClick === 'function'
  const containerClass = [
    'relative inline-block h-16 w-16 overflow-hidden rounded border border-zinc-700/50 bg-zinc-900/40',
    'hover:border-cyan-400/50',
    interactive ? 'cursor-pointer' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  const ariaProps = interactive
    ? { role: 'button' as const, tabIndex: 0 }
    : { role: 'img' as const }

  const activate = onClick
  const keyHandler = interactive
    ? (e: ReactKeyboardEvent<HTMLElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          activate?.()
        }
      }
    : undefined

  if (kind === 'video') {
    return (
      <div
        {...ariaProps}
        title={name}
        aria-label={name ?? 'video'}
        data-media-kind="video"
        onClick={activate}
        onKeyDown={keyHandler}
        className={containerClass}
      >
        {exhausted ? <BrokenPlaceholder name={name} onRetry={retry} /> : null}
        {resolvedSrc ? (
          <video
            key={reloadKey}
            src={resolvedSrc}
            poster={posterSrc}
            preload="metadata"
            muted
            playsInline
            controls={false}
            onError={onError}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget
              try {
                if (!posterSrc) v.currentTime = Math.min(0.1, (v.duration || 1) * 0.1)
              } catch (err) {
                if (typeof console !== 'undefined' && import.meta.env?.DEV) {
                  // eslint-disable-next-line no-console
                  console.debug('[MediaThumbnail] currentTime seek failed', err)
                }
              }
            }}
            className="block h-full w-full object-cover"
          />
        ) : null}
        {exhausted ? null : <PlayBadge />}
      </div>
    )
  }

  return (
    <div
      {...ariaProps}
      title={name}
      // 占位卡里有「重载」按钮文字;不显式给名字的话,role=button 的可访问名会
      // 从内容算成「重载」。
      aria-label={name}
      data-media-kind="image"
      onClick={activate}
      onKeyDown={keyHandler}
      className={containerClass}
    >
      {exhausted ? <BrokenPlaceholder name={name} onRetry={retry} /> : null}
      {resolvedSrc ? (
        <img
          key={reloadKey}
          src={resolvedSrc}
          alt={name ?? ''}
          loading="lazy"
          decoding="async"
          onError={onError}
          className="block h-full w-full object-cover"
        />
      ) : null}
    </div>
  )
}

/**
 * 从 AttachmentRef.kind / mime / 文件名推断要渲染的略缩图类型。
 * 给 `kind` 字段还没扩到 'video' 的老数据兜底:看 mime / 扩展名再判一次。
 *
 * 返回 null 表示既不是图也不是视频(普通文件,调用方应展示文件 chip)。
 */
const VIDEO_EXT = new Set(['mp4', 'webm', 'ogg', 'ogv', 'mov', 'm4v', 'mkv', 'avi'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'])

export function classifyMediaKind(input: {
  kind?: string
  mime?: string
  name?: string
}): MediaThumbnailKind | null {
  if (input.kind === 'image') return 'image'
  if (input.kind === 'video') return 'video'
  const mime = input.mime ?? ''
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  const name = (input.name ?? '').toLowerCase()
  const ext = name.includes('.') ? (name.split('.').pop() ?? '') : ''
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  return null
}

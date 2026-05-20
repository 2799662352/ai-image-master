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

export type MediaThumbnailKind = 'image' | 'video'

export interface MediaThumbnailProps {
  /**
   * 缩略图主要 URL 来源。
   * 视频时若有更轻量的封面图,优先用 `posterSrc`;否则浏览器会自行抓首帧。
   */
  src: string
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

export function MediaThumbnail({
  src,
  kind,
  name,
  posterSrc,
  onClick,
  className,
}: MediaThumbnailProps) {
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
        <video
          src={src}
          poster={posterSrc}
          preload="metadata"
          muted
          playsInline
          // 不显原生 controls,让略缩纯粹是张静帧 —— 想播放走 Lightbox。
          controls={false}
          // 第一帧定格用 currentTime=0.1, 0.1s 处比 0s 更稳(部分容器在 0s 帧不可解)。
          // 配 preload=metadata 后只取这一帧,不会下载整段视频。
          onLoadedMetadata={(e) => {
            const v = e.currentTarget
            try {
              if (!posterSrc) v.currentTime = Math.min(0.1, (v.duration || 1) * 0.1)
            } catch (err) {
              // Safari 早期对未定时加载抛 InvalidStateError;不影响显示,但
              // dev 里留一条线索,方便排查 codec / 容器异常。
              // eslint-disable-next-line no-console
              if (typeof console !== 'undefined' && import.meta.env?.DEV) {
                console.debug('[MediaThumbnail] currentTime seek failed', err)
              }
            }
          }}
          className="block h-full w-full object-cover"
        />
        <PlayBadge />
      </div>
    )
  }

  return (
    <div
      {...ariaProps}
      title={name}
      data-media-kind="image"
      onClick={activate}
      onKeyDown={keyHandler}
      className={containerClass}
    >
      <img
        src={src}
        alt={name ?? ''}
        loading="lazy"
        decoding="async"
        className="block h-full w-full object-cover"
      />
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

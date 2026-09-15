import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { MediaThumbnailKind } from '../../../components/shared/media/MediaThumbnail'
import { MediaThumbWithPoster } from '../MediaThumbWithPoster'
import { probeImageAlpha } from './alphaProbe'

interface MediaTileProps {
  id: string
  /** Element src (thumbnail for images, full url for videos). */
  src: string
  /** Ordered fallbacks when `src` fails (raw uri without CI params, local copies). */
  fallbackSrcs?: ReadonlyArray<string | undefined>
  /** Original media uri — what 下载 saves and what the alpha probe reads. */
  uri: string
  thumbnailUri?: string
  kind: MediaThumbnailKind
  name: string
  mime?: string
  onOpen: () => void
}

/**
 * One result/attachment tile (design D5). Hover reveals two frosted-glass
 * buttons —「编辑」bottom-left (opens the lightbox, where the D4 tools live)
 * and「下载」bottom-right (shell save-as of the original). Images with an alpha
 * channel sit on the drawer's dark base with a small ALPHA badge instead of a
 * checkerboard; the checkerboard is an opt-in check (top-left toggle).
 */
export function MediaTile(props: MediaTileProps): JSX.Element {
  const [alpha, setAlpha] = useState(false)
  const [checker, setChecker] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (props.kind !== 'image') {
      setAlpha(false)
      return undefined
    }
    void probeImageAlpha(props.src, props.mime).then((has) => {
      if (!cancelled) setAlpha(has)
    })
    return () => {
      cancelled = true
    }
  }, [props.src, props.mime, props.kind])

  const download = (): void => {
    const shell = (window as Window & { electronAPI?: { shell?: { saveAs?: (uri: string, name: string) => Promise<unknown> } } })
      .electronAPI?.shell
    void shell?.saveAs?.(props.uri, props.name)
  }

  return (
    <div
      data-testid={`media-tile-${props.id}`}
      className={[
        'group relative inline-block rounded border border-zinc-700/50',
        alpha ? (checker ? 'checker' : 'bg-zinc-900/40') : '',
      ].join(' ')}
    >
      <MediaThumbWithPoster
        src={props.src}
        fallbackSrcs={props.fallbackSrcs}
        videoUri={props.uri}
        thumbnailUri={props.thumbnailUri}
        kind={props.kind}
        name={props.name}
        onClick={props.onOpen}
        className={alpha ? 'bg-transparent' : undefined}
      />
      {alpha ? (
        <>
          <span className="pointer-events-none absolute right-0.5 top-0.5 rounded border border-cyan-400/40 bg-zinc-950/70 px-1 py-px font-mono text-[8px] uppercase tracking-wider text-cyan-200">
            alpha
          </span>
          <button
            type="button"
            aria-label="棋盘格核对透明度"
            aria-pressed={checker}
            title={checker ? '关闭棋盘格' : '棋盘格核对透明度'}
            onClick={(e) => {
              e.stopPropagation()
              setChecker((v) => !v)
            }}
            className={[
              'absolute left-0.5 top-0.5 inline-flex h-4 w-4 items-center justify-center rounded border text-[9px] leading-none transition-opacity',
              checker
                ? 'border-cyan-400/60 bg-cyan-400/20 text-cyan-100 opacity-100'
                : 'border-zinc-700/60 bg-zinc-950/70 text-zinc-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
            ].join(' ')}
          >
            ▦
          </button>
        </>
      ) : null}
      <button
        type="button"
        aria-label={`编辑 ${props.name}`}
        title="在灯箱里标注 / 评论 / 擦除"
        onClick={(e) => {
          e.stopPropagation()
          props.onOpen()
        }}
        className="glassbtn absolute bottom-1 left-1 flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
        编辑
      </button>
      <button
        type="button"
        aria-label={`下载 ${props.name}`}
        title="另存为…"
        onClick={(e) => {
          e.stopPropagation()
          download()
        }}
        className="glassbtn absolute bottom-1 right-1 inline-flex h-5 w-5 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
      </button>
    </div>
  )
}

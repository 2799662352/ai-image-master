import { HTMLContainer, Rectangle2d, ShapeUtil, T, type RecordProps, type TLShape } from 'tldraw'
import React from 'react'
import { toStreamableUri } from '../../file-explorer/uri'
import { CANVAS_INLINE_ASSET_MAX_CHARS } from './canvasAssetUrl'

/**
 * Custom tldraw shape: a proper CARD for files tldraw cannot render natively
 * (audio / zip / pdf / arbitrary docs). Replaces the old grey text-note
 * placeholder from insertFilePlaceholder — same data (kind/title/assetPath),
 * but rendered as a styled card with an icon, filename, extension badge and
 * the on-disk path, plus an inline <audio> player when the src is loadable.
 * The agent-facing contract is unchanged: `meta.assetPath` still carries the
 * real disk path, and summarizeShape surfaces title/path in canvas_snapshot.
 */
interface FileCardShapeProps {
  w: number
  h: number
  kind: 'audio' | 'file'
  title: string
  assetPath: string
  assetUrl: string
}

// tldraw 5.2 custom-shape registration: props go through module augmentation
// of TLGlobalShapePropsMap so 'file-card' becomes part of the TLShape union
// (the old `TLBaseShape<'file-card', …>` pattern no longer satisfies TLShape).
declare module 'tldraw' {
  export interface TLGlobalShapePropsMap {
    'file-card': FileCardShapeProps
  }
}

export type FileCardShape = TLShape<'file-card'>

/** Src schemes an <audio> element can load directly, without IPC resolution. */
function isDirectlyPlayableSrc(src: string): boolean {
  return (
    src.startsWith('blob:') ||
    src.startsWith('http:') ||
    src.startsWith('https:') ||
    src.startsWith('local-file://')
  )
}

/**
 * Inline player src. Disk paths use the same streamable `local-file://media/`
 * URI as VideoViewer / AudioViewer — never attachments.readThumb → blob.
 * Huge `data:` URLs are refused (that is the canvas OOM path).
 */
function audioSrcFromCard(kind: 'audio' | 'file', assetUrl: string, assetPath: string): string | null {
  if (kind !== 'audio') return null
  if (assetUrl.startsWith('data:') && assetUrl.length > CANVAS_INLINE_ASSET_MAX_CHARS) {
    return assetPath ? toStreamableUri(assetPath) : null
  }
  if (isDirectlyPlayableSrc(assetUrl)) return assetUrl
  if (assetPath) return toStreamableUri(assetPath)
  return null
}

function fileExt(title: string): string {
  const dot = title.lastIndexOf('.')
  return dot > 0 && dot < title.length - 1 ? title.slice(dot + 1).toUpperCase() : ''
}

// Plain ShapeUtil (not BaseBoxShapeUtil): in tldraw 5.2 `TLBaseBoxShape` is an
// Extract<> over the BUILT-IN shape union, so custom TLBaseShape types no
// longer satisfy its generic constraint. The card is fixed-size, so we only
// need getGeometry + getIndicatorPath anyway.
export class FileCardShapeUtil extends ShapeUtil<FileCardShape> {
  static override type = 'file-card' as const
  static override props: RecordProps<FileCardShape> = {
    w: T.number,
    h: T.number,
    kind: T.literalEnum('audio', 'file'),
    title: T.string,
    assetPath: T.string,
    assetUrl: T.string,
  }

  override getDefaultProps(): FileCardShape['props'] {
    return { w: 320, h: 96, kind: 'file', title: 'file', assetPath: '', assetUrl: '' }
  }

  override canEdit(): boolean {
    return false
  }

  override getGeometry(shape: FileCardShape): Rectangle2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  override component(shape: FileCardShape): React.JSX.Element {
    const { kind, title, assetPath, assetUrl, w, h } = shape.props
    // tldraw invokes component() inside a per-shape React wrapper, so hooks
    // are legal here (same pattern as the official interactive-shape examples).
    const audioSrc = audioSrcFromCard(kind, assetUrl, assetPath)
    const ext = fileExt(title)
    return (
      <HTMLContainer
        style={{
          width: w,
          height: h,
          pointerEvents: 'all',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 6,
          padding: '10px 14px',
          borderRadius: 12,
          background: 'linear-gradient(135deg, rgba(24,24,27,0.95), rgba(39,39,42,0.95))',
          border: '1px solid rgba(103,232,249,0.35)',
          boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
          color: '#e4e4e7',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span style={{ fontSize: 22, flexShrink: 0 }} aria-hidden>
            {kind === 'audio' ? '🎵' : '📎'}
          </span>
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
              flex: 1,
            }}
            title={title}
          >
            {title}
          </span>
          {ext ? (
            <span
              style={{
                flexShrink: 0,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.05em',
                padding: '2px 6px',
                borderRadius: 6,
                background: 'rgba(103,232,249,0.15)',
                color: '#67e8f9',
              }}
            >
              {ext}
            </span>
          ) : null}
        </div>
        {assetPath ? (
          <div
            style={{
              fontSize: 10,
              color: '#a1a1aa',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              direction: 'rtl',
              textAlign: 'left',
            }}
            title={assetPath}
          >
            {assetPath}
          </div>
        ) : null}
        {audioSrc ? (
          <audio
            controls
            src={audioSrc}
            style={{ width: '100%', height: 30 }}
            // Keep pointer events on the player so the controls are usable while
            // the surrounding card still drags/selects like a normal shape.
            onPointerDown={(e) => e.stopPropagation()}
          />
        ) : null}
      </HTMLContainer>
    )
  }

  // tldraw 5.2: selection indicators are Path2D-based (SVG `indicator()` is gone).
  override getIndicatorPath(shape: FileCardShape): Path2D {
    const path = new Path2D()
    path.roundRect(0, 0, shape.props.w, shape.props.h, 12)
    return path
  }
}

/** Custom shape utils to pass to <Tldraw shapeUtils={…}> (extends the schema). */
export const canvasShapeUtils = [FileCardShapeUtil]

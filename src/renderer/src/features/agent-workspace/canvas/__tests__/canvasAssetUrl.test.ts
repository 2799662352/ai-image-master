import { describe, expect, it } from 'vitest'
import {
  CANVAS_INLINE_ASSET_MAX_CHARS,
  osPathFromCanvasAssetUrl,
  stripSnapshotAssetBytes,
  toCanvasAssetUrl,
} from '../canvasAssetUrl'

describe('toCanvasAssetUrl', () => {
  it('turns a Windows image path into local-file:// (no IPC / no data: URL)', () => {
    expect(toCanvasAssetUrl('D:\\work\\shot.png')).toBe('local-file:///D%3A/work/shot.png')
    expect(toCanvasAssetUrl('D:/work/shot.png')).toBe('local-file:///D%3A/work/shot.png')
  })

  it('turns a video/audio path into the streamable media host (Range-capable)', () => {
    expect(toCanvasAssetUrl('D:/clips/out.mp4')).toBe(
      `local-file://media/?p=${encodeURIComponent('D:/clips/out.mp4')}`,
    )
    expect(toCanvasAssetUrl('C:\\theme.mp3')).toBe(
      `local-file://media/?p=${encodeURIComponent('C:\\theme.mp3')}`,
    )
  })

  it('passes through already-loadable URLs without wrapping', () => {
    expect(toCanvasAssetUrl('https://cdn.example/a.png')).toBe('https://cdn.example/a.png')
    expect(toCanvasAssetUrl('blob:http://localhost/abc')).toBe('blob:http://localhost/abc')
    expect(toCanvasAssetUrl('local-file:///D%3A/a.png')).toBe('local-file:///D%3A/a.png')
  })

  it('never emits a data: URL for a disk path', () => {
    expect(toCanvasAssetUrl('D:/huge.mp4').startsWith('data:')).toBe(false)
    expect(toCanvasAssetUrl('D:/huge.png').includes('base64')).toBe(false)
  })
})

describe('osPathFromCanvasAssetUrl', () => {
  // get_canvas_video must hand the agent a real openable path. Now that assets
  // carry local-file URLs instead of data: bytes, the path is recoverable
  // directly — no export/materialize round-trip.
  it('round-trips a media (video/audio) URL back to its OS path', () => {
    expect(osPathFromCanvasAssetUrl(toCanvasAssetUrl('D:/clips/out.mp4'))).toBe('D:/clips/out.mp4')
    expect(osPathFromCanvasAssetUrl(toCanvasAssetUrl('C:/My Pics/a b.mp3'))).toBe('C:/My Pics/a b.mp3')
  })

  it('round-trips an image URL back to its OS path', () => {
    expect(osPathFromCanvasAssetUrl(toCanvasAssetUrl('D:/work/shot.png'))).toBe('D:/work/shot.png')
  })

  it('returns null for non-local schemes and for traversal attempts', () => {
    expect(osPathFromCanvasAssetUrl('https://x.com/a.mp4')).toBeNull()
    expect(osPathFromCanvasAssetUrl('data:video/mp4;base64,AAA')).toBeNull()
    expect(osPathFromCanvasAssetUrl('blob:abc')).toBeNull()
    expect(osPathFromCanvasAssetUrl('local-file://media/?p=D%3A/a/../../etc/passwd')).toBeNull()
  })
})

describe('stripSnapshotAssetBytes', () => {
  it('rewrites huge data: asset src to the local-file URL from meta.assetPath', () => {
    const huge = `data:image/png;base64,${'A'.repeat(CANVAS_INLINE_ASSET_MAX_CHARS + 1)}`
    const snapshot = {
      document: {
        store: {
          'asset:1': {
            typeName: 'asset',
            type: 'image',
            props: { src: huge, w: 10, h: 10 },
            meta: { assetPath: 'D:/work/shot.png' },
          },
        },
      },
    }
    const out = stripSnapshotAssetBytes(snapshot) as typeof snapshot
    expect(out.document.store['asset:1'].props.src).toBe('local-file:///D%3A/work/shot.png')
    expect(out.document.store['asset:1'].props.src.startsWith('data:')).toBe(false)
    // Input must not be mutated — checkpoint IPC must send the stripped copy.
    expect(snapshot.document.store['asset:1'].props.src.startsWith('data:')).toBe(true)
  })

  it('blanks a huge data: src that has no disk path (drop the bytes, keep the record)', () => {
    const huge = `data:video/mp4;base64,${'B'.repeat(CANVAS_INLINE_ASSET_MAX_CHARS + 1)}`
    const snapshot = {
      document: {
        store: {
          'asset:v': {
            typeName: 'asset',
            type: 'video',
            props: { src: huge },
            meta: {},
          },
        },
      },
    }
    const out = stripSnapshotAssetBytes(snapshot) as typeof snapshot
    expect(out.document.store['asset:v'].props.src).toBe('')
  })

  it('leaves short data: URLs and local-file srcs alone', () => {
    const snapshot = {
      document: {
        store: {
          'asset:ok': {
            typeName: 'asset',
            props: { src: 'data:image/png;base64,QUJD' },
            meta: {},
          },
        },
      },
    }
    const out = stripSnapshotAssetBytes(snapshot) as typeof snapshot
    expect(out.document.store['asset:ok'].props.src).toBe('data:image/png;base64,QUJD')
  })
})

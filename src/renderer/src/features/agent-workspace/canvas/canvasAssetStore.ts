import { CANVAS_INLINE_ASSET_MAX_CHARS, toCanvasAssetUrl } from './canvasAssetUrl'

/**
 * tldraw asset store for the embedded canvas.
 *
 * tldraw's DEFAULT store converts every dropped file into a `data:` URL and
 * persists it (its own docs call that "prototyping only"). With a
 * `persistenceKey` those bytes land in IndexedDB, and re-opening the canvas
 * rehydrates all of them into the renderer at once — that is the OOM that made
 * Electron relaunch the app.
 *
 * Here a file becomes a PATH, never bytes: `local-file://` for images and
 * `local-file://media/?p=` for video/audio (Range-capable streaming, same
 * contract as the file-explorer viewers and the video workbench).
 */

export interface CanvasAssetStoreDeps {
  /** OS path for a dropped File (webUtils.getPathForFile), else a persisted copy. */
  resolveDiskPath: (file: File, threadId: string) => Promise<string | undefined>
  getThreadId: () => string | undefined
  createObjectURL?: (file: File) => string
}

export interface CanvasAssetStore {
  upload: (asset: unknown, file: File) => Promise<{ src: string }>
  resolve: (asset: unknown) => string | null
}

export function makeCanvasAssetStore(deps: CanvasAssetStoreDeps): CanvasAssetStore {
  const createObjectURL = deps.createObjectURL ?? ((file: File) => URL.createObjectURL(file))
  return {
    async upload(_asset, file) {
      let diskPath: string | undefined
      try {
        diskPath = await deps.resolveDiskPath(file, deps.getThreadId() ?? '')
      } catch {
        diskPath = undefined
      }
      if (diskPath) return { src: toCanvasAssetUrl(diskPath) }
      // Clipboard/synthetic files have no OS path and may be too big or of a
      // mime the copy IPC refuses. An object URL keeps the shape usable for
      // this session; a data: URL would poison the persisted store forever.
      return { src: createObjectURL(file) }
    },

    resolve(asset) {
      const path = (asset as { meta?: { assetPath?: unknown } })?.meta?.assetPath
      if (typeof path === 'string' && path) return toCanvasAssetUrl(path)
      const src = (asset as { props?: { src?: unknown } })?.props?.src
      if (typeof src !== 'string' || !src) return null
      // A record written by the v1 store can still carry inline bytes. Refuse
      // them rather than paying the memory to display one.
      if (src.startsWith('data:') && src.length > CANVAS_INLINE_ASSET_MAX_CHARS) return null
      return src
    },
  }
}

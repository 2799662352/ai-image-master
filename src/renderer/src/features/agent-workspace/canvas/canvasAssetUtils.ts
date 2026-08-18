import { ImageAssetUtil, T, VideoAssetUtil, defaultAssetUtils, imageAssetProps, videoAssetProps } from 'tldraw'

/**
 * tldraw asset schema for the embedded canvas: same as stock, except an asset
 * `src` may also be one of OUR two protocols.
 *
 * Why this is needed: tldraw's built-in `T.srcUrl` allowlist is
 * `http: | https: | data: | asset:` (`@tldraw/validate`, `validSrcProtocols`).
 * `asset:` means "bytes in tldraw's own IndexedDB store" — exactly the thing
 * `canvasAssetStore` refuses to do, because rehydrating those bytes on canvas
 * open is what OOM-crashed the renderer and made Electron relaunch the app.
 * Our store therefore writes a PATH instead:
 *   - `local-file:///D%3A/…`      images (custom standard scheme, protocolHandler.ts)
 *   - `local-file://media/?p=…`   video/audio (Range-capable streaming)
 *   - `blob:…`                    last resort for a clipboard File with no disk path
 *
 * Neither is in the stock allowlist, so `store.put` threw "Expected a valid
 * url" on EVERY image/video insert (drag-drop, agent `insert_image_into_holder`,
 * `create_image_version`, workspace-tree drop) and unmounted the tldraw tree.
 * Relaxing the validator is tldraw's own documented extension point: an
 * `AssetUtil` subclass may override `static props`, and `createTLStore` builds
 * the asset record validator from whatever the registered utils declare.
 *
 * This stays an ALLOWLIST — `file:`, `javascript:` and friends are still
 * rejected, and everything that is not one of our two prefixes is delegated to
 * `T.srcUrl` so we inherit any future tldraw tightening for free.
 */

const CANVAS_SRC_PREFIXES = ['local-file://', 'blob:'] as const

export const canvasSrcUrl = T.string.check('canvas-src', (value) => {
  if (CANVAS_SRC_PREFIXES.some((prefix) => value.startsWith(prefix))) return
  T.srcUrl.validate(value)
})

class CanvasImageAssetUtil extends ImageAssetUtil {
  static override props = { ...imageAssetProps, src: canvasSrcUrl.nullable() }
}

class CanvasVideoAssetUtil extends VideoAssetUtil {
  static override props = { ...videoAssetProps, src: canvasSrcUrl.nullable() }
}

/**
 * Full util list (tldraw defaults with image/video replaced). Passed both to
 * `<Tldraw assetUtils>` — where tldraw's own merge is a no-op on an already
 * complete list — and to `createTLStore` in headless tests, which does NOT add
 * the defaults back.
 */
const OVERRIDDEN_ASSET_TYPES = new Set(['image', 'video'])

export const canvasAssetUtils = [
  ...defaultAssetUtils.filter((util) => !OVERRIDDEN_ASSET_TYPES.has(util.type)),
  CanvasImageAssetUtil,
  CanvasVideoAssetUtil,
]

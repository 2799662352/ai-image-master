import { getSnapshot, loadSnapshot, type Editor } from 'tldraw'
import type { CanvasStatePayload } from '../../../../../types/canvas'
import { createHolder, createImageVersion, insertImageAt, insertImageIntoHolder, insertVideo, listImageShapes, readCanvasState, summarizeShape } from './shapeOps'
import { executeCanvasCode, searchEditorApi } from './shapeExec'
import { parseAnnotations } from './annotationParser'
import { editPrompt, findPreferredHolder, generationPrompt, holderSize } from './promptBuilders'

type AttachmentsApi = { readThumb: (p: string) => Promise<{ ok: true; base64: string; mime: string } | { ok: false; reason: string }> }

const BASE_STATE: CanvasStatePayload = {
  canvasId: 'catimation-canvas',
  metadata: { canvasId: 'catimation-canvas', name: 'CATIMATION Canvas', createdAt: '', updatedAt: '', workspaceRoot: '', activePageId: 'page:main', appVersion: '1' },
  storagePath: '',
  selection: { canvasId: 'catimation-canvas', pageId: 'page:main', selectedShapeIds: [], shapes: [] },
  shapes: [],
}

type AttachmentsSaveApi = {
  save?: (a: { threadId: string; name: string; mime: string; base64: string }) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>
}

type CanvasCheckpointApi = {
  saveCheckpoint?: (a: { name?: string; snapshotJson: string; shapeCount?: number }) => Promise<{ ok: true; checkpointId: string; path: string } | { ok: false; reason: string }>
  readCheckpoint?: (a: { checkpointId: string }) => Promise<{ ok: true; checkpointId: string; json: string } | { ok: false; reason: string }>
  listCheckpoints?: () => Promise<Array<{ checkpointId: string; name: string; createdAt: string; shapeCount: number; path: string }>>
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = String(reader.result)
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('blob read failed'))
    reader.readAsDataURL(blob)
  })
}

/**
 * Normalize an image src to raw base64 + mime. Only data:/blob:/http(s) are
 * fetchable — tldraw exposes managed assets as opaque `asset:<id>` URLs that are
 * NOT real URLs (fetching them throws and violates the connect-src CSP), so we
 * reject any other scheme and let callers rasterize the shape instead.
 */
export async function srcToBase64(src: string): Promise<{ mime: string; base64: string } | null> {
  if (src.startsWith('data:')) {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(src)
    if (match) return { mime: match[1] || 'image/png', base64: match[2] }
    return null
  }
  if (!src.startsWith('blob:') && !src.startsWith('http:') && !src.startsWith('https:')) {
    return null
  }
  try {
    const resp = await fetch(src)
    const blob = await resp.blob()
    return { mime: blob.type || 'image/png', base64: await blobToBase64(blob) }
  } catch {
    return null
  }
}

class CanvasBridge {
  private editor: Editor | null = null
  private waiters: Array<(editor: Editor) => void> = []

  setEditor(editor: Editor | null): void {
    this.editor = editor
    if (editor) {
      const pending = this.waiters
      this.waiters = []
      for (const resolve of pending) resolve(editor)
    }
  }

  /** Resolve once the Canvas tab has mounted its tldraw editor (or reject on timeout). */
  waitForEditor(timeoutMs = 8000): Promise<Editor> {
    if (this.editor) return Promise.resolve(this.editor)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== onReady)
        reject(new Error('Canvas did not open in time. Open the Canvas tab in Agent Workspace and retry.'))
      }, timeoutMs)
      const onReady = (editor: Editor): void => {
        clearTimeout(timer)
        resolve(editor)
      }
      this.waiters.push(onReady)
    })
  }

  private requireEditor(): Editor {
    if (!this.editor) throw new Error('Canvas is not open. Ask the user to open the Canvas tab, or call canvas_open first.')
    return this.editor
  }

  /**
   * Wrap a canvas-mutating operation so a tldraw validation/transaction error is
   * returned to Codex as structured data instead of escaping the bridge. Before
   * this, a rejected shape (bad meta / unknown prop) threw out of the tool call;
   * combined with a half-written store it crashed the tldraw React tree, which
   * unmounted the editor (CanvasSection cleanup nulled it) and bricked the whole
   * canvas — every subsequent tool then failed with "Canvas is not open". Here we
   * deliberately KEEP the editor mounted (never null it) and report the failure,
   * mirroring tldraw mcp-app's tool-error reporting. Pairs with the atomic
   * editor.run writes in shapeOps so a caught failure also left no partial state.
   */
  private async safeWrite<T>(tool: string, fn: () => Promise<T> | T): Promise<T | { ok: false; failed: true; tool: string; error: string }> {
    try {
      return await fn()
    } catch (err) {
      return { ok: false, failed: true, tool, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private state(): CanvasStatePayload {
    return readCanvasState(this.requireEditor(), BASE_STATE)
  }

  /** Resolve a local file path (or data/http URL) to a browser-loadable src. */
  private async toLoadable(pathOrUrl: string): Promise<string> {
    if (pathOrUrl.startsWith('data:') || pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) return pathOrUrl
    const api = (window as Window & { electronAPI?: { attachments?: AttachmentsApi } }).electronAPI?.attachments
    if (!api?.readThumb) throw new Error('attachments API unavailable to load image')
    const res = await api.readThumb(pathOrUrl)
    if (!res.ok) throw new Error(`Cannot read image ${pathOrUrl}: ${res.reason}`)
    return `data:${res.mime};base64,${res.base64}`
  }

  /**
   * Drop a workspace file onto the canvas at a page point. Used by the Canvas
   * tab's native drop handler when the user drags a file from the file-explorer
   * tree (custom MIME → a disk path, NOT an OS File). Routes by extension to a
   * standalone image or a video shape; non-media files are reported back so the
   * UI can flash "only images/videos". Extension is checked BEFORE touching the
   * editor so a stray .txt drop is a cheap no-op.
   */
  async insertFileAt(path: string, point: { x: number; y: number }): Promise<{ ok: true; kind: 'image' | 'video' } | { ok: false; reason: string }> {
    const lower = path.toLowerCase()
    const isVideo = /\.(mp4|webm|mov|m4v|mkv|ogg|ogv)$/.test(lower)
    const isImage = /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico)$/.test(lower)
    if (!isVideo && !isImage) return { ok: false, reason: 'unsupported' }
    const editor = this.requireEditor()
    const assetUrl = await this.toLoadable(path)
    const title = path.split(/[\\/]/).pop() || 'file'
    const res = isVideo
      ? await this.safeWrite('insert_video', () => insertVideo(editor, { assetUrl, assetPath: path, x: point.x, y: point.y, title }))
      : await this.safeWrite('insert_image_at', () => insertImageAt(editor, { assetUrl, assetPath: path, x: point.x, y: point.y, title }))
    if (res && typeof res === 'object' && 'failed' in (res as Record<string, unknown>)) {
      return { ok: false, reason: String((res as { error?: string }).error ?? 'write failed') }
    }
    return { ok: true, kind: isVideo ? 'video' : 'image' }
  }

  async handle(toolName: string, params: Record<string, unknown>): Promise<unknown> {
    switch (toolName) {
      case 'canvas_open':
        return { opened: true }
      case 'prepare_image_generation': {
        const editor = this.requireEditor()
        return this.safeWrite('prepare_image_generation', () => {
          const aspectRatio = String(params.aspectRatio ?? '5:7')
          let holder = findPreferredHolder(this.state())
          if (!holder) {
            const size = holderSize(aspectRatio)
            const created = createHolder(editor, { label: params.label, aspectRatio, ...size })
            holder = this.state().shapes.find((s) => s.id === created.shapeId)
          }
          return {
            readyToGenerate: true,
            holderShapeId: holder?.id,
            holderBounds: holder?.bounds,
            aspectRatio: holder?.aspectRatio ?? aspectRatio,
            suggestedPrompt: generationPrompt({ request: String(params.request ?? ''), aspectRatio: holder?.aspectRatio ?? aspectRatio, intendedUse: params.intendedUse as string | undefined }),
          }
        })
      }
      case 'create_image_holder': {
        const editor = this.requireEditor()
        return this.safeWrite('create_image_holder', () => createHolder(editor, params))
      }
      case 'insert_image_into_holder': {
        const editor = this.requireEditor()
        const assetUrl = await this.toLoadable(String(params.imagePath))
        return this.safeWrite('insert_image_into_holder', () => insertImageIntoHolder(editor, { holderShapeId: String(params.holderShapeId), assetUrl, assetPath: String(params.imagePath), title: params.title as string | undefined }))
      }
      case 'insert_video': {
        const editor = this.requireEditor()
        // Reuse toLoadable: a disk path → data: URL via the mime-gated attachments
        // IPC (its whitelist already allows video/*), so the video shape gets a
        // browser-playable src without tripping the connect-src CSP.
        const assetUrl = await this.toLoadable(String(params.videoPath))
        return this.safeWrite('insert_video', () =>
          insertVideo(editor, {
            assetUrl,
            assetPath: String(params.videoPath),
            title: params.title as string | undefined,
            x: typeof params.x === 'number' ? params.x : undefined,
            y: typeof params.y === 'number' ? params.y : undefined,
            w: typeof params.w === 'number' ? params.w : undefined,
            h: typeof params.h === 'number' ? params.h : undefined,
            mimeType: params.mimeType as string | undefined,
          }),
        )
      }
      case 'collect_annotations':
        return parseAnnotations({ state: this.state(), targetShapeId: params.targetShapeId as string | undefined, radius: Number(params.radius ?? 420) })
      case 'prepare_annotation_edit': {
        const plan = parseAnnotations({ state: this.state(), targetShapeId: params.targetShapeId as string | undefined, radius: Number(params.radius ?? 420) })
        return { ...plan, editPrompt: editPrompt({ userRequest: params.userRequest as string | undefined, annotations: plan.annotationPlan }) }
      }
      case 'create_image_version': {
        const editor = this.requireEditor()
        const assetUrl = await this.toLoadable(String(params.imagePath))
        return this.safeWrite('create_image_version', () => createImageVersion(editor, { sourceShapeId: String(params.sourceShapeId), assetUrl, assetPath: String(params.imagePath), title: params.title as string | undefined }))
      }
      case 'save_snapshot': {
        // tldraw persistenceKey already persists; reading state flushes listeners.
        // Per the product owner ("暴露地址就好,像这里上传一样") we ALSO export a PNG of
        // the canvas to disk and hand back its absolute path, so the saved state
        // has a real, openable address like an uploaded attachment. (A fully
        // restorable .tldr JSON checkpoint is deferred — attachments:save only
        // accepts image/* | video/* mimes, so JSON needs a new file-write IPC.)
        const snap = await this.snapshot(typeof params.threadId === 'string' ? params.threadId : undefined)
        return { ok: true, imagePath: snap.imagePath, shapeCount: snap.shapeCount }
      }
      case 'save_checkpoint':
        // Serialize the whole editor store (getSnapshot) to a restorable JSON
        // file on disk and return its checkpointId/path. A "fork" point.
        return this.saveCheckpoint(typeof params.name === 'string' ? params.name : undefined)
      case 'load_checkpoint':
        // Restore the canvas to a saved checkpoint (loadSnapshot). Destructive:
        // replaces current canvas content.
        return this.loadCheckpoint(String(params.checkpointId ?? ''))
      case 'list_checkpoints':
        // Read-only: enumerate saved checkpoints (id/name/createdAt/shapeCount).
        return this.listCheckpoints()
      case 'canvas_exec':
        // Escape hatch: run model JS on the live editor (gap §4.B). Intentionally
        // UNRESTRICTED per product owner. executeCanvasCode catches throws and
        // returns { success,error } so a bad snippet never crashes the canvas.
        return executeCanvasCode(this.requireEditor(), String(params.code ?? ''))
      case 'canvas_search':
        // Read-only: query the curated Editor API spec to discover methods/shape
        // types/helpers for canvas_exec. Needs no editor.
        return searchEditorApi(String(params.code ?? ''))
      case 'canvas_snapshot':
        // threadId is injected by the renderer caller (AgentToolExecutor) from the
        // active chat thread so the snapshot PNG can be persisted (FK requirement).
        return this.snapshot(typeof params.threadId === 'string' ? params.threadId : undefined)
      case 'list_canvas_images':
        // Read-only flat index of image shapes (borrowed from sora-canvas-mcp):
        // lets Codex pick a shapeId before paying any get_canvas_image cost.
        return listImageShapes(this.requireEditor())
      case 'get_canvas_image':
        // Fetch ONE image by shapeId: focused metadata + an on-disk PNG path Codex
        // can open. threadId (renderer-injected) is required to persist the export.
        return this.getCanvasImage(String(params.shapeId ?? ''), typeof params.threadId === 'string' ? params.threadId : undefined)
      default:
        throw new Error(`Unknown canvas tool: ${toolName}`)
    }
  }

  /**
   * Let the agent SEE the canvas: returns a structured shape list plus a rendered
   * PNG of the whole page saved to disk (absolute path), so Codex can open/view
   * the actual pixels instead of only reading annotations. Mirrors the tldraw
   * mcp-app live-read idea, adapted to our ToolRouter/IPC + Codex's ability to
   * read image files. The PNG export goes through tldraw's rasterizer (resolves
   * `asset:` refs internally), so it never hits the connect-src CSP.
   */
  async snapshot(threadId?: string): Promise<{
    shapeCount: number
    shapes: CanvasStatePayload['shapes']
    selection: string[]
    imagePath?: string
  }> {
    const editor = this.requireEditor()
    const state = this.state()
    let imagePath: string | undefined
    const ids = Array.from(editor.getCurrentPageShapeIds()) as never[]
    // The PNG is persisted via the thread-scoped attachments store, whose DB row
    // has a threadId foreign key. Passing a non-existent id (the old literal
    // 'canvas') violates AgentAttachment_threadId_fkey and the file is dropped.
    // Only save when we have the real active thread; otherwise still return the
    // structured shapes so Codex isn't left totally blind.
    if (ids.length > 0 && threadId) {
      const exported = await editor.toImageDataUrl(ids, { format: 'png', background: true })
      const decoded = exported?.url ? await srcToBase64(exported.url) : null
      const api = (window as Window & { electronAPI?: { attachments?: AttachmentsSaveApi } }).electronAPI?.attachments
      if (decoded && api?.save) {
        const ext = decoded.mime === 'image/jpeg' ? 'jpg' : decoded.mime.split('/')[1] || 'png'
        const res = await api.save({
          threadId,
          name: `canvas-snapshot-${Date.now()}.${ext}`,
          mime: decoded.mime,
          base64: decoded.base64,
        })
        if (res.ok) imagePath = res.path
      }
    }
    return {
      shapeCount: state.shapes.length,
      shapes: state.shapes,
      selection: state.selection.selectedShapeIds,
      imagePath,
    }
  }

  /**
   * Fetch ONE image shape addressed by shapeId (the `get_canvas_image` half of
   * the list→fetch pattern borrowed from sora-canvas-mcp). Returns focused
   * metadata (assetId, on-canvas + intrinsic dimensions, src) PLUS an on-disk
   * PNG path Codex can open as a clean reference image — the export reuses
   * exportTargetImageFile (rasterizes via tldraw, annotations excluded,
   * CSP-safe). Unlike sora's inline base64 image block, we return a file path to
   * stay within our JSON-only MCP plumbing and avoid echoing multi-MB base64
   * into the model context. Returns a structured `{ ok:false, error }` rather
   * than throwing so a bad shapeId never escapes to crash the canvas.
   */
  async getCanvasImage(
    shapeId: string,
    threadId?: string,
  ): Promise<
    | { ok: true; shapeId: string; assetId: string | null; w: number; h: number; imageWidth?: number; imageHeight?: number; mimeType: string; assetPath: string | null; assetUrl: string | null; imagePath?: string }
    | { ok: false; error: string }
  > {
    if (!shapeId) return { ok: false, error: 'get_canvas_image requires shapeId (get it from list_canvas_images).' }
    const editor = this.requireEditor()
    const shape = editor.getShape(shapeId as never) as { type?: string } | undefined
    if (!shape) return { ok: false, error: `No shape found: ${shapeId}` }
    if (shape.type !== 'image') return { ok: false, error: `Shape ${shapeId} is a "${shape.type}", not an image.` }
    const summary = summarizeShape(editor, shape)
    const imagePath = threadId ? await this.exportTargetImageFile(shapeId, threadId) : undefined
    return {
      ok: true,
      shapeId,
      assetId: summary.assetId ?? null,
      w: Math.round(summary.bounds.w),
      h: Math.round(summary.bounds.h),
      imageWidth: summary.imageWidth,
      imageHeight: summary.imageHeight,
      mimeType: 'image/png',
      assetPath: summary.assetPath ?? null,
      assetUrl: summary.assetUrl ?? null,
      imagePath,
    }
  }

  private canvasApi(): CanvasCheckpointApi | undefined {
    return (window as Window & { electronAPI?: { canvas?: CanvasCheckpointApi } }).electronAPI?.canvas
  }

  /**
   * Save a restorable checkpoint of the WHOLE editor store (gap-analysis §8/§9).
   * Uses tldraw's native `getSnapshot(editor.store)` → `{ document, session }`
   * JSON, persisted to disk via the dedicated `canvas:save-checkpoint` IPC
   * (attachments:save is image/video only). Each save is a "fork" point you can
   * `load_checkpoint` back to. Returns `{ ok:false, error }` rather than throwing.
   */
  async saveCheckpoint(name?: string): Promise<{ ok: true; checkpointId: string; path: string; shapeCount: number } | { ok: false; error: string }> {
    const editor = this.requireEditor()
    const api = this.canvasApi()
    if (!api?.saveCheckpoint) return { ok: false, error: 'canvas checkpoint API unavailable' }
    const shapeCount = editor.getCurrentPageShapeIds().size
    const snapshotJson = JSON.stringify(getSnapshot(editor.store))
    const res = await api.saveCheckpoint({ name, snapshotJson, shapeCount })
    if (!res.ok) return { ok: false, error: res.reason }
    return { ok: true, checkpointId: res.checkpointId, path: res.path, shapeCount }
  }

  /**
   * Restore the canvas to a saved checkpoint. Reads the JSON via IPC then calls
   * tldraw's native `loadSnapshot`, which orders assets-before-shapes, de-dupes
   * bindings and re-runs onBeforeCreate for us (so gap-analysis #8's manual
   * applySnapshot logic is unnecessary). Wrapped in safeWrite so an incompatible
   * snapshot is reported to Codex instead of crashing the tldraw tree.
   */
  async loadCheckpoint(checkpointId: string): Promise<unknown> {
    if (!checkpointId) return { ok: false, error: 'load_checkpoint requires checkpointId (get it from list_checkpoints).' }
    const editor = this.requireEditor()
    const api = this.canvasApi()
    if (!api?.readCheckpoint) return { ok: false, error: 'canvas checkpoint API unavailable' }
    const res = await api.readCheckpoint({ checkpointId })
    if (!res.ok) return { ok: false, error: res.reason }
    return this.safeWrite('load_checkpoint', () => {
      loadSnapshot(editor.store, JSON.parse(res.json))
      return { ok: true, checkpointId, shapeCount: editor.getCurrentPageShapeIds().size }
    })
  }

  /** List saved checkpoints (read-only; metadata only, no snapshot bodies). */
  async listCheckpoints(): Promise<{ ok: true; checkpoints: Array<{ checkpointId: string; name: string; createdAt: string; shapeCount: number; path: string }> } | { ok: false; error: string }> {
    const api = this.canvasApi()
    if (!api?.listCheckpoints) return { ok: false, error: 'canvas checkpoint API unavailable' }
    return { ok: true, checkpoints: await api.listCheckpoints() }
  }

  /** Build + submit an edit request from the current annotations (button click). */
  buildEditRequest(targetShapeId: string | undefined): { ok: boolean; reason?: string; requestPayload?: Record<string, unknown> } {
    const state = this.state()
    const plan = parseAnnotations({ state, targetShapeId, radius: 420 })
    const target = state.shapes.find((s) => s.id === plan.targetShapeId)
    if (!plan.targetShapeId || !target) return { ok: false, reason: plan.clarificationReason ?? '没有可修改的 AI 图片。' }
    const prompt = editPrompt({ annotations: plan.annotationPlan })
    return {
      ok: true,
      requestPayload: {
        targetShapeId: plan.targetShapeId,
        targetImagePath: target.assetPath,
        annotationPlan: plan.annotationPlan,
        needsClarification: plan.needsClarification,
        clarificationReason: plan.clarificationReason,
        storagePath: '',
        editPrompt: prompt,
        readyToEdit: !plan.needsClarification,
        canAutoEdit: !plan.needsClarification,
        source: 'canvas_button',
        codexInstruction: prompt,
      },
    }
  }

  /**
   * Export the target image to a real PNG file on disk and return its absolute
   * path. The annotation→edit flow needs a concrete file to hand generate_image
   * as a referenceImage; relying on meta.assetPath alone fails for images the
   * user pasted/dropped or whose temp file was cleaned up ("目标图临时文件不存在").
   * Prefers the asset's native full-res src, falling back to rendering just the
   * image shape (annotations excluded, so the reference stays clean).
   */
  async exportTargetImageFile(targetShapeId: string, threadId: string): Promise<string | undefined> {
    const editor = this.requireEditor()
    // The export is persisted as a thread-scoped attachment (FK on threadId), so
    // a real active thread is required. The old `threadId || 'canvas'` fallback
    // violated AgentAttachment_threadId_fkey and dropped the file, surfacing as
    // "目标图临时文件不存在". Without a thread we cannot persist a reference image.
    if (!threadId) return undefined
    const shape = editor.getShape(targetShapeId as never) as { props?: { assetId?: string } } | undefined
    if (!shape) return undefined

    // Fast path: only when the asset already holds an inline data: URL (images WE
    // inserted). tldraw-managed assets (pasted/dropped images) expose an opaque
    // `asset:<id>` reference that is NOT fetchable and violates the connect-src
    // CSP, so for those we rasterize the shape via tldraw's exporter instead.
    let src: string | undefined
    const assetId = shape.props?.assetId
    if (assetId) {
      const asset = editor.getAsset(assetId as never) as { props?: { src?: unknown } } | undefined
      if (typeof asset?.props?.src === 'string' && asset.props.src.startsWith('data:')) {
        src = asset.props.src
      }
    }
    if (!src) {
      const exported = await editor.toImageDataUrl([targetShapeId as never], { format: 'png', background: false })
      src = exported?.url
    }
    if (!src) return undefined

    const decoded = await srcToBase64(src)
    if (!decoded) return undefined

    const api = (window as Window & { electronAPI?: { attachments?: AttachmentsSaveApi } }).electronAPI?.attachments
    if (!api?.save) return undefined
    const ext = decoded.mime === 'image/jpeg' ? 'jpg' : decoded.mime.split('/')[1] || 'png'
    const res = await api.save({
      threadId,
      name: `canvas-edit-${Date.now()}.${ext}`,
      mime: decoded.mime,
      base64: decoded.base64,
    })
    return res.ok ? res.path : undefined
  }
}

export const canvasBridge = new CanvasBridge()

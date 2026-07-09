import { Box, getSnapshot, loadSnapshot, type Editor } from 'tldraw'
import type { Bounds, CanvasStatePayload } from '../../../../../types/canvas'
import { arrangeShapes, buildCanvasLints, buildTieredShapes, computeFocusTarget, createHolder, createImageVersion, createSimpleShape, deleteShapesById, diffShapeFingerprints, fingerprintSummaries, focusRegion, insertFilePlaceholder, insertImageAt, insertImageIntoHolder, insertTextNote, insertVideo, listImageShapes, readCanvasState, resolveShapeId, summarizeShape, truncateDataUrl, updateShapePartial, ARRANGE_OPERATIONS, type ArrangeOperation, type CanvasLint, type CreateSimpleShapeParams, type SnapshotDiff, type TieredShapesResult } from './shapeOps'
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
    } else {
      // Canvas tab closed: the agent viewports and snapshot fingerprints
      // describe an editor instance that no longer exists — a re-opened canvas
      // may hold a different document, so a stale diff/viewport would lie.
      this.agentViewports.clear()
      this.lastSnapshotFingerprints.clear()
    }
  }

  /** Whether a live tldraw editor is currently registered (canvas mounted). */
  hasEditor(): boolean {
    return this.editor !== null
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

  /** Per-thread shape fingerprints from the previous canvas_snapshot, used to
   * report `changedSinceLastSnapshot` (user actions between agent looks). */
  private lastSnapshotFingerprints = new Map<string, Map<string, string>>()

  /** The user's real camera viewport, rounded — undefined if the editor can't report it (test fakes). */
  private readUserViewportBounds(editor: Editor): Bounds | undefined {
    const vp = (editor as unknown as { getViewportPageBounds?: () => Bounds }).getViewportPageBounds?.()
    if (!vp) return undefined
    return { x: Math.round(vp.x), y: Math.round(vp.y), w: Math.round(vp.w), h: Math.round(vp.h) }
  }

  /** Per-thread AGENT viewport (official Agent Kit's "context bounds" idea):
   * canvas_focus_region mode:'virtual' records the region here instead of
   * moving the user's camera; canvas_snapshot then tiers + crops around it. */
  private agentViewports = new Map<string, Bounds>()

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
   * tree (custom MIME → a disk path, NOT an OS File). Routes by extension:
   * image/video → a real media shape; audio/any-other → a labeled placeholder
   * note carrying the disk path (so the agent can still locate it). Every kind
   * therefore records `assetPath`, visible in canvas_snapshot.
   */
  async insertFileAt(
    path: string,
    point: { x: number; y: number },
  ): Promise<{ ok: true; kind: 'image' | 'video' | 'audio' | 'file' } | { ok: false; reason: string }> {
    const lower = path.toLowerCase()
    const isVideo = /\.(mp4|webm|mov|m4v|mkv|ogg|ogv)$/.test(lower)
    const isImage = /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico)$/.test(lower)
    const isAudio = /\.(mp3|wav|m4a|aac|flac|opus|oga|weba)$/.test(lower)
    const editor = this.requireEditor()
    const title = path.split(/[\\/]/).pop() || 'file'
    // Audio + any other non-renderable file: tldraw has no shape for these, so we
    // drop a labeled placeholder note carrying the REAL workspace path (the tree
    // drag already hands us a disk path — no copy needed). Keeps the path visible
    // in canvas_snapshot so the agent can ffmpeg/mux it.
    if (!isVideo && !isImage) {
      const kind: 'audio' | 'file' = isAudio ? 'audio' : 'file'
      const res = await this.safeWrite('insert_file_placeholder', () =>
        insertFilePlaceholder(editor, { assetPath: path, title, kind, x: point.x, y: point.y }),
      )
      if (res && typeof res === 'object' && 'failed' in (res as Record<string, unknown>)) {
        return { ok: false, reason: String((res as { error?: string }).error ?? 'write failed') }
      }
      return { ok: true, kind }
    }
    const assetUrl = await this.toLoadable(path)
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
        // Self-heal a hallucinated/prefix-less holder id BEFORE paying the image
        // load, so a bad id returns candidates instead of "Holder not found".
        const holderId = resolveShapeId(editor, params.holderShapeId, { preferType: 'geo' })
        if (!holderId.ok) return { ok: false, failed: true, tool: 'insert_image_into_holder', error: holderId.error }
        const assetUrl = await this.toLoadable(String(params.imagePath))
        return this.safeWrite('insert_image_into_holder', () => insertImageIntoHolder(editor, { holderShapeId: holderId.id, assetUrl, assetPath: String(params.imagePath), title: params.title as string | undefined }))
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
        const sourceId = resolveShapeId(editor, params.sourceShapeId, { preferType: 'image' })
        if (!sourceId.ok) return { ok: false, failed: true, tool: 'create_image_version', error: sourceId.error }
        const assetUrl = await this.toLoadable(String(params.imagePath))
        return this.safeWrite('create_image_version', () => createImageVersion(editor, { sourceShapeId: sourceId.id, assetUrl, assetPath: String(params.imagePath), title: params.title as string | undefined }))
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
        return this.snapshot(typeof params.threadId === 'string' ? params.threadId : undefined, {
          full: params.full === true,
          focusShapeIds: Array.isArray(params.focusShapeIds) ? params.focusShapeIds.map(String) : undefined,
          screenshot: params.screenshot === false ? false : undefined,
        })
      case 'canvas_focus_region': {
        // Viewport navigation: the action half of the tiered snapshot loop.
        // Two modes (official Agent Kit keeps the agent's "context bounds"
        // separate from the user's camera):
        //   - 'virtual' (default): record an AGENT viewport per thread; the
        //     next canvas_snapshot tiers + crops its PNG around it. The user's
        //     camera never moves — the agent can explore without hijacking
        //     what the user is looking at.
        //   - 'camera': actually move the shared camera (only when the user
        //     asks to be SHOWN something).
        // Self-heal each shapeId (hallucinated / prefix-less ids return
        // candidates instead of silently focusing nothing).
        const editor = this.requireEditor()
        const viewportKey = typeof params.threadId === 'string' && params.threadId ? params.threadId : '__no_thread__'
        if (params.clear === true) {
          this.agentViewports.delete(viewportKey)
          return { ok: true, cleared: true, hint: 'Agent viewport cleared — canvas_snapshot follows the user viewport again.' }
        }
        const rawIds = Array.isArray(params.shapeIds) ? params.shapeIds.map(String) : []
        const resolvedIds: string[] = []
        for (const raw of rawIds) {
          const r = resolveShapeId(editor, raw)
          if (!r.ok) return { ok: false, failed: true, tool: 'canvas_focus_region', error: r.error }
          resolvedIds.push(r.id)
        }
        const bounds = params.bounds as { x: number; y: number; w: number; h: number } | undefined
        const focusOpts = { shapeIds: resolvedIds.length > 0 ? resolvedIds : undefined, bounds }
        if (params.mode === 'camera') {
          const res = focusRegion(editor, focusOpts)
          if (!res.ok) return { ok: false, failed: true, tool: 'canvas_focus_region', error: res.error }
          // Keep the agent viewport in sync so a later snapshot matches what
          // the agent just framed for the user.
          this.agentViewports.set(viewportKey, res.viewportBounds)
          return { ...res, mode: 'camera', hint: 'Camera moved (user sees this too). Call canvas_snapshot to see this region in full detail.' }
        }
        const resolved = computeFocusTarget(editor, focusOpts)
        if (!resolved.ok) return { ok: false, failed: true, tool: 'canvas_focus_region', error: resolved.error }
        const target = {
          x: Math.round(resolved.target.x),
          y: Math.round(resolved.target.y),
          w: Math.round(resolved.target.w),
          h: Math.round(resolved.target.h),
        }
        this.agentViewports.set(viewportKey, target)
        return {
          ok: true,
          mode: 'virtual',
          viewportBounds: target,
          hint: "Agent viewport set (the user's camera did NOT move). Call canvas_snapshot: shapes in this region come back in detail and the PNG is cropped to it. Pass clear:true to follow the user viewport again, or mode:'camera' to actually move the shared camera.",
        }
      }
      case 'canvas_arrange': {
        // Batch layout (align/distribute/stack/pack) — one atomic transaction
        // instead of N per-shape coordinate updates.
        const editor = this.requireEditor()
        const operation = String(params.operation ?? '') as ArrangeOperation
        if (!ARRANGE_OPERATIONS.includes(operation)) {
          return { ok: false, failed: true, tool: 'canvas_arrange', error: `Unknown operation "${operation}". Valid: ${ARRANGE_OPERATIONS.join(', ')}.` }
        }
        const rawIds = Array.isArray(params.shapeIds) ? params.shapeIds.map(String) : []
        const resolvedIds: string[] = []
        for (const raw of rawIds) {
          const r = resolveShapeId(editor, raw)
          if (!r.ok) return { ok: false, failed: true, tool: 'canvas_arrange', error: r.error }
          resolvedIds.push(r.id)
        }
        const gap = typeof params.gap === 'number' && Number.isFinite(params.gap) ? params.gap : undefined
        return this.safeWrite('canvas_arrange', () => {
          const res = arrangeShapes(editor, resolvedIds, operation, gap)
          if (!res.ok) throw new Error(res.error)
          return res
        })
      }
      case 'canvas_update_shape': {
        // Structured single-shape update (position/size/rotation/text/color) —
        // the official kit's update action, so the model stops writing raw
        // canvas_exec code for simple edits. Ids self-heal like everywhere else.
        const editor = this.requireEditor()
        const resolved = resolveShapeId(editor, params.shapeId)
        if (!resolved.ok) return { ok: false, failed: true, tool: 'canvas_update_shape', error: resolved.error }
        const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
        return this.safeWrite('canvas_update_shape', () => {
          const res = updateShapePartial(editor, resolved.id, {
            x: num(params.x),
            y: num(params.y),
            w: num(params.w),
            h: num(params.h),
            rotation: num(params.rotation),
            text: typeof params.text === 'string' ? params.text : undefined,
            color: typeof params.color === 'string' ? params.color : undefined,
          })
          if (!res.ok) throw new Error(res.error)
          return res
        })
      }
      case 'canvas_create_shape': {
        // Structured creation of native tldraw shapes (geo/note/text/line/
        // arrow-with-bindings) — the official kit's Create action. fromId/toId
        // self-heal so "arrow from IMG_1 to IMG_2" works with sloppy ids.
        const editor = this.requireEditor()
        let fromId: string | undefined
        let toId: string | undefined
        if (typeof params.fromId === 'string' && params.fromId) {
          const r = resolveShapeId(editor, params.fromId)
          if (!r.ok) return { ok: false, failed: true, tool: 'canvas_create_shape', error: r.error }
          fromId = r.id
        }
        if (typeof params.toId === 'string' && params.toId) {
          const r = resolveShapeId(editor, params.toId)
          if (!r.ok) return { ok: false, failed: true, tool: 'canvas_create_shape', error: r.error }
          toId = r.id
        }
        return this.safeWrite('canvas_create_shape', () => {
          const res = createSimpleShape(editor, { ...(params as unknown as CreateSimpleShapeParams), fromId, toId })
          if (!res.ok) throw new Error(res.error)
          return res
        })
      }
      case 'canvas_delete_shapes': {
        // Structured batch delete with self-healed ids; single undo entry.
        const editor = this.requireEditor()
        const rawIds = Array.isArray(params.shapeIds) ? params.shapeIds.map(String) : []
        if (rawIds.length === 0) {
          return { ok: false, failed: true, tool: 'canvas_delete_shapes', error: 'canvas_delete_shapes requires shapeIds (non-empty array).' }
        }
        const resolvedIds: string[] = []
        for (const raw of rawIds) {
          const r = resolveShapeId(editor, raw)
          if (!r.ok) return { ok: false, failed: true, tool: 'canvas_delete_shapes', error: r.error }
          resolvedIds.push(r.id)
        }
        return this.safeWrite('canvas_delete_shapes', () => {
          const res = deleteShapesById(editor, resolvedIds)
          if (!res.ok) throw new Error(res.error)
          return res
        })
      }
      case 'list_canvas_images':
        // Read-only flat index of image shapes (borrowed from sora-canvas-mcp):
        // lets Codex pick a shapeId before paying any get_canvas_image cost.
        return listImageShapes(this.requireEditor())
      case 'get_canvas_image':
        // Fetch ONE image by shapeId: focused metadata + an on-disk PNG path Codex
        // can open. threadId (renderer-injected) is required to persist the export.
        return this.getCanvasImage(String(params.shapeId ?? ''), typeof params.threadId === 'string' ? params.threadId : undefined)
      case 'get_selected_canvas_video':
        // Internal helper (no MCP surface): resolve the canvas video the user
        // wants understood — drives the understand_canvas_video MCP tool.
        return this.getSelectedVideo()
      case 'get_canvas_video':
        // MCP-surfaced sibling of get_canvas_image, for VIDEOS: resolve the
        // selected (or single) canvas video to a guaranteed-openable LOCAL file
        // path so the agent can ffmpeg / contact-sheet it instead of hunting the
        // disk by filename. threadId (renderer-injected) lets the materialize
        // fallback persist a fresh copy when the shape has no recorded path.
        return this.getCanvasVideo(typeof params.threadId === 'string' ? params.threadId : undefined)
      case 'add_canvas_note':
        // Internal helper (no MCP surface): write an AI text note (e.g. the
        // video-understanding result) onto the canvas next to its source shape.
        return this.addCanvasNote(params)
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
   *
   * Large canvases (> TIERED_SNAPSHOT_THRESHOLD shapes) switch to the tiered
   * format borrowed from tldraw's official Agent Starter Kit — blurry viewport
   * overview + full detail for selected/focusShapeIds shapes + clusters for
   * off-viewport shapes — so the structured payload can't blow up the model's
   * context. `full: true` forces the old full dump.
   */
  async snapshot(
    threadId?: string,
    opts: { full?: boolean; focusShapeIds?: string[]; screenshot?: boolean } = {},
  ): Promise<
    {
      shapeCount: number
      shapes: TieredShapesResult['shapes']
      selection: string[]
      imagePath?: string
      screenshotScope?: 'viewport' | 'full'
      hint?: string
      lints?: CanvasLint[]
      changedSinceLastSnapshot?: SnapshotDiff
      userViewportBounds?: Bounds
    } & Omit<TieredShapesResult, 'shapes'>
  > {
    const editor = this.requireEditor()
    const state = this.state()
    // "What changed since your last snapshot" (per thread): the poor man's
    // version of the official kit's user-action context. Diffing fingerprints
    // catches user drags/edits/deletes between two agent looks at the canvas.
    const diffKey = threadId ?? '__no_thread__'
    const prevFingerprints = this.lastSnapshotFingerprints.get(diffKey)
    const changedSinceLastSnapshot = prevFingerprints ? diffShapeFingerprints(prevFingerprints, state.shapes) : undefined
    this.lastSnapshotFingerprints.set(diffKey, fingerprintSummaries(state.shapes))
    const agentViewport = this.agentViewports.get(diffKey)
    const tiered = buildTieredShapes(editor, state.shapes, {
      full: opts.full,
      focusShapeIds: opts.focusShapeIds,
      selectedIds: state.selection.selectedShapeIds,
      viewportOverride: agentViewport,
    })
    let imagePath: string | undefined
    let screenshotScope: 'viewport' | 'full' | undefined
    const ids = Array.from(editor.getCurrentPageShapeIds()) as never[]
    // The PNG is persisted via the thread-scoped attachments store, whose DB row
    // has a threadId foreign key. Passing a non-existent id (the old literal
    // 'canvas') violates AgentAttachment_threadId_fkey and the file is dropped.
    // Only save when we have the real active thread; otherwise still return the
    // structured shapes so Codex isn't left totally blind.
    if (ids.length > 0 && threadId && opts.screenshot !== false) {
      // Match the PNG to the structured payload: a tiered snapshot describes the
      // VIEWPORT, so crop the export to the viewport too — a whole-page export
      // of a large canvas renders every shape at unreadably small scale (and
      // costs a big rasterize). Full snapshots keep the whole-page export.
      screenshotScope = tiered.detailLevel === 'tiered' ? 'viewport' : 'full'
      const exportOpts =
        screenshotScope === 'viewport'
          ? // Crop to the agent's virtual viewport when set, else the user's camera.
            // (toImageDataUrl wants a real Box, not a plain rect.)
            {
              format: 'png' as const,
              background: true,
              bounds: agentViewport ? new Box(agentViewport.x, agentViewport.y, agentViewport.w, agentViewport.h) : editor.getViewportPageBounds(),
            }
          : { format: 'png' as const, background: true }
      const exported = await editor.toImageDataUrl(ids, exportOpts)
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
    // Attention hints (overlaps / empty holders / degenerate or stranded
    // shapes) computed over the FULL summary list, not the tiered view, so a
    // problem hiding off-viewport still surfaces.
    const lints = buildCanvasLints(state.shapes)
    return {
      shapeCount: state.shapes.length,
      detailLevel: tiered.detailLevel,
      shapes: tiered.shapes,
      focusedShapes: tiered.focusedShapes,
      peripheralClusters: tiered.peripheralClusters,
      viewportBounds: tiered.viewportBounds,
      // Where the USER is looking right now (official kit sends both agent and
      // user viewports) — needed to resolve "the images on MY screen" when the
      // agent's virtual viewport is elsewhere.
      userViewportBounds: this.readUserViewportBounds(editor),
      selection: state.selection.selectedShapeIds,
      imagePath,
      screenshotScope: imagePath ? screenshotScope : undefined,
      lints: lints.length > 0 ? lints : undefined,
      changedSinceLastSnapshot,
      hint:
        tiered.detailLevel === 'tiered'
          ? 'Large canvas: viewport shapes are a reduced overview (the PNG at imagePath shows the viewport pixels), off-viewport shapes are grouped into peripheralClusters. Use canvas_focus_region to move the viewport to a cluster/shapes, then re-call canvas_snapshot; or pass focusShapeIds:[…] / full:true.'
          : undefined,
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
    // Self-heal hallucinated / prefix-less ids (returns candidates on failure).
    const resolved = resolveShapeId(editor, shapeId, { preferType: 'image' })
    if (!resolved.ok) return { ok: false, error: resolved.error }
    shapeId = resolved.id
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
      // The pixels travel via imagePath — never echo a multi-MB data: URL.
      assetUrl: summary.assetUrl ? truncateDataUrl(summary.assetUrl) : null,
      imagePath,
    }
  }

  /**
   * Resolve the VIDEO the user wants understood from the canvas: the selected
   * video shape, or — when nothing video is selected — the single video on the
   * page. Returns its best source for understanding: PREFER the on-disk
   * assetPath (the main process can read it and upload to COS), else the asset
   * src/url. Falls back to the backing tldraw asset for videos pasted/dropped
   * without our meta. Structured `{ ok:false, error }` (never throws) so
   * understand_canvas_video can tell the user to select a video. This is the
   * "理解画布上选中的视频" channel — the canvas side exposing the selected
   * clip's source to understand_video.
   */
  async getSelectedVideo(): Promise<
    | { ok: true; shapeId: string; assetPath: string | null; assetUrl: string | null; title: string | null }
    | { ok: false; error: string }
  > {
    const editor = this.requireEditor()
    const state = this.state()
    let target = state.selection.shapes.find((s) => s.type === 'video')
    if (!target) {
      const videos = state.shapes.filter((s) => s.type === 'video')
      if (videos.length === 0) return { ok: false, error: '画布上没有视频。先把视频拖到画布(或用 insert_video 放一个)再试。' }
      if (videos.length > 1) return { ok: false, error: `画布上有 ${videos.length} 个视频,请先在画布上选中要理解的那一个。` }
      target = videos[0]
    }
    let assetPath = typeof target.assetPath === 'string' && target.assetPath ? target.assetPath : null
    let assetUrl = typeof target.assetUrl === 'string' && target.assetUrl ? target.assetUrl : null
    if (!assetPath && !assetUrl) {
      const shape = editor.getShape(target.id as never) as { props?: { assetId?: string } } | undefined
      const assetId = shape?.props?.assetId
      const asset = assetId ? (editor.getAsset(assetId as never) as { props?: { src?: unknown }; meta?: { assetPath?: unknown } } | undefined) : undefined
      if (asset) {
        if (typeof asset.meta?.assetPath === 'string') assetPath = asset.meta.assetPath
        if (!assetUrl && typeof asset.props?.src === 'string') assetUrl = asset.props.src
      }
    }
    if (!assetPath && !assetUrl) return { ok: false, error: '选中的视频没有可用的源(无 assetPath/assetUrl),无法理解。' }
    const title = typeof target.meta?.title === 'string' ? target.meta.title : null
    return { ok: true, shapeId: target.id, assetPath, assetUrl, title }
  }

  /**
   * Resolve the selected (or single) canvas VIDEO to an openable LOCAL file path
   * — the video analog of getCanvasImage and the missing MCP surface that forced
   * the agent to hunt the disk by filename/size before running ffmpeg / building
   * a contact sheet. Strategy:
   *   1. PREFER the recorded on-disk assetPath (clips inserted via insert_video
   *      or dragged from the workspace tree carry the real path).
   *   2. Else MATERIALIZE the backing asset bytes (data:/blob: src) to a real
   *      file on disk and return THAT — so a pasted/OS-dropped clip with no
   *      recorded path still yields a usable file (this is the "好像没有成功存储 /
   *      没披露链接" case: we always hand back an openable path or, failing that,
   *      the source URL).
   *   3. Else disclose the assetUrl so the agent at least has a source to relay.
   * Structured `{ ok:false, error }` (never throws), mirroring getCanvasImage.
   */
  async getCanvasVideo(
    threadId?: string,
  ): Promise<
    | { ok: true; shapeId: string; videoPath: string | null; assetPath: string | null; assetUrl: string | null; title: string | null; materialized: boolean }
    | { ok: false; error: string }
  > {
    const sel = await this.getSelectedVideo()
    if (!sel.ok) return sel
    if (sel.assetPath) {
      return { ok: true, shapeId: sel.shapeId, videoPath: sel.assetPath, assetPath: sel.assetPath, assetUrl: sel.assetUrl, title: sel.title, materialized: false }
    }
    const materialized = threadId ? await this.exportSelectedVideoFile(sel.shapeId, threadId) : undefined
    return {
      ok: true,
      shapeId: sel.shapeId,
      videoPath: materialized ?? null,
      assetPath: null,
      assetUrl: sel.assetUrl,
      title: sel.title,
      materialized: Boolean(materialized),
    }
  }

  /**
   * Write a canvas video's backing-asset bytes to a real file on disk and return
   * its absolute path. The video counterpart of exportTargetImageFile.
   *
   * Root-caused against tldraw 5.x source (useLocalStore.ts + Editor.ts): with a
   * `persistenceKey` set, an OS-dragged / pasted clip's bytes are stored in
   * IndexedDB and the shape's `asset.props.src` is left as an OPAQUE `asset:<id>`
   * ref — NOT a data:/blob: URL — so reading `props.src` directly and handing it
   * to srcToBase64 (which rejects `asset:`) yielded nothing (the "拖上来的视频没
   * 注册路径" case). The official read path is `editor.resolveAssetUrl(assetId)`,
   * which turns that ref into a fetchable `blob:` URL (via the local store's
   * `URL.createObjectURL`) and returns a data:/http src as-is. We resolve first,
   * fall back to the raw `props.src` only when resolveAssetUrl is unavailable.
   * Persist via the thread-scoped attachments store (mime whitelist allows
   * video/*). Requires a real thread (FK).
   */
  async exportSelectedVideoFile(shapeId: string, threadId: string): Promise<string | undefined> {
    if (!threadId) return undefined
    const editor = this.requireEditor() as Editor & {
      resolveAssetUrl?: (assetId: unknown, ctx: { shouldResolveToOriginal?: boolean }) => Promise<string | null>
    }
    const shape = editor.getShape(shapeId as never) as { props?: { assetId?: string } } | undefined
    const assetId = shape?.props?.assetId
    if (!assetId) return undefined
    let src: string | null = null
    if (typeof editor.resolveAssetUrl === 'function') {
      try {
        src = await editor.resolveAssetUrl(assetId, { shouldResolveToOriginal: true })
      } catch {
        src = null
      }
    }
    if (!src) {
      const asset = editor.getAsset(assetId as never) as { props?: { src?: unknown } } | undefined
      src = typeof asset?.props?.src === 'string' ? asset.props.src : null
    }
    if (!src) return undefined
    const decoded = await srcToBase64(src)
    if (!decoded) return undefined
    const api = (window as Window & { electronAPI?: { attachments?: AttachmentsSaveApi } }).electronAPI?.attachments
    if (!api?.save) return undefined
    const ext = decoded.mime.includes('webm') ? 'webm' : decoded.mime.includes('quicktime') ? 'mov' : 'mp4'
    const res = await api.save({
      threadId,
      name: `canvas-video-${Date.now()}.${ext}`,
      mime: decoded.mime,
      base64: decoded.base64,
    })
    return res.ok ? res.path : undefined
  }

  /**
   * The real on-disk path of an OS-dropped `File`, via Electron's
   * `webUtils.getPathForFile` (exposed as `electronAPI.getFilePath`). This app
   * runs UN-sandboxed (sandbox:false), so a desktop/Explorer drag exposes the
   * file's actual path — for ANY type (image/video/audio/zip/…) and ANY size,
   * with ZERO copy. Returns undefined for synthetic/clipboard File objects (paste,
   * generated blobs) which have no OS path (getFilePath returns '').
   */
  private osPathForFile(file: File): string | undefined {
    const api = (window as Window & { electronAPI?: { getFilePath?: (f: File) => string } }).electronAPI
    if (!api?.getFilePath) return undefined
    try {
      const p = api.getFilePath(file)
      return typeof p === 'string' && p.trim() ? p : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Resolve an absolute on-disk path for a dropped `File`, so the canvas can stamp
   * it as `meta.assetPath` at DROP TIME ("path at creation", like AI-Canvas) and
   * the path appears natively in canvas_snapshot / get_selected_canvas_video
   * WITHOUT the agent calling get_canvas_video.
   *
   * Two tiers:
   *  1. Real OS path (preferred) — zero copy, works for every file type and size.
   *  2. Fallback copy into the thread uploads dir for synthetic/clipboard Files
   *     that have no OS path. The save IPC only accepts image/* or video/* and
   *     holds bytes in memory, so this tier is media-only + size-capped (~100MB);
   *     anything else returns undefined (the clip still lands, and get_canvas_video
   *     can materialize from the IndexedDB blob on demand).
   *
   * Best-effort: returns undefined rather than throwing so a drop is never blocked.
   */
  async resolveDroppedFileDiskPath(file: File, threadId: string): Promise<string | undefined> {
    if (!file) return undefined
    const osPath = this.osPathForFile(file)
    if (osPath) return osPath
    // Fallback: copy bytes (only possible for a real thread + media mime).
    if (!threadId) return undefined
    const MAX_INLINE_BYTES = 100 * 1024 * 1024
    if (typeof file.size === 'number' && file.size > MAX_INLINE_BYTES) return undefined
    const lower = (file.name ?? '').toLowerCase()
    const mime =
      file.type ||
      (lower.endsWith('.webm') ? 'video/webm' : lower.endsWith('.mov') ? 'video/quicktime' : lower.endsWith('.mp4') ? 'video/mp4' : '')
    if (!mime.startsWith('image/') && !mime.startsWith('video/')) return undefined
    const base64 = await blobToBase64(file)
    if (!base64) return undefined
    const api = (window as Window & { electronAPI?: { attachments?: AttachmentsSaveApi } }).electronAPI?.attachments
    if (!api?.save) return undefined
    const res = await api.save({ threadId, name: file.name || `canvas-drop-${Date.now()}`, mime, base64 })
    return res.ok ? res.path : undefined
  }

  /**
   * OS-drag fallback for a NON-media file (audio/zip/pdf/…): tldraw can't render
   * it, so it never becomes a shape and would vanish from canvas_snapshot. We drop
   * a labeled placeholder note carrying the file's real disk path in
   * `meta.assetPath` so the agent can still locate it (e.g. mux an mp3 with
   * ffmpeg). Non-fatal: a failure here must never break the rest of the drop.
   */
  async placeDroppedNonMediaFile(
    file: File,
    point: { x: number; y: number } | undefined,
    index: number,
    threadId: string,
  ): Promise<void> {
    const editor = this.editor
    if (!editor) return
    const diskPath = await this.resolveDroppedFileDiskPath(file, threadId)
    const kind: 'audio' | 'file' = (file.type ?? '').startsWith('audio/') ? 'audio' : 'file'
    const base = point ?? { x: 100, y: 100 }
    const offset = index * 28
    await this.safeWrite('place_dropped_file', () =>
      insertFilePlaceholder(editor, {
        assetPath: diskPath,
        title: file.name || 'file',
        kind,
        x: base.x + offset,
        y: base.y + offset,
      }),
    )
  }

  /**
   * Write an AI text note onto the canvas (e.g. a video-understanding result),
   * positioned next to its source shape. safeWrite-wrapped so a bad write is
   * reported instead of crashing the tldraw tree. Drives the "把理解内容展示在
   * 画布上" half of understand_canvas_video.
   */
  async addCanvasNote(
    params: Record<string, unknown>,
  ): Promise<{ ok: true; shapeId: string } | { ok: false; failed: true; tool: string; error: string }> {
    const editor = this.requireEditor()
    return this.safeWrite('add_canvas_note', () => {
      const res = insertTextNote(editor, {
        text: String(params.text ?? ''),
        title: typeof params.title === 'string' ? params.title : undefined,
        nearShapeId: typeof params.nearShapeId === 'string' ? params.nearShapeId : undefined,
        x: typeof params.x === 'number' ? params.x : undefined,
        y: typeof params.y === 'number' ? params.y : undefined,
        width: typeof params.width === 'number' ? params.width : undefined,
        role: typeof params.role === 'string' ? params.role : undefined,
      })
      return { ok: true as const, shapeId: res.shapeId }
    })
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

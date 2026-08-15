import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { type Editor, Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'
import type { EditRequestQueueStatus } from '../../../../types/canvas'
import { getAgentApi } from '../../utils/agentBridge'
import { canvasBridge } from './canvas/canvasBridge'
import { canvasShapeUtils } from './canvas/FileCardShapeUtil'
import { makeFileAssetHandlerWithDiskPath, makeFilesContentHandlerWithPlaceholders } from './canvas/shapeOps'
import { makeCanvasAssetStore } from './canvas/canvasAssetStore'
import { useAgentChatStore } from '../agent-chat/store'
import { parseFileDrop } from '../file-explorer/dragHelpers'

/** Custom MIME the file-explorer tree puts dragged paths in (dragHelpers). */
const FILE_PATHS_MIME = 'application/x-catimation-file-paths'

/** Idle delay (ms) after the last annotation edit before auto-submitting to the queue. */
const AUTO_SUBMIT_IDLE_MS = 1500

// tldraw 默认 `maxAssetSize` 是 10MB(见官方 options 文档),原生拖拽/粘贴超过
// 就被静默拒绝 —— 这正是"画布只能拖 10MB 文件"的根因。把上限抬到与本 app 全局
// 媒体上限一致的 2GB(理解/附件链路已同口径);超大图再用 maxImageDimension 降采样,
// 避免把巨幅位图原样 base64 内联进 persisted store(IndexedDB)撑爆存储。
// 注:从工作区树拖拽走的是 canvasBridge.insertFileAt,本就不受此限,这里修的是
// 原生 OS 文件拖拽 / 粘贴这条 tldraw 默认 asset 流水线。
const CANVAS_MAX_ASSET_SIZE = 2 * 1024 * 1024 * 1024 // 2GB
const CANVAS_MAX_IMAGE_DIMENSION = 8192 // 支持到 8K 长边,超过才降采样

/**
 * v1 (`catimation-canvas`) persisted tldraw's default asset store: whole
 * images/videos as `data:` URLs + IndexedDB blobs. Hydrating that store on
 * canvas open OOMs the renderer and Electron relaunches the app in a loop.
 * v2 keeps only path-backed `local-file://` srcs (this asset store).
 */
const CANVAS_PERSISTENCE_KEY = 'catimation-canvas-v2'

const canvasAssetStore = makeCanvasAssetStore({
  resolveDiskPath: (file, threadId) => canvasBridge.resolveDroppedFileDiskPath(file, threadId),
  getThreadId: () => useAgentChatStore.getState().threadId ?? '',
})

export function CanvasSection(): React.JSX.Element {
  const editorRef = useRef<Editor | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<EditRequestQueueStatus | null>(null)
  const [flash, setFlash] = useState<string>('')
  // Mirrors editor.getIsFocused() so the UI can tell the user, at a glance,
  // whether canvas keyboard shortcuts (zoom / undo / delete) are live. tldraw
  // gates BOTH its container `keydown` handler and its native clipboard
  // `copy/cut/paste` handlers on this flag (see useDocumentEvents.js +
  // useClipboardEvents.js), so "focused" literally == "shortcuts on".
  const [focused, setFocused] = useState(false)

  // Last submitted annotation signature, so the same marks are not re-queued.
  const lastSignatureRef = useRef<string>('')
  const submittingRef = useRef<boolean>(false)
  const flashTimerRef = useRef<number | undefined>(undefined)

  const showFlash = useCallback((message: string) => {
    setFlash(message)
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current)
    flashTimerRef.current = window.setTimeout(() => setFlash(''), 4000)
  }, [])

  const trySubmit = useCallback(async () => {
    const target = editorRef.current?.getSelectedShapeIds().map(String)[0]
    const built = canvasBridge.buildEditRequest(target)
    if (!built.ok || !built.requestPayload) return
    const signature = JSON.stringify({
      t: built.requestPayload.targetShapeId,
      a: built.requestPayload.annotationPlan,
    })
    if (signature === lastSignatureRef.current || submittingRef.current) return
    submittingRef.current = true
    try {
      // Export the real image pixels to a file so Codex always has a concrete
      // reference image to edit (meta.assetPath is missing for pasted images).
      const threadId = useAgentChatStore.getState().threadId ?? ''
      const filePath = await canvasBridge.exportTargetImageFile(String(built.requestPayload.targetShapeId), threadId)
      if (!filePath) {
        showFlash('无法导出画布图片作为修图原图，请重试或重新选中图片。')
        return
      }
      getAgentApi()?.submitCanvasEditRequest?.({
        ...built.requestPayload,
        source: 'canvas_auto',
        targetImagePath: filePath,
        storagePath: filePath,
      })
      lastSignatureRef.current = signature
      showFlash('已自动提交标注，Codex 修图中…新版会放到旧图右侧。')
    } finally {
      submittingRef.current = false
    }
  }, [showFlash])

  const handleMount = useCallback(
    (editor: Editor) => {
      editorRef.current = editor
      canvasBridge.setEditor(editor)

      // ── DROP-TIME PATH REGISTRATION (AI-Canvas "path at creation") ──
      // OS-desktop drops fall through to tldraw's default 'file' asset handler,
      // which uploads the bytes to IndexedDB and leaves src as an opaque
      // `asset:<id>` ref with NO disk path — so canvas_snapshot showed no
      // `assetPath` and the agent had to call get_canvas_video to materialize one.
      // We wrap that default (captured here BEFORE we override it; Tldraw.tsx runs
      // our onMount LAST, after the defaults are registered) so a dropped image/
      // video also gets its real on-disk path baked into the asset meta. Because
      // this app is UN-sandboxed, the path comes from electronAPI.getFilePath
      // (zero copy, any size) — only synthetic/clipboard Files fall back to a copy.
      // After this the path is present the moment the clip lands on the canvas.
      const editorWithHandlers = editor as Editor & {
        externalAssetContentHandlers: { file: Parameters<typeof makeFileAssetHandlerWithDiskPath>[0] }
        externalContentHandlers: { files: Parameters<typeof makeFilesContentHandlerWithPlaceholders>[0] }
      }
      const wrappedFileHandler = makeFileAssetHandlerWithDiskPath(
        editorWithHandlers.externalAssetContentHandlers.file,
        (file, threadId) => canvasBridge.resolveDroppedFileDiskPath(file, threadId),
        () => useAgentChatStore.getState().threadId,
      )
      editor.registerExternalAssetHandler('file', wrappedFileHandler as never)

      // ── NON-MEDIA OS DROPS (audio/zip/pdf/…) ──
      // tldraw only makes shapes for image/video; everything else its default
      // 'files' content handler `continue`-skips (just a "type not allowed" toast),
      // so a desktop-dragged mp3 would land NOWHERE and the agent could never see
      // it. We wrap that content handler so non-renderable files instead leave a
      // path-bearing placeholder note (real path via getFilePath), while images/
      // videos still flow through the default (and the asset wrapper above stamps
      // their path). `getAssetUtilForMimeType` is tldraw's own "can I render this?"
      // check, so the split matches stock behaviour exactly.
      const editorMime = editor as Editor & { getAssetUtilForMimeType?: (m: string) => unknown }
      const wrappedFilesHandler = makeFilesContentHandlerWithPlaceholders(
        editorWithHandlers.externalContentHandlers.files,
        (file) => !!editorMime.getAssetUtilForMimeType?.(file.type),
        (file, point, index) =>
          canvasBridge.placeDroppedNonMediaFile(file, point, index, useAgentChatStore.getState().threadId ?? ''),
      )
      editor.registerExternalContentHandler('files', wrappedFilesHandler as never)

      // Seed the signature with whatever annotations already exist so a restored
      // canvas does not immediately re-queue prior marks.
      const initial = canvasBridge.buildEditRequest(undefined)
      lastSignatureRef.current = initial.ok && initial.requestPayload
        ? JSON.stringify({ t: initial.requestPayload.targetShapeId, a: initial.requestPayload.annotationPlan })
        : ''

      // Codex "直接监听": debounce document changes, then auto-enqueue the batch.
      let idle: number | undefined
      const unlisten = editor.store.listen(
        () => {
          if (idle) window.clearTimeout(idle)
          idle = window.setTimeout(() => {
            void trySubmit()
          }, AUTO_SUBMIT_IDLE_MS)
        },
        { source: 'user', scope: 'document' }
      )

      // Keep the React `focused` mirror in sync with tldraw's instance state.
      // Fires for BOTH our explicit focus()/blur() and any internal change, so
      // the UI indicator never drifts. Seed it once for the current value.
      setFocused(editor.getIsFocused())
      const offFocusSync = editor.sideEffects.registerAfterChangeHandler(
        'instance',
        (prev, next) => {
          if (prev.isFocused !== next.isFocused) setFocused(next.isFocused)
        },
      )

      // ───────────────────────────────────────────────────────────────────────
      // FOCUS OWNERSHIP (root-caused against tldraw 5.1.1 source, not guessed):
      //
      //   tldraw gates its container `keydown` shortcuts (useDocumentEvents.js:
      //   `if (!isAppFocused) return`) AND its document-level `copy/cut/paste`
      //   handlers (useClipboardEvents.js: same gate; copy only preventDefaults
      //   when a SHAPE is selected) on `editor.getInstanceState().isFocused`.
      //
      //   tldraw's OWN click-to-focus / click-outside-to-blur wiring
      //   (TldrawEditor.js handleFocusOnPointerDownForPreserveFocusMode) only
      //   registers under `if (autoFocus && noAutoFocus())`, and `noAutoFocus()`
      //   is just `location.search.includes('tldraw_preserve_focus')` — never
      //   true here. So in our app tldraw NEVER auto-manages focus on click:
      //     • default autoFocus=true  → focused at mount, never blurs  → the
      //       original "蓝链 Ctrl+C 被吞" bug (stays focused next to the chat).
      //     • our   autoFocus=false   → never focuses, even on click    → "快捷键
      //       要先点一下也没用" (zoom dead because isFocused stays false).
      //   Therefore WE own focus: focus when the user actually works on the
      //   canvas, blur the moment they touch the chat (so it never holds the
      //   global clipboard). This is the single-editor analog of tldraw's own
      //   "Multiple editors" focus-coordination example.
      //
      // Capture phase so we settle focus before tldraw's gated handlers read it.
      const isEditableTarget = (el: EventTarget | null): boolean => {
        if (!(el instanceof HTMLElement)) return false
        const tag = el.tagName
        return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
      }
      const focusFromCanvas = (e: Event): void => {
        const target = e.target
        if (!(target instanceof Node)) return
        if (!wrapperRef.current?.contains(target)) return
        // Pointer-enter must NOT yank focus out of the chat composer while the
        // user is typing; an explicit pointerdown on the canvas always may.
        if (e.type === 'pointerenter' && isEditableTarget(document.activeElement)) return
        if (!editor.getIsFocused()) editor.focus()
      }
      const blurIfOutside = (e: Event): void => {
        const target = e.target
        if (!(target instanceof Node)) return
        if (wrapperRef.current?.contains(target)) return
        if (editor.getIsFocused()) editor.blur()
      }
      const wrapperEl = wrapperRef.current
      wrapperEl?.addEventListener('pointerenter', focusFromCanvas)
      document.addEventListener('pointerdown', focusFromCanvas, true)
      document.addEventListener('pointerdown', blurIfOutside, true)
      document.addEventListener('focusin', blurIfOutside, true)

      return () => {
        if (idle) window.clearTimeout(idle)
        unlisten()
        offFocusSync()
        wrapperEl?.removeEventListener('pointerenter', focusFromCanvas)
        document.removeEventListener('pointerdown', focusFromCanvas, true)
        document.removeEventListener('pointerdown', blurIfOutside, true)
        document.removeEventListener('focusin', blurIfOutside, true)
        canvasBridge.setEditor(null)
        editorRef.current = null
      }
    },
    [trySubmit]
  )

  // Drop files dragged from the workspace tree onto the canvas. Each placed file
  // cascades slightly so multiple drops don't stack exactly on top of each other.
  const handleFileDrop = useCallback(
    async (paths: string[], point: { x: number; y: number }) => {
      let placed = 0
      let cascade = 0
      for (const p of paths) {
        try {
          const res = await canvasBridge.insertFileAt(p, { x: point.x + cascade, y: point.y + cascade })
          if (res.ok) {
            placed += 1
            cascade += 28
          }
        } catch {
          // One bad file must not abort the rest of the batch.
        }
      }
      showFlash(placed > 0 ? `已把 ${placed} 个文件放到画布` : '无法放置该文件')
    },
    [showFlash],
  )

  // Intercept the workspace-file drag in the CAPTURE phase, BEFORE tldraw's own
  // drop handler runs: our drag also carries a `text/plain` path fallback, which
  // tldraw would otherwise turn into a text shape of the raw file path. Native
  // listeners (not React props) so capture+stopPropagation reliably beats the
  // listeners tldraw attaches on its inner container.
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const onDragOver = (e: DragEvent): void => {
      if (!e.dataTransfer || !e.dataTransfer.types.includes(FILE_PATHS_MIME)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (e: DragEvent): void => {
      if (!e.dataTransfer || !e.dataTransfer.types.includes(FILE_PATHS_MIME)) return
      e.preventDefault()
      e.stopPropagation()
      const paths = parseFileDrop(e.dataTransfer)
      if (paths.length === 0) return
      const editor = editorRef.current
      const point = editor ? editor.screenToPage({ x: e.clientX, y: e.clientY }) : { x: 100, y: 100 }
      void handleFileDrop(paths, { x: point.x, y: point.y })
    }
    el.addEventListener('dragover', onDragOver, true)
    el.addEventListener('drop', onDrop, true)
    return () => {
      el.removeEventListener('dragover', onDragOver, true)
      el.removeEventListener('drop', onDrop, true)
    }
  }, [handleFileDrop])

  useEffect(() => {
    let disposed = false
    const poll = async () => {
      const api = getAgentApi()
      if (!api?.getCanvasEditQueueStatus) return
      try {
        const s = await api.getCanvasEditQueueStatus()
        if (!disposed) setStatus(s)
      } catch {
        /* ignore */
      }
    }
    void poll()
    const id = window.setInterval(poll, 5000)
    return () => {
      disposed = true
      window.clearInterval(id)
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current)
    }
  }, [])

  const pill = status?.processingCount
    ? 'Codex 正在修图…'
    : flash || (status?.queuedCount ? `排队中 ${status.queuedCount}` : '')

  return (
    <div ref={wrapperRef} className="relative h-full min-h-0 w-full">
      <Tldraw
        persistenceKey={CANVAS_PERSISTENCE_KEY}
        assets={canvasAssetStore}
        // Do NOT grab global keyboard/clipboard on mount — see the FOCUS
        // OWNERSHIP block in handleMount. We focus the editor ourselves on
        // pointer-enter/down and blur it when the user moves to the chat, so the
        // canvas never holds the global clipboard while you're copying chat text.
        autoFocus={false}
        onMount={handleMount}
        maxAssetSize={CANVAS_MAX_ASSET_SIZE}
        maxImageDimension={CANVAS_MAX_IMAGE_DIMENSION}
        // Custom shapes: file-card renders audio/zip/pdf drops as a real card
        // (icon + name + path + inline audio player) instead of a grey note.
        shapeUtils={canvasShapeUtils}
      />
      {/* Focus affordance: a soft ring when the canvas owns the keyboard, so the
          user always knows whether zoom/undo/delete shortcuts will land here vs.
          in the chat. Pointer-transparent so it never blocks canvas input. */}
      <div
        aria-hidden
        className={
          'pointer-events-none absolute inset-0 z-10 rounded-sm ring-inset transition-all duration-200 ' +
          (focused ? 'ring-2 ring-cyan-400/45' : 'ring-0 ring-transparent')
        }
      />
      {/* Shortcut-state hint (bottom-left): tells the user how to enable canvas
          shortcuts when unfocused, and confirms they're live when focused. */}
      <div
        className={
          // Lifted above tldraw's bottom toolbar row (zoom "22%" menu sits at
          // bottom-left and was covering this hint).
          'pointer-events-none absolute bottom-16 left-3 z-10 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium shadow-lg backdrop-blur transition-colors duration-200 ' +
          (focused
            ? 'bg-cyan-600/85 text-white'
            : 'bg-zinc-900/80 text-zinc-300 ring-1 ring-zinc-700/70')
        }
      >
        <span aria-hidden>{focused ? '⌨' : '🖱'}</span>
        <span>{focused ? '画布快捷键已启用 · 滚轮缩放 / Ctrl+Z 撤销' : '点击或悬停画布以启用快捷键'}</span>
      </div>
      {pill ? (
        <div className="pointer-events-none absolute right-3 top-3 z-10 rounded-full bg-cyan-600/90 px-3 py-1 text-xs font-medium text-white shadow-lg">
          {pill}
        </div>
      ) : null}
    </div>
  )
}

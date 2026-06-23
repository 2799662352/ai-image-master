import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { type Editor, Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'
import type { EditRequestQueueStatus } from '../../../../types/canvas'
import { canvasBridge } from './canvas/canvasBridge'
import { useAgentChatStore } from '../agent-chat/store'
import { parseFileDrop } from '../file-explorer/dragHelpers'

/** Custom MIME the file-explorer tree puts dragged paths in (dragHelpers). */
const FILE_PATHS_MIME = 'application/x-catimation-file-paths'

type CanvasAgentApi = {
  submitCanvasEditRequest: (request: unknown) => void
  getCanvasEditQueueStatus: () => Promise<EditRequestQueueStatus>
}

function getCanvasApi(): CanvasAgentApi | undefined {
  return (window as Window & { electronAPI?: { agent?: CanvasAgentApi } }).electronAPI?.agent
}

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

export function CanvasSection(): React.JSX.Element {
  const editorRef = useRef<Editor | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<EditRequestQueueStatus | null>(null)
  const [flash, setFlash] = useState<string>('')

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
      getCanvasApi()?.submitCanvasEditRequest({
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

      return () => {
        if (idle) window.clearTimeout(idle)
        unlisten()
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
      showFlash(placed > 0 ? `已把 ${placed} 个文件放到画布` : '只能把图片或视频拖到画布上')
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
      const api = getCanvasApi()
      if (!api) return
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
        persistenceKey="catimation-canvas"
        onMount={handleMount}
        maxAssetSize={CANVAS_MAX_ASSET_SIZE}
        maxImageDimension={CANVAS_MAX_IMAGE_DIMENSION}
      />
      {pill ? (
        <div className="pointer-events-none absolute right-3 top-3 z-10 rounded-full bg-cyan-600/90 px-3 py-1 text-xs font-medium text-white shadow-lg">
          {pill}
        </div>
      ) : null}
    </div>
  )
}

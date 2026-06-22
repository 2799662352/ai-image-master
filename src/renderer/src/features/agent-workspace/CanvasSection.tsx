import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { type Editor, Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'
import type { EditRequestQueueStatus } from '../../../../types/canvas'
import { canvasBridge } from './canvas/canvasBridge'

type CanvasAgentApi = {
  submitCanvasEditRequest: (request: unknown) => void
  getCanvasEditQueueStatus: () => Promise<EditRequestQueueStatus>
}

function getCanvasApi(): CanvasAgentApi | undefined {
  return (window as Window & { electronAPI?: { agent?: CanvasAgentApi } }).electronAPI?.agent
}

export function CanvasSection(): React.JSX.Element {
  const editorRef = useRef<Editor | null>(null)
  const [status, setStatus] = useState<EditRequestQueueStatus | null>(null)
  const [notice, setNotice] = useState<string>('图片好了就可以标注，标完点「按标注修图」。')

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor
    canvasBridge.setEditor(editor)
    return () => {
      canvasBridge.setEditor(null)
      editorRef.current = null
    }
  }, [])

  useEffect(() => {
    let disposed = false
    const poll = async () => {
      const api = getCanvasApi()
      if (!api) return
      try {
        const s = await api.getCanvasEditQueueStatus()
        if (!disposed) setStatus(s)
      } catch { /* ignore */ }
    }
    void poll()
    const id = window.setInterval(poll, 5000)
    return () => { disposed = true; window.clearInterval(id) }
  }, [])

  const onSubmitEdit = useCallback(() => {
    const target = editorRef.current?.getSelectedShapeIds().map(String)[0]
    const built = canvasBridge.buildEditRequest(target)
    if (!built.ok || !built.requestPayload) {
      setNotice(built.reason ?? '无法提交修图。')
      return
    }
    getCanvasApi()?.submitCanvasEditRequest(built.requestPayload)
    setNotice('已提交标注。Codex 监听到后会自动修图，新版放到旧图右侧。')
  }, [])

  const listenerLabel = status?.processingCount
    ? 'Codex 正在修图…'
    : status?.listenerActive
      ? 'Codex 监听中：标完点「按标注修图」'
      : 'Codex 未监听：回到聊天说「开启自动修图」'

  return (
    <div className="flex h-[80vh] w-full gap-3">
      <div className="relative flex-1 overflow-hidden rounded-lg border border-zinc-800/60">
        <Tldraw persistenceKey="catimation-canvas" onMount={handleMount} />
      </div>
      <aside className="flex w-64 shrink-0 flex-col gap-3 rounded-lg border border-zinc-800/60 p-3 text-sm">
        <div className="rounded bg-zinc-900/60 p-2 text-zinc-300">{listenerLabel}</div>
        <button
          type="button"
          onClick={onSubmitEdit}
          className="rounded bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-500"
        >
          按标注修图
        </button>
        <p className="text-zinc-400">{notice}</p>
        {status ? (
          <div className="mt-auto text-xs text-zinc-500">
            queued {status.queuedCount} · processing {status.processingCount}
          </div>
        ) : null}
      </aside>
    </div>
  )
}

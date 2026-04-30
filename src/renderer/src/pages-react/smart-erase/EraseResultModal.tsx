import { useRef, useEffect, useState, useMemo } from 'react'
import { useEraseSessionStore } from '../../stores/useEraseSessionStore'
import { useErasePersistStore } from '../../stores/useErasePersistStore'
import { useToastStore } from '../../stores'

const api = (window as any).electronAPI

export function EraseResultModal() {
  const modalItemId = useEraseSessionStore((s) => s.modalItemId)
  const setModalItemId = useEraseSessionStore((s) => s.setModalItemId)
  const history = useErasePersistStore((s) => s.history)
  const removeHistory = useErasePersistStore((s) => s.removeHistory)
  const addToast = useToastStore((s) => s.addToast)

  const dialogRef = useRef<HTMLDialogElement>(null)
  const [compareOpen, setCompareOpen] = useState(false)
  const [originalErrored, setOriginalErrored] = useState(false)

  const item = useMemo(
    () => history.find((h) => h.id === modalItemId),
    [history, modalItemId],
  )

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (item) {
      if (!dialog.open) dialog.showModal()
    } else {
      if (dialog.open) dialog.close()
    }
  }, [item])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const onClose = () => {
      setModalItemId(null)
      setCompareOpen(false)
      setOriginalErrored(false)
    }
    dialog.addEventListener('close', onClose)
    return () => dialog.removeEventListener('close', onClose)
  }, [setModalItemId])

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target === dialogRef.current) dialogRef.current?.close()
  }

  if (!item) return <dialog ref={dialogRef} className="hidden" />

  const expired = item.videoExpiresAt > 0 && item.videoExpiresAt < Date.now()
  const canCompare = !!item.originalFilePath && !originalErrored

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(item.videoUrl)
      addToast({ message: 'URL 已复制', type: 'success' })
    } catch {
      addToast({ message: '复制失败', type: 'error' })
    }
  }

  const handleDownload = async () => {
    if (expired) { addToast({ message: 'URL 已过期', type: 'error' }); return }
    const downloadName = item.filename.replace(/\.[^.]+$/, '') + '_erased.mp4'
    try {
      const res = await api?.smartEraseDownloadFile?.(item.videoUrl, downloadName)
      if (res?.canceled) return
      if (res?.success) {
        addToast({ message: '下载完成', type: 'success' })
      } else {
        addToast({ message: res?.error || '下载失败', type: 'error' })
      }
    } catch {
      addToast({ message: '下载失败', type: 'error' })
    }
  }

  const handleRemove = () => {
    const cosKeys = [item.outputCosKey, item.inputCosKey].filter(Boolean) as string[]
    if (cosKeys.length > 0) {
      api?.smartEraseDeleteRemote?.(cosKeys)?.catch((err: unknown) => {
        console.warn('[smart-erase] remote delete failed:', err)
      })
    }
    removeHistory(item.id)
    dialogRef.current?.close()
  }

  return (
    <dialog
      ref={dialogRef}
      onClick={handleBackdropClick}
      className="backdrop:bg-black/85 backdrop:backdrop-blur-sm bg-transparent p-0 max-w-[1000px] w-full mx-auto border-0"
    >
      <div
        className="bg-[color:var(--donor-bg-0)] border border-[color:var(--donor-cyan)]/40 p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="d-mono text-[12px] tracking-widest text-[color:var(--donor-cyan)]">
            ⊳ {item.filename}
          </span>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className="d-mono text-xs text-[color:var(--donor-ink-dim)] hover:text-[color:var(--donor-red)]"
          >
            [×]
          </button>
        </div>

        <div className={`grid gap-3 ${compareOpen && canCompare ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {compareOpen && canCompare && (
            <div className="space-y-1">
              <div className="d-mono text-[10px] tracking-widest text-[color:var(--donor-ink-mute)]">
                // ORIGINAL
              </div>
              <video
                key={`orig-${item.id}`}
                src={`file:///${item.originalFilePath.replace(/\\/g, '/')}`}
                controls
                className="w-full max-h-[60vh] object-contain mx-auto bg-black"
                onError={() => setOriginalErrored(true)}
              />
            </div>
          )}
          <div className="space-y-1">
            {compareOpen && canCompare && (
              <div className="d-mono text-[10px] tracking-widest text-[color:var(--donor-green)]">
                // ERASED
              </div>
            )}
            <video
              key={`out-${item.id}`}
              src={item.videoUrl}
              poster={item.posterDataUrl || undefined}
              controls
              className="w-full max-h-[60vh] object-contain mx-auto bg-black"
            />
          </div>
        </div>

        <div className="flex gap-2 flex-wrap">
          {canCompare && (
            <button
              type="button"
              onClick={() => setCompareOpen((v) => !v)}
              className="d-mono text-[10px] tracking-widest px-3 py-1.5 border border-[color:var(--donor-cyan)] text-[color:var(--donor-cyan)] hover:bg-[color:var(--donor-cyan)]/10"
            >
              {compareOpen ? '[ 关闭对比 ]' : '[ 对比原视频 ]'}
            </button>
          )}
          <button
            type="button"
            onClick={handleDownload}
            disabled={expired}
            className="d-mono text-[10px] tracking-widest px-3 py-1.5 border border-[color:var(--donor-green)] text-[color:var(--donor-green)] hover:bg-[color:var(--donor-green)]/10 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            [ 下载 ]
          </button>
          <button
            type="button"
            onClick={handleCopyUrl}
            disabled={expired}
            className="d-mono text-[10px] tracking-widest px-3 py-1.5 border border-[color:var(--donor-ink)] text-[color:var(--donor-ink)] hover:bg-[color:var(--donor-ink)]/10 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            [ 复制 URL ]
          </button>
          <button
            type="button"
            onClick={handleRemove}
            className="d-mono text-[10px] tracking-widest px-3 py-1.5 border border-[color:var(--donor-red)]/60 text-[color:var(--donor-red)]/80 hover:bg-[color:var(--donor-red)]/10 ml-auto"
          >
            [ 移除历史 ]
          </button>
        </div>
      </div>
    </dialog>
  )
}

import { useEffect } from 'react'
import { useEraseSessionStore } from '../../stores/useEraseSessionStore'
import { useErasePersistStore } from '../../stores/useErasePersistStore'
import { useToastStore } from '../../stores'
import type {
  EraseProgressEvent,
  EraseFinishedEvent,
  EraseFailedEvent,
} from '../../../../types/smartErase'

const api = (window as any).electronAPI

/**
 * Single subscription to the main-process smart-erase event stream. Routes
 * each event to the right store + toast. Mount once at the top of the
 * SmartErase page tree (cleanup removes all listeners on unmount).
 */
export function useEraseEvents(): void {
  useEffect(() => {
    if (!api?.onSmartEraseEvent) return

    api.onSmartEraseEvent((channel: string, data: any) => {
      const session = useEraseSessionStore.getState()
      const persist = useErasePersistStore.getState()
      const toast = useToastStore.getState()

      if (channel === 'erase:progress') {
        const d = data as EraseProgressEvent
        session.updateTaskStatus(d.taskId, d.status, d.uploadProgress, d.mpsTaskId)
        if (d.status === 'cancelled') {
          // Cancellation comes through as a progress event; UI also wants to
          // remove the row + toast. Failure path uses erase:failed instead.
          session.removeActiveTask(d.taskId)
          toast.addToast({ message: '已取消 / CANCELLED', type: 'info' })
        }
      } else if (channel === 'erase:finished') {
        const d = data as EraseFinishedEvent
        const task = session.activeTasks.find((t) => t.id === d.taskId)
        if (!task) {
          // Task was probably cancelled+removed in a race; ignore the late finish.
          return
        }
        persist.pushHistory({
          id: task.id,
          filename: task.filename,
          fileSize: task.fileSize,
          durationSeconds: task.durationSeconds,
          videoUrl: d.videoUrl,
          videoExpiresAt: d.videoExpiresAt,
          posterDataUrl: task.posterDataUrl ?? '',
          outputCosKey: d.outputCosKey,
          inputCosKey: d.inputCosKey,
          originalFilePath: task.filePath ?? '',
          createdAt: task.startedAt,
        })
        session.removeActiveTask(d.taskId)
        session.setRecentlyFinished(task.id)
        // Highlight ring for 3s (matches storyboard-split's UX).
        setTimeout(() => {
          useEraseSessionStore.getState().setRecentlyFinished(null)
        }, 3000)
        toast.addToast({ message: '完成 / DONE', type: 'success' })
      } else if (channel === 'erase:failed') {
        const d = data as EraseFailedEvent
        session.failTask(d.taskId, d.errorMessage, d.errorCode)
        toast.addToast({
          message: d.errorMessage || '处理失败 / FAILED',
          type: 'error',
        })
      }
    })

    return () => {
      api.removeSmartEraseListeners?.()
    }
  }, [])
}

// CRITICAL: do not move this hook out of SmartErasePage — see spec §A3.
// The current mount strategy (display:none toggle in react-app/main.tsx:238-260)
// guarantees this component never unmounts on tab switch. Moving to an unmount-
// based router would silently lose erase:finished events and pin the progress
// bar at 95% forever.
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

export function useEraseEvents(): void {
  useEffect(() => {
    if (!api?.onSmartEraseEvent) return

    api.onSmartEraseEvent((channel: string, data: any) => {
      const session = useEraseSessionStore.getState()
      const persist = useErasePersistStore.getState()
      const toast = useToastStore.getState()

      if (channel === 'erase:progress') {
        const d = data as EraseProgressEvent
        const prev = session.activeTasks.find((t) => t.id === d.taskId)
        // Only assign optional fields when the event actually carries them.
        // The 'submitting' emit (before the first DescribeTaskDetail poll)
        // omits mpsProgress + taskDetail; if we wrote `undefined` here, the
        // store's spread would clobber any previously-seen real progress.
        const patch: Partial<typeof prev & {}> = {
          mpsTaskId: d.mpsTaskId,
        }
        if (d.uploadProgress !== undefined) patch.uploadProgress = d.uploadProgress
        if (d.mpsProgress !== undefined) patch.mpsProgress = d.mpsProgress
        if (d.taskDetail !== undefined) patch.taskDetail = d.taskDetail
        if (d.status === 'processing' && prev?.status !== 'processing') {
          patch.processingStartedAt = Date.now()
        }
        session.updateTaskStatus(d.taskId, d.status, patch)

        if (d.status === 'cancelled') {
          session.removeActiveTask(d.taskId)
          toast.addToast({ message: '已取消 / CANCELLED', type: 'info' })
        }
      } else if (channel === 'erase:finished') {
        const d = data as EraseFinishedEvent
        const task = session.activeTasks.find((t) => t.id === d.taskId)
        if (!task) return

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
          mpsTaskId: task.mpsTaskId,
          finishedAt: Date.now(),
          tool: task.tool,
        })
        session.removeActiveTask(d.taskId)
        session.setRecentlyFinished(task.id)
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

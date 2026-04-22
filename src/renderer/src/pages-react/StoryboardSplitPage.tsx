import React, { useEffect, useCallback } from 'react'
import { useSplitSessionStore, useSplitPersistStore, useToastStore } from '../stores'
import type { SplitTask, SplitProgressEvent, SplitFinishedEvent, SplitFailedEvent } from '../../../types/storyboardSplit'
import { Dropzone } from './storyboard-split/Dropzone'
import { DefaultsBar } from './storyboard-split/DefaultsBar'
import { TaskCard } from './storyboard-split/TaskCard'
import { HistoryDrawer } from './storyboard-split/HistoryDrawer'

const api = (window as any).electronAPI

export default function StoryboardSplitPage() {
  const tasks = useSplitSessionStore((s) => s.tasks)
  const drawerOpen = useSplitSessionStore((s) => s.drawerOpen)
  const addTask = useSplitSessionStore((s) => s.addTask)
  const removeTask = useSplitSessionStore((s) => s.removeTask)
  const updateTaskProgress = useSplitSessionStore((s) => s.updateTaskProgress)
  const finishTask = useSplitSessionStore((s) => s.finishTask)
  const failTask = useSplitSessionStore((s) => s.failTask)
  const cancelTaskInStore = useSplitSessionStore((s) => s.cancelTask)
  const clearImageData = useSplitSessionStore((s) => s.clearImageData)
  const reopenHistory = useSplitSessionStore((s) => s.reopenHistory)
  const toggleDrawer = useSplitSessionStore((s) => s.toggleDrawer)

  const history = useSplitPersistStore((s) => s.history)
  const defaultConfig = useSplitPersistStore((s) => s.defaultConfig)
  const pushHistory = useSplitPersistStore((s) => s.pushHistory)
  const removeHistory = useSplitPersistStore((s) => s.removeHistory)
  const updateDefaultConfig = useSplitPersistStore((s) => s.updateDefaultConfig)

  const addToast = useToastStore((s) => s.addToast)

  const [hasCredentials, setHasCredentials] = React.useState(true)

  useEffect(() => {
    api?.storyboardSplitGetConfig?.().then((res: any) => {
      if (res?.success) {
        setHasCredentials(res.credentials?.hasCredentials ?? false)
        if (res.defaults) updateDefaultConfig(res.defaults)
      }
    })
  }, [])

  useEffect(() => {
    if (!api?.onStoryboardSplitEvent) return

    api.onStoryboardSplitEvent((channel: string, data: any) => {
      if (channel === 'storyboard-split:progress') {
        const d = data as SplitProgressEvent
        updateTaskProgress(d.taskId, d.status, d.progress, d.stage)
      } else if (channel === 'storyboard-split:finished') {
        const d = data as SplitFinishedEvent
        finishTask(d.taskId, d.results)
        const task = useSplitSessionStore.getState().tasks.find((t) => t.id === d.taskId)
        if (task) {
          pushHistory({
            id: task.id,
            filename: task.filename,
            thumbnailDataUrl: task.thumbnailDataUrl || '',
            config: task.config,
            results: d.results,
            createdAt: task.createdAt,
            finishedAt: Date.now(),
          })
        }
      } else if (channel === 'storyboard-split:failed') {
        const d = data as SplitFailedEvent
        failTask(d.taskId, d.error, d.errorCode)
      }
    })

    return () => {
      api.removeStoryboardSplitListeners?.()
    }
  }, [])

  const handleFiles = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        const dataUrl = await readFileAsDataUrl(file)
        const thumb = await createThumbnail(dataUrl)
        const taskId = crypto.randomUUID()
        const task: SplitTask = {
          id: taskId,
          filename: file.name,
          imageDataUrl: dataUrl,
          thumbnailDataUrl: thumb,
          status: 'pending',
          progress: 0,
          config: { ...defaultConfig },
          createdAt: Date.now(),
        }
        addTask(task)

        api?.storyboardSplitSubmit?.({
          taskId,
          base64Data: dataUrl,
          filename: file.name,
          config: task.config,
        }).then((res: any) => {
          if (res && !res.success) {
            failTask(taskId, res.error || '提交失败', res.errorCode)
            addToast({ message: res.error || '拆图任务提交失败', type: 'error' })
          }
          clearImageData(taskId)
        })
      }
    },
    [defaultConfig, addTask, failTask, clearImageData, addToast]
  )

  const handleCancel = useCallback(
    (taskId: string) => {
      cancelTaskInStore(taskId)
      api?.storyboardSplitCancel?.(taskId)
    },
    [cancelTaskInStore]
  )

  const handleRetry = useCallback(
    (taskId: string) => {
      addToast({ message: '重试需重新选择原图', type: 'info' })
      removeTask(taskId)
    },
    [removeTask, addToast]
  )

  return (
    <div className="flex h-full">
      <div className="flex-1 p-6 space-y-4 overflow-y-auto">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-orbitron text-cyberpunk-yellow">🧩 宫格拆图</h1>
          <button
            onClick={toggleDrawer}
            className="text-sm px-3 py-1.5 bg-zinc-800 text-zinc-300 border border-zinc-700 rounded hover:bg-zinc-700 transition-colors"
          >
            📜 历史 ({history.length})
          </button>
        </div>

        {!hasCredentials && (
          <div className="p-3 bg-red-900/30 border border-red-700 text-red-300 text-sm rounded">
            ⚠️ 未配置腾讯云密钥，请到 <strong>设置</strong> 页面配置后使用
          </div>
        )}

        <DefaultsBar config={defaultConfig} onChange={updateDefaultConfig} />

        <Dropzone
          disabled={!hasCredentials}
          onFiles={handleFiles}
          onReject={(reason) => addToast({ message: reason, type: 'warning' })}
        />

        {tasks.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                onCancel={handleCancel}
                onRetry={handleRetry}
                onRemove={removeTask}
              />
            ))}
          </div>
        )}
      </div>

      <HistoryDrawer
        open={drawerOpen}
        history={history}
        onClose={toggleDrawer}
        onReopen={reopenHistory}
        onDelete={removeHistory}
      />
    </div>
  )
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.readAsDataURL(file)
  })
}

async function createThumbnail(dataUrl: string): Promise<string> {
  if (!dataUrl) return ''
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      const MAX = 200
      let w = img.width, h = img.height
      if (w > h) { h = Math.round((h / w) * MAX); w = MAX }
      else { w = Math.round((w / h) * MAX); h = MAX }
      canvas.width = w
      canvas.height = h
      canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL('image/jpeg', 0.7))
    }
    img.onerror = () => resolve('')
    img.src = dataUrl
  })
}

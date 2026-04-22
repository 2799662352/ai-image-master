import React, { useEffect, useCallback, useState } from 'react'
import { useSplitSessionStore, useSplitPersistStore, useToastStore } from '../stores'
import type {
  SplitTask,
  SplitProgressEvent,
  SplitFinishedEvent,
  SplitFailedEvent,
  CredentialState,
} from '../../../types/storyboardSplit'
import DonorShell from '../components/donor/DonorShell'
import SplitHeader from './storyboard-split/SplitHeader'
import { DefaultsBar } from './storyboard-split/DefaultsBar'
import { Dropzone } from './storyboard-split/Dropzone'
import ActiveQueue from './storyboard-split/ActiveQueue'
import ResultsGrid from './storyboard-split/ResultsGrid'
import SplitPreview from './storyboard-split/SplitPreview'
import { HistoryDrawer } from './storyboard-split/HistoryDrawer'

const api = (window as any).electronAPI

export default function StoryboardSplitPage() {
  const activeTasks = useSplitSessionStore((s) => s.activeTasks)
  const recentlyFinished = useSplitSessionStore((s) => s.recentlyFinished)
  const selectedHistoryId = useSplitSessionStore((s) => s.selectedHistoryId)
  const addTask = useSplitSessionStore((s) => s.addTask)
  const removeActiveTask = useSplitSessionStore((s) => s.removeActiveTask)
  const updateTaskProgress = useSplitSessionStore((s) => s.updateTaskProgress)
  const failTask = useSplitSessionStore((s) => s.failTask)
  const cancelTaskInStore = useSplitSessionStore((s) => s.cancelTask)
  const clearImageData = useSplitSessionStore((s) => s.clearImageData)
  const setRecentlyFinished = useSplitSessionStore((s) => s.setRecentlyFinished)
  const setSelectedHistoryId = useSplitSessionStore((s) => s.setSelectedHistoryId)
  const setPreviewIndex = useSplitSessionStore((s) => s.setPreviewIndex)

  const history = useSplitPersistStore((s) => s.history)
  const defaultConfig = useSplitPersistStore((s) => s.defaultConfig)
  const gridCols = useSplitPersistStore((s) => s.gridCols)
  const historyDrawerOpen = useSplitPersistStore((s) => s.historyDrawerOpen)
  const pushHistory = useSplitPersistStore((s) => s.pushHistory)
  const removeHistory = useSplitPersistStore((s) => s.removeHistory)
  const updateDefaultConfig = useSplitPersistStore((s) => s.updateDefaultConfig)
  const setGridCols = useSplitPersistStore((s) => s.setGridCols)
  const toggleHistoryDrawer = useSplitPersistStore((s) => s.toggleHistoryDrawer)

  const addToast = useToastStore((s) => s.addToast)

  const [credentialState, setCredentialState] = React.useState<CredentialState | null>(null)

  useEffect(() => {
    api?.storyboardSplitGetConfig?.().then((res: any) => {
      if (res?.success) {
        setCredentialState(res.credentials ?? null)
      }
    })
  }, [])

  useEffect(() => {
    if (!api?.onStoryboardSplitEvent) return

    api.onStoryboardSplitEvent((channel: string, data: any) => {
      const session = useSplitSessionStore.getState()
      const persist = useSplitPersistStore.getState()
      const toast = useToastStore.getState()

      if (channel === 'storyboard-split:progress') {
        const d = data as SplitProgressEvent
        session.updateTaskProgress(d.taskId, d.status, d.progress, d.stage)
      } else if (channel === 'storyboard-split:finished') {
        const d = data as SplitFinishedEvent
        const task = session.activeTasks.find((t) => t.id === d.taskId)
        if (task) {
          persist.pushHistory({
            id: task.id,
            filename: task.filename,
            thumbnailDataUrl: task.thumbnailDataUrl || '',
            config: task.config,
            results: d.results,
            createdAt: task.createdAt,
            finishedAt: Date.now(),
            coverUrl: d.results[0]?.url,
            inputCosKey: d.inputCosKey,
            rows: d.rows,
            cols: d.cols,
          })
          session.removeActiveTask(d.taskId)
          session.setRecentlyFinished(task.id)
          setTimeout(() => useSplitSessionStore.getState().setRecentlyFinished(null), 3000)
          toast.addToast({ message: '完成 / DONE', type: 'success' })
        }
      } else if (channel === 'storyboard-split:failed') {
        const d = data as SplitFailedEvent
        session.failTask(d.taskId, d.error, d.errorCode)
        toast.addToast({ message: d.error || '拆图失败 / FAILED', type: 'error' })
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
            failTask(taskId, res.error || '提交失敗', res.errorCode)
            addToast({ message: res.error || '拆図タスク提出失敗', type: 'error' })
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

  const handlePreview = useCallback(
    (id: string) => {
      setPreviewIndex(0)
      setSelectedHistoryId(id)
    },
    [setSelectedHistoryId, setPreviewIndex]
  )

  const handleDelete = useCallback(
    (id: string) => {
      const item = useSplitPersistStore.getState().history.find((h) => h.id === id)
      removeHistory(id)
      if (useSplitSessionStore.getState().selectedHistoryId === id) setSelectedHistoryId(null)
      if (item) {
        const cosPaths = item.results.map((r) => r.cosPath)
        if (item.inputCosKey) cosPaths.push(item.inputCosKey)
        api?.storyboardSplitDeleteRemote?.(cosPaths)?.catch(console.warn)
      }
      addToast({ message: '削除しました / DELETED', type: 'success' })
    },
    [removeHistory, setSelectedHistoryId, addToast]
  )

  const previewItem = selectedHistoryId
    ? history.find((h) => h.id === selectedHistoryId) ?? null
    : null

  return (
    <DonorShell>
      <div
        aria-hidden="true"
        className="pointer-events-none select-none d-mono font-black leading-none"
        style={{
          position: 'absolute',
          right: '12px',
          top: '-8px',
          fontSize: '180px',
          opacity: 0.08,
          color: 'var(--donor-cyan)',
          zIndex: 1,
        }}
      >
        07
      </div>

      <SplitHeader
        credentialState={credentialState}
        gridCols={gridCols}
        historyCount={history.length}
        onGridColsChange={setGridCols}
        onToggleHistory={toggleHistoryDrawer}
      />

      {credentialState && !credentialState.hasCredentials && (
        <CredentialSetupPanel
          onSaved={(creds) => {
            setCredentialState({ hasCredentials: true, credentialSource: 'store', secretIdMasked: creds.secretId.slice(0, 4) + '****', bucket: creds.bucket, region: creds.region })
          }}
        />
      )}

      <div className="space-y-4">
        <DefaultsBar config={defaultConfig} onChange={updateDefaultConfig} />

        <Dropzone
          disabled={credentialState !== null && !credentialState.hasCredentials}
          onFiles={handleFiles}
          onReject={(reason) => addToast({ message: reason, type: 'warning' })}
        />

        <ActiveQueue tasks={activeTasks} onCancel={handleCancel} />

        <ResultsGrid
          items={history}
          gridCols={gridCols}
          highlightId={recentlyFinished}
          onPreview={handlePreview}
          onDelete={handleDelete}
        />
      </div>

      <footer className="mt-6 pt-3 border-t border-[color:var(--donor-magenta-dim)] d-mono text-[10px] text-[color:var(--donor-ink-mute)] flex items-center justify-between flex-wrap gap-2">
        <span>// GRID_SPLIT_v2.0 — active {activeTasks.length} / archive {history.length}</span>
        <span className="d-neon-text-c">[ EOF ]</span>
      </footer>

      {previewItem && (
        <SplitPreview item={previewItem} onClose={() => setSelectedHistoryId(null)} />
      )}

      <HistoryDrawer
        open={historyDrawerOpen}
        history={history}
        onClose={toggleHistoryDrawer}
        onPreview={handlePreview}
        onDelete={handleDelete}
      />
    </DonorShell>
  )
}

function CredentialSetupPanel({ onSaved }: { onSaved: (creds: { secretId: string; secretKey: string; bucket: string; region: string }) => void }) {
  const [secretId, setSecretId] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [bucket, setBucket] = useState('map-tiles-bucket-1345773498')
  const [region, setRegion] = useState('ap-guangzhou')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleSave = async () => {
    if (!secretId.trim() || !secretKey.trim()) {
      setError('SecretId 和 SecretKey 不能为空')
      return
    }
    setSaving(true)
    setError('')
    try {
      const res = await api?.storyboardSplitSetCredentials?.({ secretId: secretId.trim(), secretKey: secretKey.trim(), bucket: bucket.trim(), region: region.trim() })
      if (res?.success) {
        onSaved({ secretId: secretId.trim(), secretKey: secretKey.trim(), bucket: bucket.trim(), region: region.trim() })
      } else {
        setError('保存失败，请重试')
      }
    } catch {
      setError('保存失败，请检查网络')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="d-neon-frame p-6 mb-4" style={{ borderColor: 'var(--donor-red)' }}>
      <div className="d-mono text-sm text-[color:var(--donor-red)] tracking-widest mb-4 flex items-center gap-2">
        <span style={{ fontSize: '18px' }}>⚠</span>
        <span>未配置腾讯云密钥 — 宫格拆图需要腾讯云 COS/MPS 服务</span>
      </div>

      <div className="text-[color:var(--donor-ink-dim)] text-xs mb-4 leading-relaxed">
        请前往
        <a href="https://console.cloud.tencent.com/cam/capi" target="_blank" rel="noopener noreferrer" className="text-[color:var(--donor-cyan)] underline mx-1">腾讯云控制台 → 访问管理 → API密钥</a>
        获取 SecretId 和 SecretKey，然后在下方填入：
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div>
          <label className="d-mono text-[10px] text-[color:var(--donor-ink-mute)] tracking-widest block mb-1">SECRET_ID *</label>
          <input
            type="text"
            value={secretId}
            onChange={(e) => setSecretId(e.target.value)}
            placeholder="AKIDxxxxxxxxxxxxxxxx"
            className="w-full px-3 py-2 bg-[color:var(--donor-bg-0)] border border-[color:var(--donor-magenta-dim)] text-[color:var(--donor-ink)] d-mono text-xs focus:outline-none focus:border-[color:var(--donor-cyan)]"
          />
        </div>
        <div>
          <label className="d-mono text-[10px] text-[color:var(--donor-ink-mute)] tracking-widest block mb-1">SECRET_KEY *</label>
          <input
            type="password"
            value={secretKey}
            onChange={(e) => setSecretKey(e.target.value)}
            placeholder="xxxxxxxxxxxxxxxxxxxxxxxx"
            className="w-full px-3 py-2 bg-[color:var(--donor-bg-0)] border border-[color:var(--donor-magenta-dim)] text-[color:var(--donor-ink)] d-mono text-xs focus:outline-none focus:border-[color:var(--donor-cyan)]"
          />
        </div>
        <div>
          <label className="d-mono text-[10px] text-[color:var(--donor-ink-mute)] tracking-widest block mb-1">BUCKET</label>
          <input
            type="text"
            value={bucket}
            onChange={(e) => setBucket(e.target.value)}
            className="w-full px-3 py-2 bg-[color:var(--donor-bg-0)] border border-[color:var(--donor-magenta-dim)] text-[color:var(--donor-ink)] d-mono text-xs focus:outline-none focus:border-[color:var(--donor-cyan)]"
          />
        </div>
        <div>
          <label className="d-mono text-[10px] text-[color:var(--donor-ink-mute)] tracking-widest block mb-1">REGION</label>
          <input
            type="text"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            className="w-full px-3 py-2 bg-[color:var(--donor-bg-0)] border border-[color:var(--donor-magenta-dim)] text-[color:var(--donor-ink)] d-mono text-xs focus:outline-none focus:border-[color:var(--donor-cyan)]"
          />
        </div>
      </div>

      {error && <div className="d-mono text-[11px] text-[color:var(--donor-red)] mb-3">{error}</div>}

      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="d-mono text-xs tracking-widest uppercase px-6 py-2 border border-[color:var(--donor-cyan)] text-[color:var(--donor-cyan)] hover:bg-[color:var(--donor-cyan)] hover:text-[color:var(--donor-bg-0)] transition-colors disabled:opacity-50"
      >
        {saving ? 'SAVING...' : '[ SAVE & ACTIVATE ]'}
      </button>
    </div>
  )
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

async function createThumbnail(dataUrl: string): Promise<string> {
  if (!dataUrl) return ''
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        const MAX = 200
        let w = img.width, h = img.height
        if (w > h) { h = Math.round((h / w) * MAX); w = MAX }
        else { w = Math.round((w / h) * MAX); h = MAX }
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.7))
      } catch {
        resolve('')
      }
    }
    img.onerror = () => resolve('')
    img.src = dataUrl
  })
}

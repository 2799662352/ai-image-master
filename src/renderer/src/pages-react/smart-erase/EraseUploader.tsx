import { useState, useRef, useCallback } from 'react'
import { useEraseSessionStore, type EraseSessionTask } from '../../stores/useEraseSessionStore'
import { useErasePersistStore } from '../../stores/useErasePersistStore'
import { useToastStore } from '../../stores'
import type { EraseProbeResult } from '../../../../types/smartErase'

const ACCEPTED_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/avi']
const ACCEPTED_EXT_RE = /\.(mp4|mov|webm|mkv|avi)$/i
const MAX_SIZE = 500 * 1024 * 1024 // 500 MB per file

const COST_GUARD_COUNT = 10
const COST_GUARD_DURATION_S = 60 * 60 // 60 minutes total

const api = (window as any).electronAPI

interface EraseUploaderProps {
  disabled?: boolean
}

/**
 * Drag/drop entry point. On drop:
 *   1. Filter for accepted video types.
 *   2. Call electronAPI.getFilePath(file) for each (returns '' for synthetic
 *      Files like clipboard pastes — those are dropped with a warning).
 *   3. Probe metadata via smart-erase:probe-batch (fast, parallel ffprobe).
 *   4. If count > 10 OR total duration > 60min → cost-confirm modal.
 *   5. Otherwise (or after confirm) → submit each via smart-erase:submit.
 *
 * Submission is fire-and-forget; progress arrives via IPC events handled
 * by useEraseEvents.
 */
export function EraseUploader({ disabled }: EraseUploaderProps) {
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const addTask = useEraseSessionStore((s) => s.addTask)
  const pendingProbes = useEraseSessionStore((s) => s.pendingProbes)
  const showCostConfirm = useEraseSessionStore((s) => s.showCostConfirm)
  const setPendingProbes = useEraseSessionStore((s) => s.setPendingProbes)
  const setShowCostConfirm = useEraseSessionStore((s) => s.setShowCostConfirm)

  const hydrated = useErasePersistStore((s) => s._hasHydrated)
  const addToast = useToastStore((s) => s.addToast)

  const validate = useCallback(
    (files: FileList | File[]): File[] => {
      const valid: File[] = []
      let rejectedType = 0
      let rejectedSize = 0
      for (const f of Array.from(files)) {
        // Some browsers don't set file.type for .mkv etc.; fall back to extension.
        const typeOk = ACCEPTED_TYPES.includes(f.type) || ACCEPTED_EXT_RE.test(f.name)
        if (!typeOk) {
          rejectedType++
          continue
        }
        if (f.size > MAX_SIZE) {
          rejectedSize++
          continue
        }
        valid.push(f)
      }
      if (rejectedType > 0) addToast({ message: `${rejectedType} 个文件格式不支持`, type: 'warning' })
      if (rejectedSize > 0) addToast({ message: `${rejectedSize} 个文件超过 500 MB`, type: 'warning' })
      return valid
    },
    [addToast],
  )

  const submitAll = useCallback(
    async (probes: EraseProbeResult[]) => {
      for (const probe of probes) {
        if (probe.warning) {
          addToast({
            message: `${probe.filename || '未知文件'}: ${labelForWarning(probe.warning)}`,
            type: 'warning',
          })
          continue
        }
        try {
          const ret = await api?.smartEraseSubmit?.({
            filePath: probe.filePath,
            filename: probe.filename,
            fileSize: probe.fileSize,
            durationSeconds: probe.durationSeconds,
          })
          if (!ret?.success) {
            addToast({
              message: ret?.error || `提交失败: ${probe.filename}`,
              type: 'error',
            })
            continue
          }
          // Optimistically register so the UI shows the task before the
          // first progress event arrives.
          const sessionTask: EraseSessionTask = {
            id: ret.taskId,
            filename: probe.filename,
            fileSize: probe.fileSize,
            durationSeconds: probe.durationSeconds,
            status: 'queued-upload',
            startedAt: Date.now(),
            filePath: probe.filePath,
            posterDataUrl: ret.posterDataUrl ?? '',
          }
          addTask(sessionTask)
        } catch (err: any) {
          addToast({ message: `提交异常: ${err?.message ?? String(err)}`, type: 'error' })
        }
      }
    },
    [addTask, addToast],
  )

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (!hydrated) {
        addToast({ message: '正在加载配置，请稍候…', type: 'info' })
        return
      }
      setBusy(true)
      try {
        const paths: string[] = []
        for (const f of files) {
          const p: string = api?.getFilePath?.(f) ?? ''
          if (!p) {
            addToast({ message: `${f.name}: 无法获取本地路径，跳过`, type: 'warning' })
            continue
          }
          paths.push(p)
        }
        if (paths.length === 0) return

        const probes: EraseProbeResult[] = (await api?.smartEraseProbeBatch?.(paths)) ?? []
        if (probes.length === 0) return

        // Cost guard
        const usableProbes = probes.filter((p) => !p.warning)
        const totalDuration = usableProbes.reduce((sum, p) => sum + (p.durationSeconds || 0), 0)
        if (usableProbes.length > COST_GUARD_COUNT || totalDuration > COST_GUARD_DURATION_S) {
          setPendingProbes(probes)
          setShowCostConfirm(true)
          return
        }

        await submitAll(probes)
      } finally {
        setBusy(false)
      }
    },
    [hydrated, addToast, setPendingProbes, setShowCostConfirm, submitAll],
  )

  const handleConfirm = useCallback(async () => {
    setShowCostConfirm(false)
    setBusy(true)
    try {
      await submitAll(pendingProbes)
    } finally {
      setPendingProbes([])
      setBusy(false)
    }
  }, [pendingProbes, setShowCostConfirm, setPendingProbes, submitAll])

  const handleCancelConfirm = useCallback(() => {
    setShowCostConfirm(false)
    setPendingProbes([])
  }, [setShowCostConfirm, setPendingProbes])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      if (disabled) return
      const valid = validate(e.dataTransfer.files)
      if (valid.length) void handleFiles(valid)
    },
    [disabled, handleFiles, validate],
  )

  const summary = pendingProbes.filter((p) => !p.warning)
  const summaryDuration = summary.reduce((s, p) => s + p.durationSeconds, 0)

  return (
    <>
      <div
        onDragOver={(e) => {
          e.preventDefault()
          if (!disabled && !busy) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => !disabled && !busy && inputRef.current?.click()}
        className={`
          d-neon-frame d-clip-corner-br relative p-8 text-center transition-colors
          ${disabled || busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
          ${dragOver ? 'border-[color:var(--donor-cyan)] bg-[color:var(--donor-cyan)]/5' : ''}
        `}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".mp4,.mov,.mkv,.webm,.avi,video/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) {
              const valid = validate(e.target.files)
              if (valid.length) void handleFiles(valid)
            }
            e.target.value = ''
          }}
        />
        <div className="d-mono text-[color:var(--donor-cyan)] text-3xl mb-2">▶</div>
        <p className="d-mono text-[color:var(--donor-ink)] text-[13px] tracking-widest uppercase">
          {busy ? 'PROBING...' : 'DROP / CLICK · 视频字幕擦除'}
        </p>
        <p className="d-mono text-[10px] text-[color:var(--donor-ink-mute)] mt-1 tracking-widest">
          MP4 / MOV / MKV / WebM / AVI · ≤ 500 MB
        </p>
        {!hydrated && (
          <p className="d-mono text-[10px] text-[color:var(--donor-yellow)] mt-2 tracking-widest">
            // 加载历史与配置中…
          </p>
        )}
      </div>

      {showCostConfirm && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
          onClick={handleCancelConfirm}
        >
          <div
            className="d-neon-frame p-6 max-w-md mx-4 bg-[color:var(--donor-bg-0)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="d-mono text-sm text-[color:var(--donor-yellow)] tracking-widest mb-3">
              ⚠ 确认批量提交
            </div>
            <div className="d-mono text-[12px] text-[color:var(--donor-ink)] leading-relaxed mb-4">
              您即将提交 <span className="text-[color:var(--donor-cyan)]">{summary.length}</span> 个视频，
              总时长 <span className="text-[color:var(--donor-cyan)]">{formatDuration(summaryDuration)}</span>
              。<br />
              超过日常使用阈值（{COST_GUARD_COUNT} 个 / 60 分钟），可能产生较大费用。
            </div>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={handleCancelConfirm}
                className="d-mono text-xs tracking-widest px-4 py-2 border border-[color:var(--donor-ink-mute)] text-[color:var(--donor-ink-dim)] hover:bg-[color:var(--donor-ink-mute)]/10"
              >
                [ 取消 ]
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                className="d-mono text-xs tracking-widest px-4 py-2 border border-[color:var(--donor-cyan)] text-[color:var(--donor-cyan)] hover:bg-[color:var(--donor-cyan)]/10"
              >
                [ 继续提交 ]
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function labelForWarning(warning: NonNullable<EraseProbeResult['warning']>): string {
  switch (warning) {
    case 'FILE_PATH_UNAVAILABLE':
      return '无法获取本地路径'
    case 'FILE_NOT_LOCAL':
      return '文件不在本地'
    case 'PROBE_FAILED':
      return '元数据探测失败'
  }
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

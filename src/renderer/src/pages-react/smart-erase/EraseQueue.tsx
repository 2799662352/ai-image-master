import { useState } from 'react'
import { useEraseSessionStore, type EraseSessionTask } from '../../stores/useEraseSessionStore'
import type { EraseTask, EraseTaskDetailSnapshot } from '../../../../types/smartErase'
import { computeProcessingProgress } from './eraseProgress'
import { useTicker } from './useTicker'

const api = (window as any).electronAPI

const STATUS_LABEL: Record<EraseTask['status'], string> = {
  'queued-upload': '排队上传',
  uploading: '上传中',
  'queued-process': '排队处理',
  submitting: '提交中',
  processing: '处理中',
  finished: '完成',
  failed: '失败',
  cancelled: '已取消',
}

const STATUS_COLOR: Record<EraseTask['status'], string> = {
  'queued-upload': 'var(--donor-ink-mute)',
  uploading: 'var(--donor-cyan)',
  'queued-process': 'var(--donor-ink-mute)',
  submitting: 'var(--donor-yellow)',
  processing: 'var(--donor-yellow)',
  finished: 'var(--donor-green)',
  failed: 'var(--donor-red)',
  cancelled: 'var(--donor-ink-dim)',
}

export function EraseQueue() {
  const tasks = useEraseSessionStore((s) => s.activeTasks)
  const hasProcessing = tasks.some((t) => t.status === 'processing')
  const now = useTicker(hasProcessing)

  if (tasks.length === 0) return null

  const counts = countByPhase(tasks)

  return (
    <div className="d-neon-frame p-4 space-y-3">
      <div className="flex items-center gap-3 flex-wrap d-mono text-[11px] tracking-widest uppercase">
        <Counter label="QUEUE" value={counts.queued} color="var(--donor-ink-mute)" />
        <Counter label="UPLOAD" value={counts.uploading} color="var(--donor-cyan)" />
        <Counter label="PROC" value={counts.processing} color="var(--donor-yellow)" />
        <Counter label="FAIL" value={counts.failed} color="var(--donor-red)" />
      </div>

      <ul className="space-y-1.5">
        {tasks.map((t) => (
          <TaskRow key={t.id} task={t} now={now} />
        ))}
      </ul>
    </div>
  )
}

function TaskRow({ task: t, now }: { task: EraseSessionTask; now: number }) {
  const barPercent = getBarPercent(t, now)
  const [detailOpen, setDetailOpen] = useState(false)
  // We only show the [详情] toggle once we actually have something to show
  // — i.e. MPS has at least replied to one poll. Prevents an inert button
  // sitting on uploading rows where the detail is always empty.
  const hasDetail = Boolean(t.taskDetail || t.mpsTaskId)
  // Differentiate the real Tencent number (94% from the API) from the
  // exponential estimate, so the user can tell which one they're seeing.
  // `t.mpsProgress` is set only after a successful DescribeTaskDetail poll
  // with a numeric `SmartEraseTaskResult.Progress` — matches the value
  // Tencent's task table shows in "进行中 94%".
  const isRealProgress = t.status === 'processing' && t.mpsProgress != null

  return (
    <li className="px-3 py-2 border border-[color:var(--donor-ink-mute)]/30 d-mono text-[11px] space-y-1">
      <div className="flex items-center gap-3">
        <span
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: STATUS_COLOR[t.status] }}
        />
        <span className="truncate flex-1 text-[color:var(--donor-ink)]">
          {t.filename}
        </span>
        {/* 两个工具可以混在同一条队列里,不标出来用户分不清哪条是哪种。 */}
        <span className="text-[10px] tracking-widest flex-shrink-0 px-1.5 border border-[color:var(--donor-magenta-dim)] text-[color:var(--donor-ink-dim)]">
          {t.tool === 'erase' ? '去字幕' : '高清'}
        </span>
        <span
          className="text-[10px] tracking-widest uppercase flex-shrink-0"
          style={{ color: STATUS_COLOR[t.status] }}
          title={isRealProgress ? 'Tencent MPS 实时进度' : t.status === 'processing' ? '本地估算进度（MPS 尚未返回 Progress）' : ''}
        >
          {STATUS_LABEL[t.status]}
          {t.status === 'uploading' && t.uploadProgress != null
            ? ` ${t.uploadProgress}%`
            : ''}
          {t.status === 'processing' && barPercent > 0
            ? ` ${barPercent}%${isRealProgress ? '' : '~'}`
            : ''}
        </span>
        {hasDetail && (
          <button
            type="button"
            onClick={() => setDetailOpen((v) => !v)}
            className="text-[10px] text-[color:var(--donor-ink-dim)] hover:text-[color:var(--donor-cyan)] tracking-widest"
            title={detailOpen ? '收起详情' : '查看详情'}
          >
            {detailOpen ? '[收起]' : '[详情]'}
          </button>
        )}
        {t.status !== 'failed' && t.status !== 'cancelled' && (
          <button
            type="button"
            onClick={() => void api?.smartEraseCancel?.(t.id)}
            className="text-[10px] text-[color:var(--donor-ink-dim)] hover:text-[color:var(--donor-red)] tracking-widest"
            title="取消任务"
          >
            [×]
          </button>
        )}
      </div>
      {barPercent > 0 && (
        <div className="h-1 bg-[color:var(--donor-ink-mute)]/20 overflow-hidden">
          <div
            className="h-full transition-all duration-1000 ease-out"
            style={{
              width: `${barPercent}%`,
              backgroundColor:
                t.status === 'failed' ? 'var(--donor-red)' : STATUS_COLOR[t.status],
            }}
          />
        </div>
      )}
      {detailOpen && (
        <DetailPanel
          mpsTaskId={t.mpsTaskId}
          detail={t.taskDetail}
          fileSize={t.fileSize}
          durationSeconds={t.durationSeconds}
        />
      )}
    </li>
  )
}

/**
 * Mirrors the "查看结果详情" drawer the Tencent MPS console exposes —
 * shows the curated subset of `DescribeTaskDetail` fields the user
 * actually needs to debug a stuck task. Renders compactly in monospace
 * so it fits inline under the queue row without needing a modal.
 */
function DetailPanel({
  mpsTaskId,
  detail,
  fileSize,
  durationSeconds,
}: {
  mpsTaskId?: string
  detail?: EraseTaskDetailSnapshot
  fileSize: number
  durationSeconds: number
}) {
  // Show what we have. If `detail` is missing (e.g. user clicked very
  // quickly after submit, before the first poll) we still show whatever
  // task-level metadata we know.
  return (
    <div className="mt-2 pl-4 border-l border-[color:var(--donor-ink-mute)]/40 text-[10px] text-[color:var(--donor-ink-dim)] space-y-0.5">
      {mpsTaskId && (
        <Row label="MPS TaskId">
          <span
            className="text-[color:var(--donor-ink)] select-all break-all"
            title="点击复制"
            onClick={() => void navigator.clipboard?.writeText(mpsTaskId).catch(() => {})}
          >
            {mpsTaskId}
          </span>
        </Row>
      )}
      <Row label="Size / Duration">
        <span>{formatBytes(fileSize)} · {formatSeconds(durationSeconds)}</span>
      </Row>
      {detail?.workflowStatus && (
        <Row label="Workflow">
          <span>{detail.workflowStatus}</span>
        </Row>
      )}
      {detail?.smartEraseStatus && (
        <Row label="SmartErase">
          <span>{detail.smartEraseStatus}</span>
        </Row>
      )}
      {detail?.progress != null && (
        <Row label="Progress">
          <span className="text-[color:var(--donor-yellow)]">{detail.progress}%</span>
        </Row>
      )}
      {(detail?.workflowErrCode != null && detail.workflowErrCode !== 0) && (
        <Row label="Workflow ErrCode">
          <span className="text-[color:var(--donor-red)]">
            {detail.workflowErrCode}{detail.workflowMessage ? `: ${detail.workflowMessage}` : ''}
          </span>
        </Row>
      )}
      {detail?.errCodeExt && (
        <Row label="ErrCodeExt">
          <span className="text-[color:var(--donor-red)]">{detail.errCodeExt}</span>
        </Row>
      )}
      {detail?.message && detail.message !== 'SUCCESS' && (
        <Row label="Message">
          <span>{detail.message}</span>
        </Row>
      )}
      {detail?.beginProcessTime && (
        <Row label="Begin">
          <span>{detail.beginProcessTime}</span>
        </Row>
      )}
      {detail?.finishTime && (
        <Row label="Finish">
          <span>{detail.finishTime}</span>
        </Row>
      )}
      {detail?.outputPath && (
        <Row label="Output">
          <span className="break-all text-[color:var(--donor-green)]">{detail.outputPath}</span>
        </Row>
      )}
      {detail?.fetchedAt && (
        <Row label="Updated">
          <span>{formatRelativeMs(detail.fetchedAt)}</span>
        </Row>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-24 flex-shrink-0 uppercase tracking-widest">{label}</span>
      <span className="flex-1 min-w-0">{children}</span>
    </div>
  )
}

function formatBytes(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let n = b
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`
}

function formatSeconds(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return '—'
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const r = Math.round(s - m * 60)
  return `${m}m${r}s`
}

function formatRelativeMs(t: number): string {
  const diff = Math.max(0, Date.now() - t)
  if (diff < 1500) return 'just now'
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`
  return `${Math.round(diff / 60_000)}m ago`
}

function getBarPercent(t: EraseSessionTask, now: number): number {
  if (t.status === 'uploading') return t.uploadProgress ?? 0
  if (t.status === 'processing') {
    // Prefer the real Tencent number if we have it; otherwise fall back
    // to the local exponential estimate so the bar still moves while we
    // wait for the first DescribeTaskDetail poll to return.
    if (t.mpsProgress != null && Number.isFinite(t.mpsProgress)) {
      return Math.max(0, Math.min(100, Math.round(t.mpsProgress)))
    }
    return computeProcessingProgress({
      startedAt: t.processingStartedAt ?? 0,
      durationSeconds: t.durationSeconds,
      status: t.status,
      now,
    })
  }
  return 0
}

function Counter({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <span className="px-2 py-0.5 border" style={{ borderColor: color, color }}>
      {label} {value}
    </span>
  )
}

function countByPhase(tasks: EraseTask[]) {
  let queued = 0, uploading = 0, processing = 0, failed = 0
  for (const t of tasks) {
    switch (t.status) {
      case 'queued-upload': case 'queued-process': queued++; break
      case 'uploading': uploading++; break
      case 'submitting': case 'processing': processing++; break
      case 'failed': failed++; break
    }
  }
  return { queued, uploading, processing, failed }
}

import { useState, useRef, useCallback } from 'react'
import { useEraseSessionStore, type EraseSessionTask } from '../../stores/useEraseSessionStore'
import { useErasePersistStore } from '../../stores/useErasePersistStore'
import { useQuotaStore } from '../../stores/useQuotaStore'
import { useToastStore } from '../../stores'
import type { EraseProbeResult, EraseTool } from '../../../../types/smartErase'
import {
  DAMO_ALGOS,
  DAMO_FPS,
  DAMO_RESOLUTIONS,
  DEFAULT_DAMO_SPEC,
  enhancePriceYuan,
  type DamoAlgo,
  type DamoFps,
  type DamoResolution,
  type EnhanceSpec,
} from '../../../../shared/videoEnhance'
import { probeVideoFiles, generatePosterFromFile } from './probeVideoFiles'

/** 两个工具的展示信息。数据放一处,切换按钮与投放区文案都从这里取。 */
const TOOL_META: Record<EraseTool, { label: string; dropHint: string; note: string }> = {
  enhance: {
    label: '高清',
    dropHint: '视频高清增强',
    // 价格随渠道 / 档位变,在 EnhanceOptions 里实时显示,这里只留不变的部分。
    note: '经 Miau 网关 · 可用平台余额 · 按次计费',
  },
  erase: {
    label: '去字幕',
    dropHint: '视频字幕擦除',
    note: '腾讯 MPS 模板 303 · 使用腾讯云密钥',
  },
}

const ALGO_LABEL: Record<DamoAlgo, string> = { standard: '标准', pro: 'Pro' }

function formatYuan(n: number): string {
  return n < 1 ? `¥${n.toFixed(2)}` : `¥${n}`
}

/**
 * 高清的渠道与档位。
 *
 * 火山只有一档(¥0.1);阿里 DAMO 是 算法 × 分辨率 × 帧率 30 档,¥2 到 ¥768 **一次**。
 * 价格必须在提交前就摆在眼前:同一个按钮,最便宜和最贵之间差 7000 倍,而且提交那一刻
 * 就扣费,不是完成时。
 *
 * 切到 DAMO 时从最便宜的一档起手,不继承上次选的 —— 上次选 8K Pro 120fps 是为了
 * 某条特定视频,不该悄悄成为下一条的默认。
 */
function EnhanceOptions({
  spec,
  onChange,
  disabled,
}: {
  spec: EnhanceSpec
  onChange: (spec: EnhanceSpec) => void
  disabled: boolean
}) {
  const price = enhancePriceYuan(spec)
  const damo = spec.provider === 'damo' ? spec : null
  const selectCls =
    'bg-[color:var(--donor-bg-0)] border border-[color:var(--donor-magenta-dim)] text-[color:var(--donor-ink)] px-2 py-0.5 focus:outline-none focus:border-[color:var(--donor-cyan)] disabled:opacity-50'

  return (
    <div className="flex items-center gap-2 mb-2 d-mono text-[11px] tracking-widest flex-wrap" data-testid="enhance-options">
      <span className="text-[color:var(--donor-ink-mute)]">// PROVIDER</span>
      {(['volc', 'damo'] as const).map((p) => {
        const active = spec.provider === p
        return (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(p === 'volc' ? { provider: 'volc' } : { provider: 'damo', ...DEFAULT_DAMO_SPEC })}
            className={`px-3 py-1 border transition-colors disabled:opacity-50 ${
              active
                ? 'border-[color:var(--donor-cyan)] text-[color:var(--donor-bg-0)] bg-[color:var(--donor-cyan)]'
                : 'border-[color:var(--donor-magenta-dim)] text-[color:var(--donor-ink-dim)] hover:border-[color:var(--donor-cyan)]'
            }`}
          >
            {p === 'volc' ? '火山' : '阿里 DAMO'}
          </button>
        )
      })}

      {damo && (
        <>
          <select
            aria-label="算法"
            className={selectCls}
            disabled={disabled}
            value={damo.algo}
            onChange={(e) => onChange({ ...damo, algo: e.target.value as DamoAlgo })}
          >
            {DAMO_ALGOS.map((a) => <option key={a} value={a}>{ALGO_LABEL[a]}</option>)}
          </select>
          <select
            aria-label="目标分辨率"
            className={selectCls}
            disabled={disabled}
            value={damo.resolution}
            onChange={(e) => onChange({ ...damo, resolution: e.target.value as DamoResolution })}
          >
            {DAMO_RESOLUTIONS.map((r) => <option key={r} value={r}>{r.toUpperCase()}</option>)}
          </select>
          <select
            aria-label="帧率"
            className={selectCls}
            disabled={disabled}
            value={damo.fps}
            onChange={(e) => onChange({ ...damo, fps: Number(e.target.value) as DamoFps })}
          >
            {DAMO_FPS.map((f) => <option key={f} value={f}>{f} fps</option>)}
          </select>
        </>
      )}

      <span
        data-testid="enhance-price"
        className={`ml-1 px-2 py-0.5 border ${price >= 50 ? 'border-[color:var(--donor-red)] text-[color:var(--donor-red)]' : 'border-[color:var(--donor-yellow)] text-[color:var(--donor-yellow)]'}`}
        title="按次计费,提交时预扣;时长不计入,长视频按一分钟收"
      >
        {formatYuan(price)} / 次
      </span>
      {damo && (
        <span className="text-[color:var(--donor-ink-mute)]">时长不计入 · 长视频按一分钟收</span>
      )}
    </div>
  )
}

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
  const tool = useEraseSessionStore((s) => s.tool)
  const setTool = useEraseSessionStore((s) => s.setTool)
  const enhanceSpec = useEraseSessionStore((s) => s.enhanceSpec)
  const setEnhanceSpec = useEraseSessionStore((s) => s.setEnhanceSpec)
  // 高清那条路的计费意向,与视频工作台同源。去字幕不看它。
  const billingSource = useQuotaStore((s) => s.billingSource)
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
    async (probes: EraseProbeResult[], fileMap: Map<string, File>) => {
      for (const probe of probes) {
        if (probe.warning) {
          addToast({
            message: `${probe.filename || '未知文件'}: ${labelForWarning(probe.warning)}`,
            type: 'warning',
          })
          continue
        }
        try {
          let posterDataUrl = ''
          const file = fileMap.get(probe.filePath)
          if (file) {
            try { posterDataUrl = await generatePosterFromFile(file) } catch { /* best-effort */ }
          }

          const ret = await api?.smartEraseSubmit?.({
            filePath: probe.filePath,
            filename: probe.filename,
            fileSize: probe.fileSize,
            durationSeconds: probe.durationSeconds,
            posterDataUrl,
            tool,
            // 主进程按这个意向取凭据,**绝不跨模式回落**(理由见 seedance/billing.ts)。
            // 去字幕那条不读它,带过去也无害。
            ...(tool === 'enhance' ? { billing: billingSource, enhance: enhanceSpec } : {}),
          })
          if (!ret?.success) {
            addToast({
              message: ret?.error || `提交失败: ${probe.filename}`,
              type: 'error',
            })
            continue
          }
          const sessionTask: EraseSessionTask = {
            id: ret.taskId,
            filename: probe.filename,
            fileSize: probe.fileSize,
            durationSeconds: probe.durationSeconds,
            status: 'queued-upload',
            startedAt: Date.now(),
            filePath: probe.filePath,
            posterDataUrl: ret.posterDataUrl ?? posterDataUrl,
            tool,
            ...(tool === 'enhance' ? { enhanceSpec } : {}),
          }
          addTask(sessionTask)
        } catch (err: any) {
          addToast({ message: `提交异常: ${err?.message ?? String(err)}`, type: 'error' })
        }
      }
    },
    [addTask, addToast, tool, billingSource, enhanceSpec],
  )

  const fileMapRef = useRef<Map<string, File>>(new Map())

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (!hydrated) {
        addToast({ message: '正在加载配置，请稍候…', type: 'info' })
        return
      }
      setBusy(true)
      try {
        const probes = await probeVideoFiles(files)
        if (probes.length === 0) return

        const fMap = new Map<string, File>()
        for (const f of files) {
          const p: string = api?.getFilePath?.(f) ?? ''
          if (p) fMap.set(p, f)
        }
        fileMapRef.current = fMap

        const usableProbes = probes.filter((p) => !p.warning)
        const totalDuration = usableProbes.reduce((sum, p) => sum + (p.durationSeconds || 0), 0)
        if (usableProbes.length > COST_GUARD_COUNT || totalDuration > COST_GUARD_DURATION_S) {
          setPendingProbes(probes)
          setShowCostConfirm(true)
          return
        }

        await submitAll(probes, fMap)
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
      await submitAll(pendingProbes, fileMapRef.current)
    } finally {
      setPendingProbes([])
      fileMapRef.current = new Map()
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

  const meta = TOOL_META[tool]

  return (
    <>
      {/* 工具切换。放在投放区**上方**而不是里面:投放区整块可点(打开选择器),
          把开关塞进去会让每次切换都误触文件选择。 */}
      <div
        role="radiogroup"
        aria-label="处理方式"
        className="flex items-center gap-2 mb-2 d-mono text-[11px] tracking-widest"
      >
        <span className="text-[color:var(--donor-ink-mute)]">// MODE</span>
        {(Object.keys(TOOL_META) as EraseTool[]).map((t) => {
          const active = t === tool
          return (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled || busy}
              onClick={() => setTool(t)}
              className={`px-3 py-1 border uppercase transition-colors disabled:opacity-50 ${
                active
                  ? 'border-[color:var(--donor-cyan)] text-[color:var(--donor-bg-0)] bg-[color:var(--donor-cyan)]'
                  : 'border-[color:var(--donor-magenta-dim)] text-[color:var(--donor-ink-dim)] hover:border-[color:var(--donor-cyan)]'
              }`}
            >
              {TOOL_META[t].label}
            </button>
          )
        })}
        <span className="text-[color:var(--donor-ink-mute)] ml-1">{meta.note}</span>
      </div>

      {tool === 'enhance' && (
        <EnhanceOptions spec={enhanceSpec} onChange={setEnhanceSpec} disabled={disabled || busy} />
      )}

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
          {busy ? 'PROBING...' : `DROP / CLICK · ${meta.dropHint}`}
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

function labelForWarning(warning: string): string {
  switch (warning) {
    case 'FILE_PATH_UNAVAILABLE':
      return '无法获取本地路径'
    case 'FILE_NOT_LOCAL':
      return '文件不在本地'
    case 'PROBE_FAILED':
      return '元数据探测失败'
    default:
      return warning
  }
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

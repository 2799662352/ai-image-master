import { useEffect, useMemo, useState } from 'react'
import type {
  CodexApprovalPolicy,
  CodexModelVerbosity,
  CodexPersonality,
  CodexReasoningSummaryMode,
  CodexSandboxMode,
  CodexSessionConfig,
  CodexSessionStatus,
  CodexWebSearchMode,
} from '../../../../types/agent'

/**
 * Option rows show a Chinese label first and the raw config value in mono —
 * this is a developer-facing surface, so the actual wire value stays visible
 * (and tests/docs can keep referencing the canonical enum strings).
 */
interface PanelOption<T extends string> {
  value: T
  label: string
}

const SANDBOX_OPTIONS: PanelOption<CodexSandboxMode>[] = [
  { value: 'read-only', label: '只读' },
  { value: 'workspace-write', label: '工作区可写' },
  { value: 'danger-full-access', label: '完全访问' },
]
const APPROVAL_OPTIONS: PanelOption<CodexApprovalPolicy>[] = [
  { value: 'untrusted', label: '严格审批' },
  { value: 'on-request', label: '按需审批' },
  { value: 'never', label: '免审批' },
]
const WEB_SEARCH_OPTIONS: PanelOption<CodexWebSearchMode>[] = [
  { value: 'cached', label: '缓存' },
  { value: 'live', label: '实时' },
  { value: 'indexed', label: '索引库' },
  { value: 'disabled', label: '关闭' },
]
const PERSONALITY_OPTIONS: PanelOption<CodexPersonality>[] = [
  { value: 'default', label: '默认' },
  { value: 'none', label: '中性' },
  { value: 'friendly', label: '友好' },
  { value: 'pragmatic', label: '务实' },
]
const REASONING_SUMMARY_OPTIONS: PanelOption<CodexReasoningSummaryMode>[] = [
  { value: 'auto', label: '自动' },
  { value: 'concise', label: '简洁' },
  { value: 'detailed', label: '详细' },
  { value: 'none', label: '关闭' },
]
const VERBOSITY_OPTIONS: PanelOption<CodexModelVerbosity>[] = [
  { value: 'default', label: '默认' },
  { value: 'low', label: '简短' },
  { value: 'medium', label: '中等' },
  { value: 'high', label: '详尽' },
]

interface CodexPermissionsPanelProps {
  status?: CodexSessionStatus
  onApply: (
    patch: Partial<CodexSessionConfig>,
    options?: { persist?: boolean },
  ) => Promise<void> | void
  /** Optional factory reset (clears the persisted snapshot). Hidden when absent. */
  onReset?: () => Promise<void> | void
  /**
   * Optional global memory wipe (`memory/reset` RPC). Hidden when absent.
   * Gated behind a two-step inline confirm (jsdom forbids window.confirm).
   */
  onResetMemory?: () => Promise<{ ok: boolean; error?: string }>
}

type Draft = Pick<
  CodexSessionConfig,
  | 'sandboxMode'
  | 'approvalPolicy'
  | 'webSearch'
  | 'personality'
  | 'reasoningSummary'
  | 'showRawReasoning'
  | 'modelVerbosity'
  | 'notifyOnTurnComplete'
  | 'memoriesEnabled'
>

export function CodexPermissionsPanel({ status, onApply, onReset, onResetMemory }: CodexPermissionsPanelProps) {
  const [draft, setDraft] = useState<Draft | undefined>(() => statusToDraft(status))
  const [applying, setApplying] = useState(false)
  const [persist, setPersist] = useState(false)
  const [memoryResetArmed, setMemoryResetArmed] = useState(false)
  const [memoryResetBusy, setMemoryResetBusy] = useState(false)
  const [memoryNotice, setMemoryNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    setDraft(statusToDraft(status))
  }, [status])

  const patch = useMemo(() => {
    // Diff against the fallback-resolved snapshot (not the raw status): older
    // main-process builds omit the tuning fields, and comparing 'default'
    // against undefined would wrongly mark them as changed on every apply.
    const baseline = statusToDraft(status)
    if (!baseline || !draft) return {}
    const next: Partial<CodexSessionConfig> = {}
    if (draft.sandboxMode !== baseline.sandboxMode) next.sandboxMode = draft.sandboxMode
    if (draft.approvalPolicy !== baseline.approvalPolicy) next.approvalPolicy = draft.approvalPolicy
    if (draft.webSearch !== baseline.webSearch) next.webSearch = draft.webSearch
    if (draft.personality !== baseline.personality) next.personality = draft.personality
    if (draft.reasoningSummary !== baseline.reasoningSummary) next.reasoningSummary = draft.reasoningSummary
    if (draft.showRawReasoning !== baseline.showRawReasoning) next.showRawReasoning = draft.showRawReasoning
    if (draft.modelVerbosity !== baseline.modelVerbosity) next.modelVerbosity = draft.modelVerbosity
    if (draft.notifyOnTurnComplete !== baseline.notifyOnTurnComplete) next.notifyOnTurnComplete = draft.notifyOnTurnComplete
    if (draft.memoriesEnabled !== baseline.memoriesEnabled) next.memoriesEnabled = draft.memoriesEnabled
    return next
  }, [draft, status])

  if (!status || !draft) {
    return (
      <div className="mt-3 rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-3 text-[12px] text-zinc-500">
        Codex 设置不可用。
      </div>
    )
  }

  // With persist checked, "apply" is meaningful even without field changes:
  // it snapshots the CURRENT config as the new startup default.
  const changed = Object.keys(patch).length > 0 || (persist && !status.persistedDefaults)
  const unsafe =
    patch.sandboxMode === 'danger-full-access' ||
    patch.approvalPolicy === 'never' ||
    patch.webSearch === 'live'

  async function apply(): Promise<void> {
    if (!changed) return
    setApplying(true)
    try {
      if (persist) {
        await onApply(patch, { persist: true })
      } else {
        await onApply(patch)
      }
      setPersist(false)
    } finally {
      setApplying(false)
    }
  }

  async function resetToFactory(): Promise<void> {
    if (!onReset) return
    setApplying(true)
    try {
      await onReset()
      setPersist(false)
    } finally {
      setApplying(false)
    }
  }

  async function confirmMemoryReset(): Promise<void> {
    if (!onResetMemory) return
    setMemoryResetArmed(false)
    setMemoryResetBusy(true)
    setMemoryNotice(null)
    try {
      const result = await onResetMemory()
      if (result?.ok) {
        setMemoryNotice({ tone: 'ok', text: '记忆已清除。' })
      } else {
        setMemoryNotice({ tone: 'error', text: result?.error ?? '清除记忆失败。' })
      }
    } catch (error) {
      setMemoryNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setMemoryResetBusy(false)
    }
  }

  return (
    <section className="mt-3 rounded-xl border border-cyan-400/15 bg-zinc-950/70 p-3 text-[12px] text-zinc-200">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold text-cyan-100">Codex 设置</h3>
          <p className="mt-0.5 text-[11px] text-zinc-500">应用后对新会话生效;进行中的会话保持原配置。</p>
        </div>
        <button
          type="button"
          onClick={() => void apply()}
          disabled={!changed || applying}
          className="cursor-pointer rounded-md border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1 text-[11px] font-medium text-cyan-100 transition-colors duration-200 hover:border-cyan-300/60 hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:border-zinc-700/60 disabled:bg-zinc-900 disabled:text-zinc-500"
        >
          应用设置
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <RadioGroup
          legend="沙箱"
          legendEn="Sandbox"
          value={draft.sandboxMode}
          options={SANDBOX_OPTIONS}
          onChange={(sandboxMode) => setDraft({ ...draft, sandboxMode })}
        />
        <RadioGroup
          legend="审批"
          legendEn="Approval"
          value={draft.approvalPolicy}
          options={APPROVAL_OPTIONS}
          onChange={(approvalPolicy) => setDraft({ ...draft, approvalPolicy })}
        />
        <RadioGroup
          legend="联网搜索"
          legendEn="Web search"
          value={draft.webSearch}
          options={WEB_SEARCH_OPTIONS}
          onChange={(webSearch) => setDraft({ ...draft, webSearch })}
        />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <RadioGroup
          legend="助手性格"
          legendEn="Personality"
          value={draft.personality}
          options={PERSONALITY_OPTIONS}
          onChange={(personality) => setDraft({ ...draft, personality })}
        />
        <RadioGroup
          legend="推理摘要"
          legendEn="Reasoning summary"
          value={draft.reasoningSummary}
          options={REASONING_SUMMARY_OPTIONS}
          onChange={(reasoningSummary) => setDraft({ ...draft, reasoningSummary })}
        />
        <RadioGroup
          legend="输出详略"
          legendEn="Verbosity"
          value={draft.modelVerbosity}
          options={VERBOSITY_OPTIONS}
          onChange={(modelVerbosity) => setDraft({ ...draft, modelVerbosity })}
        />
        <fieldset className="rounded-lg border border-zinc-800/80 bg-black/20 p-2">
          <legend className="px-1 text-[11px] font-medium text-zinc-400">
            原始思维链 <span className="font-mono text-[10px] text-zinc-600">Raw reasoning</span>
          </legend>
          <label className="mt-1 flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[11px] text-zinc-300 transition-colors duration-200 hover:bg-cyan-400/5">
            <input
              type="checkbox"
              checked={draft.showRawReasoning}
              onChange={() => setDraft({ ...draft, showRawReasoning: !draft.showRawReasoning })}
              className="h-3 w-3 cursor-pointer accent-cyan-300"
            />
            <span>显示原始思维链</span>
          </label>
          <p className="mt-1 px-0.5 text-[10px] leading-4 text-zinc-500">
            关闭后,新会话的 Thought 卡将不再展示思维链内容。
          </p>
        </fieldset>
        <fieldset className="rounded-lg border border-zinc-800/80 bg-black/20 p-2">
          <legend className="px-1 text-[11px] font-medium text-zinc-400">
            完成通知 <span className="font-mono text-[10px] text-zinc-600">Notifications</span>
          </legend>
          <label className="mt-1 flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[11px] text-zinc-300 transition-colors duration-200 hover:bg-cyan-400/5">
            <input
              type="checkbox"
              checked={draft.notifyOnTurnComplete}
              onChange={() => setDraft({ ...draft, notifyOnTurnComplete: !draft.notifyOnTurnComplete })}
              className="h-3 w-3 cursor-pointer accent-cyan-300"
            />
            <span>回合完成时弹系统通知</span>
          </label>
          <p className="mt-1 px-0.5 text-[10px] leading-4 text-zinc-500">
            仅在窗口未聚焦时提醒;任务完成或失败都会通知,点击通知返回应用。
          </p>
        </fieldset>
        <fieldset className="rounded-lg border border-zinc-800/80 bg-black/20 p-2">
          <legend className="px-1 text-[11px] font-medium text-zinc-400">
            跨会话记忆 <span className="font-mono text-[10px] text-zinc-600">Memories</span>
          </legend>
          <label className="mt-1 flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[11px] text-zinc-300 transition-colors duration-200 hover:bg-cyan-400/5">
            <input
              type="checkbox"
              checked={draft.memoriesEnabled}
              onChange={() => setDraft({ ...draft, memoriesEnabled: !draft.memoriesEnabled })}
              className="h-3 w-3 cursor-pointer accent-cyan-300"
            />
            <span>启用跨会话记忆</span>
          </label>
          <p className="mt-1 px-0.5 text-[10px] leading-4 text-zinc-500">
            让助手跨聊天记住你的偏好与决定;开关在重启应用后生效。
          </p>
          {onResetMemory ? (
            <div className="mt-1.5 flex items-center gap-1.5 px-0.5">
              {memoryResetArmed ? (
                <>
                  <button
                    type="button"
                    disabled={memoryResetBusy}
                    onClick={() => void confirmMemoryReset()}
                    className="cursor-pointer rounded-md border border-rose-500/40 px-2 py-0.5 text-[10px] text-rose-100 transition-colors duration-200 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    确认清除
                  </button>
                  <button
                    type="button"
                    onClick={() => setMemoryResetArmed(false)}
                    className="cursor-pointer rounded-md border border-zinc-700/70 px-2 py-0.5 text-[10px] text-zinc-300 transition-colors duration-200 hover:bg-zinc-800/60"
                  >
                    取消
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={memoryResetBusy}
                  onClick={() => setMemoryResetArmed(true)}
                  className="cursor-pointer rounded-md border border-zinc-700/70 px-2 py-0.5 text-[10px] text-zinc-300 transition-colors duration-200 hover:border-rose-400/50 hover:text-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  清除记忆
                </button>
              )}
            </div>
          ) : null}
          {memoryNotice ? (
            <p
              className={`mt-1 px-0.5 text-[10px] leading-4 ${
                memoryNotice.tone === 'ok' ? 'text-emerald-300' : 'text-rose-300'
              }`}
            >
              {memoryNotice.text}
            </p>
          ) : null}
        </fieldset>
      </div>

      {status.writableRoots.length > 0 ? (
        <div className="mt-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">可写目录</div>
          <ul className="mt-1 space-y-1">
            {status.writableRoots.map((root) => (
              <li key={root} className="truncate rounded-md border border-zinc-800 bg-black/25 px-2 py-1 text-zinc-400">
                {root}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {unsafe ? (
        <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-100">
          已选择高权限配置,应用时会弹出系统确认框。
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800/60 pt-2">
        <label className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-400 transition-colors duration-200 hover:text-zinc-200">
          <input
            type="checkbox"
            checked={persist}
            onChange={() => setPersist(!persist)}
            className="h-3 w-3 cursor-pointer accent-cyan-300"
          />
          <span>保存为默认(重启后保留)</span>
        </label>
        {status.persistedDefaults ? (
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-zinc-500">当前默认值来自你保存的设置</span>
            {onReset ? (
              <button
                type="button"
                onClick={() => void resetToFactory()}
                disabled={applying}
                className="cursor-pointer rounded-md border border-zinc-700/70 bg-zinc-900/60 px-2 py-0.5 text-[10px] text-zinc-300 transition-colors duration-200 hover:border-amber-400/50 hover:text-amber-100 disabled:cursor-not-allowed disabled:text-zinc-600"
              >
                恢复出厂设置
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}

function statusToDraft(status?: CodexSessionStatus): Draft | undefined {
  if (!status) return undefined
  return {
    sandboxMode: status.sandboxMode,
    approvalPolicy: status.approvalPolicy,
    webSearch: status.webSearch,
    // Older main-process builds may omit the tuning fields from the status
    // snapshot; fall back to the historical hardcoded behavior.
    personality: status.personality ?? 'default',
    reasoningSummary: status.reasoningSummary ?? 'auto',
    showRawReasoning: status.showRawReasoning ?? true,
    modelVerbosity: status.modelVerbosity ?? 'default',
    notifyOnTurnComplete: status.notifyOnTurnComplete ?? true,
    // Older main-process builds omit the field; ON mirrors the historical
    // hardcoded `features.memories=true` launch pin.
    memoriesEnabled: status.memoriesEnabled ?? true,
  }
}

function RadioGroup<T extends string>({
  legend,
  legendEn,
  value,
  options,
  onChange,
}: {
  legend: string
  legendEn: string
  value: T
  options: readonly PanelOption<T>[]
  onChange: (value: T) => void
}) {
  return (
    <fieldset className="rounded-lg border border-zinc-800/80 bg-black/20 p-2">
      <legend className="px-1 text-[11px] font-medium text-zinc-400">
        {legend} <span className="font-mono text-[10px] text-zinc-600">{legendEn}</span>
      </legend>
      <div className="mt-1 space-y-1">
        {options.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-1.5 py-1 text-[11px] text-zinc-300 transition-colors duration-200 hover:bg-cyan-400/5"
          >
            <span className="flex items-center gap-2">
              <input
                type="radio"
                checked={value === option.value}
                onChange={() => onChange(option.value)}
                className="h-3 w-3 cursor-pointer accent-cyan-300"
              />
              <span>{option.label}</span>
            </span>
            <span className="font-mono text-[10px] text-zinc-500">{option.value}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

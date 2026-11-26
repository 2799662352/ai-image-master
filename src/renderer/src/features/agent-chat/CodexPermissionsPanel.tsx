import { useMemo, useState } from 'react'
import type {
  CodexApprovalPolicy,
  CodexModelVerbosity,
  CodexPersonality,
  CodexReasoningSummaryMode,
  CodexSandboxMode,
  CodexSessionConfig,
  CodexSessionStatus,
  CodexWebSearchMode,
  GrokRemoteMcpServer,
} from '../../../../types/agent'
import {
  XAI_REMOTE_MCP_MAX,
  formatRemoteMcpLines,
  parseRemoteMcpLines,
  sameRemoteMcpServers,
} from '../../../../shared/xaiServerTools'

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
// `untrusted`(旧「严格审批」)已被 openai/codex#39630 在 0.149.0 退役,显式传入
// 会让 app-server 在 config 加载阶段直接失败。最接近的存活档是 on-request——
// 上游对 untrusted 项目的替代行为就是「每条命令都请求审批」。
const APPROVAL_OPTIONS: PanelOption<CodexApprovalPolicy>[] = [
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
  | 'grokXSearch'
  | 'grokCodeInterpreter'
> & {
  // 数组字段不能走下面 `DRAFT_KEYS` 的 `===` 比较,单独带着,比较时用 `sameRemoteMcpServers`。
  // 面板里编辑它用的是文本框(`mcpText`),这里只是「应用后的基线」。
  grokRemoteMcp: GrokRemoteMcpServer[]
}

export function CodexPermissionsPanel({ status, onApply, onReset, onResetMemory }: CodexPermissionsPanelProps) {
  const [draft, setDraft] = useState<Draft | undefined>(() => statusToDraft(status))
  const [applying, setApplying] = useState(false)
  const [persist, setPersist] = useState(false)
  const [memoryResetArmed, setMemoryResetArmed] = useState(false)
  const [memoryResetBusy, setMemoryResetBusy] = useState(false)
  const [memoryNotice, setMemoryNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  // Diff against the fallback-resolved snapshot (not the raw status): older
  // main-process builds omit the tuning fields, and comparing 'default'
  // against undefined would wrongly mark them as changed on every apply.
  const [baseline, setBaseline] = useState<Draft | undefined>(() => statusToDraft(status))
  // 远程 MCP 用文本框编辑(每行「标签 地址」):键入过程中的半截内容不能立刻被解析结果覆盖,
  // 所以文本自己是一份状态,解析出的列表只在合法时才进 patch。
  const [mcpText, setMcpText] = useState(() => formatRemoteMcpLines(statusToDraft(status)?.grokRemoteMcp ?? []))
  const nextBaseline = statusToDraft(status)
  if (!sameDraft(nextBaseline, baseline)) {
    // Resync during render rather than in an effect. An effect would leave a
    // window where a click lands first and then gets clobbered by the late
    // flush, and it would also discard unsaved edits whenever the parent merely
    // rebuilt a value-identical snapshot object.
    setBaseline(nextBaseline)
    setDraft(nextBaseline)
    setMcpText(formatRemoteMcpLines(nextBaseline?.grokRemoteMcp ?? []))
  }
  const mcpParsed = useMemo(() => parseRemoteMcpLines(mcpText), [mcpText])

  const patch = useMemo(() => {
    if (!baseline || !draft) return {}
    const next: Partial<CodexSessionConfig> = {}
    if (draft.grokXSearch !== baseline.grokXSearch) next.grokXSearch = draft.grokXSearch
    if (draft.grokCodeInterpreter !== baseline.grokCodeInterpreter) next.grokCodeInterpreter = draft.grokCodeInterpreter
    if (
      mcpParsed.errors.length === 0
      && !sameRemoteMcpServers(mcpParsed.servers, baseline.grokRemoteMcp)
    ) {
      next.grokRemoteMcp = mcpParsed.servers
    }
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
  }, [draft, baseline, mcpParsed])

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
  // 文本框里有写错的行时一律拦住「应用」:否则别的改动会被应用、而这一框被悄悄丢掉。
  const mcpInvalid = mcpParsed.errors.length > 0
  // 与主进程 `confirmUnsafeSessionConfigChange` 对齐:只有**新增**的远程 MCP 地址才会弹确认框。
  const knownMcpUrls = new Set((baseline?.grokRemoteMcp ?? []).map((server) => server.url))
  const addsRemoteMcp = (patch.grokRemoteMcp ?? []).some((server) => !knownMcpUrls.has(server.url))
  const unsafe =
    patch.sandboxMode === 'danger-full-access' ||
    patch.approvalPolicy === 'never' ||
    patch.webSearch === 'live' ||
    addsRemoteMcp

  async function apply(): Promise<void> {
    if (!changed || mcpInvalid) return
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
          disabled={!changed || applying || mcpInvalid}
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

      <fieldset
        className="mt-3 rounded-lg border border-zinc-800/80 bg-black/20 p-2"
        data-testid="grok-server-tools"
      >
        <legend className="px-1 text-[11px] font-medium text-zinc-400">
          Grok 服务端工具 <span className="font-mono text-[10px] text-zinc-600">xAI server-side tools</span>
        </legend>
        <p className="px-0.5 text-[10px] leading-4 text-zinc-500">
          只对 Grok 模型的请求生效(API易 / Miau / Right.Codes 的 Grok 渠道),由 xAI 在服务端执行。
          与上面其他项不同,这里的开关<span className="text-zinc-300">对 Grok 的下一条消息就生效</span>,无需新开会话。
          网关不支持时会自动退回不带这些工具的请求并写日志,不会让对话报错。
        </p>
        <label className="mt-1 flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[11px] text-zinc-300 transition-colors duration-200 hover:bg-cyan-400/5">
          <input
            type="checkbox"
            checked={draft.grokXSearch}
            onChange={() => setDraft({ ...draft, grokXSearch: !draft.grokXSearch })}
            className="h-3 w-3 cursor-pointer accent-cyan-300"
          />
          <span>X 搜索</span>
          <span className="font-mono text-[10px] text-zinc-500">x_search</span>
        </label>
        <p className="px-0.5 pl-6 text-[10px] leading-4 text-zinc-500">
          检索 X(推特)上的实时帖子与账号动态。随「联网搜索」走:联网搜索选「关闭」时不生效。
          单次问答可能搜索 20 多次、约 45 秒,注入的 token 也多,费用明显高于普通联网搜索。
        </p>
        {draft.grokXSearch && draft.webSearch === 'disabled' ? (
          <p className="px-0.5 pl-6 text-[10px] leading-4 text-amber-300">
            当前联网搜索为「关闭」,X 搜索不会被发送。
          </p>
        ) : null}
        <label className="mt-1 flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-[11px] text-zinc-300 transition-colors duration-200 hover:bg-cyan-400/5">
          <input
            type="checkbox"
            checked={draft.grokCodeInterpreter}
            onChange={() => setDraft({ ...draft, grokCodeInterpreter: !draft.grokCodeInterpreter })}
            className="h-3 w-3 cursor-pointer accent-cyan-300"
          />
          <span>代码执行</span>
          <span className="font-mono text-[10px] text-zinc-500">code_interpreter</span>
        </label>
        <p className="px-0.5 pl-6 text-[10px] leading-4 text-zinc-500">
          xAI 服务端的 Python 沙箱,适合精确计算与数据处理。它看不到你电脑上的文件,
          读写本机文件与运行项目命令仍走本地工具。
        </p>
        <div className="mt-1.5 px-0.5">
          <label htmlFor="grok-remote-mcp" className="text-[11px] text-zinc-300">
            远程 MCP 服务器 <span className="font-mono text-[10px] text-zinc-500">mcp</span>
          </label>
          <textarea
            id="grok-remote-mcp"
            value={mcpText}
            onChange={(event) => setMcpText(event.target.value)}
            rows={3}
            spellCheck={false}
            placeholder={'每行一个:标签 https://地址\n例:deepwiki https://mcp.deepwiki.com/mcp'}
            className="mt-1 w-full resize-y rounded-md border border-zinc-800 bg-black/30 px-2 py-1 font-mono text-[11px] leading-4 text-zinc-200 placeholder:text-zinc-600 focus:border-cyan-400/50 focus:outline-none"
          />
          <p className="mt-1 text-[10px] leading-4 text-zinc-500">
            连接由 xAI 服务端发起:地址必须是公网可达的 https 地址(不能是 localhost / 内网 / 带账号密码的地址),
            最多 {XAI_REMOTE_MCP_MAX} 个,工具调用自动放行。
            <span className="text-amber-300">你的对话内容会经 xAI 发送到这些地址,请只接入可信服务。</span>
          </p>
          {mcpInvalid ? (
            <ul className="mt-1 space-y-0.5" role="alert" data-testid="grok-remote-mcp-errors">
              {mcpParsed.errors.map((message) => (
                <li key={message} className="text-[10px] leading-4 text-rose-300">{message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </fieldset>

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
    // xAI 服务端工具:旧主进程不带这三项,按「全关」处理(与主进程默认值一致)。
    grokXSearch: status.grokXSearch ?? false,
    grokCodeInterpreter: status.grokCodeInterpreter ?? false,
    grokRemoteMcp: (status.grokRemoteMcp ?? []).map((server) => ({ ...server })),
  }
}

const DRAFT_KEYS = [
  'sandboxMode',
  'approvalPolicy',
  'webSearch',
  'personality',
  'reasoningSummary',
  'showRawReasoning',
  'modelVerbosity',
  'notifyOnTurnComplete',
  'memoriesEnabled',
  'grokXSearch',
  'grokCodeInterpreter',
] as const satisfies readonly (keyof Draft)[]

function sameDraft(a?: Draft, b?: Draft): boolean {
  if (!a || !b) return a === b
  return DRAFT_KEYS.every((key) => a[key] === b[key])
    && sameRemoteMcpServers(a.grokRemoteMcp, b.grokRemoteMcp)
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

import { useState } from 'react'
import type {
  CodexApprovalRequest,
  CodexApprovalResponse,
  CodexUserInputOption,
  CodexUserInputQuestion,
} from '../../../../types/agent'

/**
 * Codex 内置 `request_user_input` 工具的提问卡。
 *
 * ## 为什么要有这张卡
 *
 * Plan 模式的系统提示词会**强推**模型用 `request_user_input`（而不是我们的
 * `ask_user` MCP 工具）向用户提问。它在 app-server 协议里是一个服务端→客户端
 * 的请求（`item/tool/requestUserInput`），要客户端应答；没人应答，codex 就一直
 * 等，直到用户手动打断 —— 出图一个字节都没跑，用户看到的是「卡住了」。
 *
 * ## 视觉与 AskUserCard 同一套
 *
 * 同一个人被问同一类问题，不该因为问题来自 codex 内置工具还是我们的 MCP 工具
 * 就长得不一样。青色卡、选项按钮、自由输入、跳过 —— 全部照 `AskUserCard`。
 *
 * ## 交互规则
 *
 * - 只有一题、有选项、不允许自由输入：点选项即提交（少一次点击）。
 * - 其余情况：逐题作答，全部有答案后「提交」才可点。
 * - 「跳过 / 你来定」= 空答案表，协议里合法，模型会拿到「用户没有作答」。
 * - `isSecret` 的自由输入用 password 框；`options` 为 null 时只有输入框。
 */
interface CodexUserInputPromptProps {
  request: CodexApprovalRequest
  onRespond: (response: CodexApprovalResponse) => void | Promise<void>
}

export function CodexUserInputPrompt({ request, onRespond }: CodexUserInputPromptProps) {
  const questions = parseUserInputQuestions(request.params)
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [typed, setTyped] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  const answerFor = (q: CodexUserInputQuestion): string =>
    (picked[q.id] ?? '').trim() || (typed[q.id] ?? '').trim()

  const allAnswered = questions.length > 0 && questions.every((q) => answerFor(q).length > 0)

  // 单题 + 有选项 + 不许自由输入 → 点选项直接提交，不再多一步「提交」。
  const instant =
    questions.length === 1
    && (questions[0].options?.length ?? 0) > 0
    && !questions[0].isOther

  async function send(answers: Record<string, { answers: string[] }>, approved: boolean): Promise<void> {
    setSubmitting(true)
    try {
      await onRespond({ id: request.id, approved, answers })
    } finally {
      setSubmitting(false)
    }
  }

  const submitAll = (): Promise<void> => {
    const answers: Record<string, { answers: string[] }> = {}
    for (const q of questions) {
      const value = answerFor(q)
      if (value) answers[q.id] = { answers: [value] }
    }
    return send(answers, true)
  }

  const pickOption = (q: CodexUserInputQuestion, option: CodexUserInputOption): void => {
    if (instant) {
      void send({ [q.id]: { answers: [option.label] } }, true)
      return
    }
    setPicked((prev) => ({ ...prev, [q.id]: option.label }))
  }

  const skip = (): Promise<void> => send({}, false)

  return (
    <div
      data-testid="codex-user-input-card"
      className="rounded-lg border border-cyan-400/25 bg-zinc-900/50 px-3 py-3 shadow-[0_0_14px_rgba(34,211,238,0.08)]"
    >
      {questions.length === 0 ? (
        <p className="text-[12.5px] text-zinc-300">Codex 想向你确认一件事，但没有附带问题内容。</p>
      ) : (
        <div className="space-y-3">
          {questions.map((q) => (
            <section key={q.id} data-testid="codex-user-input-question">
              {q.header ? (
                <p className="mb-1 text-[10px] uppercase tracking-[0.28em] text-cyan-200/60">{q.header}</p>
              ) : null}
              <div className="mb-2 flex items-center gap-2">
                <span
                  aria-hidden
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-cyan-400/40 text-[10px] font-bold text-cyan-300"
                >
                  ?
                </span>
                <p className="text-[13px] font-medium leading-snug text-zinc-100">{q.question}</p>
              </div>

              {q.options && q.options.length > 0 ? (
                <div className="flex flex-col gap-1.5" role="group" aria-label={q.question}>
                  {q.options.map((option) => {
                    const selected = !instant && picked[q.id] === option.label
                    return (
                      <button
                        key={option.label}
                        type="button"
                        disabled={submitting}
                        aria-pressed={instant ? undefined : selected}
                        onClick={() => pickOption(q, option)}
                        className={`cursor-pointer rounded-md border px-3 py-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-300/50 disabled:cursor-not-allowed disabled:opacity-60 ${
                          selected
                            ? 'border-cyan-400/60 bg-cyan-400/15'
                            : 'border-zinc-700/70 bg-zinc-800/50 hover:border-cyan-400/50 hover:bg-cyan-400/10'
                        }`}
                      >
                        <span className="text-[12.5px] font-medium text-zinc-100">{option.label}</span>
                        {option.description ? (
                          <span className="mt-0.5 block text-[11px] leading-snug text-zinc-400">
                            {option.description}
                          </span>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              ) : null}

              {q.isOther || !q.options || q.options.length === 0 ? (
                <input
                  type={q.isSecret ? 'password' : 'text'}
                  aria-label={q.options && q.options.length > 0 ? '或自定义' : q.question}
                  value={typed[q.id] ?? ''}
                  disabled={submitting}
                  onChange={(e) => {
                    const value = e.target.value
                    setTyped((prev) => ({ ...prev, [q.id]: value }))
                    // 开始自己打字就视为放弃已点的选项，避免两半都算数。
                    if (value.trim() && picked[q.id]) {
                      setPicked((prev) => {
                        const next = { ...prev }
                        delete next[q.id]
                        return next
                      })
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    if (allAnswered) void submitAll()
                  }}
                  placeholder={q.options && q.options.length > 0 ? '或自定义…' : '输入你的回答…'}
                  className="mt-2 w-full min-w-0 rounded-md border border-zinc-700/70 bg-zinc-900/60 px-2.5 py-1.5 text-[12px] text-zinc-100 placeholder:text-zinc-500 focus-visible:border-cyan-400/50 focus-visible:outline-none disabled:opacity-60"
                />
              ) : null}
            </section>
          ))}
        </div>
      )}

      <div className="mt-2.5 flex items-center justify-between gap-2">
        <button
          type="button"
          disabled={submitting}
          onClick={() => void skip()}
          className="cursor-pointer rounded-md px-2 py-1 text-[11.5px] text-zinc-400 transition-colors hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-60"
        >
          跳过 / 你来定
        </button>
        {!instant && questions.length > 0 ? (
          <button
            type="button"
            disabled={submitting || !allAnswered}
            onClick={() => void submitAll()}
            className="cursor-pointer rounded-md border border-cyan-400/40 bg-cyan-400/15 px-3 py-1.5 text-[12px] font-semibold text-cyan-100 transition-colors hover:bg-cyan-400/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-300/50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            提交
          </button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * 把线上 params 里的 `questions` 收成强类型。这是外部输入（来自 codex 子进程），
 * 缺字段就补默认，整条不像问题的就丢 —— 渲染层不该因为一个字段缺失整卡崩掉。
 */
export function parseUserInputQuestions(params: Record<string, unknown>): CodexUserInputQuestion[] {
  const raw = params['questions']
  if (!Array.isArray(raw)) return []
  const out: CodexUserInputQuestion[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const q = entry as Record<string, unknown>
    const id = typeof q.id === 'string' ? q.id : ''
    const question = typeof q.question === 'string' ? q.question : ''
    if (!id || !question) continue
    const options = Array.isArray(q.options)
      ? (q.options as unknown[])
          .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
          .map((o) => ({
            label: typeof o.label === 'string' ? o.label : '',
            description: typeof o.description === 'string' ? o.description : '',
          }))
          .filter((o) => o.label.length > 0)
      : null
    out.push({
      id,
      header: typeof q.header === 'string' ? q.header : '',
      question,
      isOther: q.isOther === true,
      isSecret: q.isSecret === true,
      options,
    })
  }
  return out
}

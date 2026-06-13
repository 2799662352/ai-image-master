import { useState } from 'react'
import type { ChoiceAnswer, ChoiceOption, ChoiceRequestItem } from '../../../../../types/agent-timeline'
import { useAgentChatStore } from '../store'

/**
 * Interactive `ask_user` card: a standalone, clickable question rendered as its
 * own message (NOT inside an assistant text bubble), driven by the `ask_user`
 * MCP tool. Clicking an option / confirming a multi-select / submitting free
 * text / skipping calls `settleChoiceRequest`, which resolves the agent's
 * blocked tool call AND flips this card to a read-only summary in place. Once
 * answered the controls disappear so the transcript stays clean on reload.
 */
export function AskUserCard({ item }: { item: ChoiceRequestItem }) {
  const settle = useAgentChatStore((s) => s.settleChoiceRequest)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [freeText, setFreeText] = useState('')

  const answered = item.status === 'answered'

  if (answered) {
    return <AnsweredSummary item={item} />
  }

  // A multi-select confirm with nothing picked AND no free text would send an
  // ambiguous {answered:false, skipped:false} answer + blank summary — block it.
  const multiEmpty = checked.size === 0 && freeText.trim().length === 0

  const finish = (answer: ChoiceAnswer): void => settle(item.requestId, answer)

  const pickSingle = (option: ChoiceOption): void =>
    finish({ answered: true, skipped: false, selected: [option] })

  const toggleMulti = (id: string): void =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const confirmMulti = (): void => {
    const selected = item.options.filter((o) => checked.has(o.id))
    const text = freeText.trim()
    if (selected.length === 0 && text.length === 0) return
    finish({
      answered: true,
      skipped: false,
      selected,
      ...(text ? { freeText: text } : {}),
    })
  }

  const submitText = (): void => {
    const text = freeText.trim()
    if (!text) return
    finish({ answered: true, skipped: false, selected: [], freeText: text })
  }

  const skip = (): void =>
    finish({ answered: false, skipped: true, selected: [] })

  return (
    <div
      data-testid="ask-user-card"
      className="mb-1 rounded-lg border border-cyan-400/25 bg-zinc-900/50 px-3 py-3 shadow-[0_0_14px_rgba(34,211,238,0.08)]"
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          aria-hidden
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-cyan-400/40 text-[10px] font-bold text-cyan-300"
        >
          ?
        </span>
        <p className="text-[13px] font-medium leading-snug text-zinc-100">{item.question}</p>
      </div>

      {item.options.length > 0 && (
        <div className="flex flex-col gap-1.5" role="group">
          {item.options.map((option) =>
            item.mode === 'single' ? (
              <button
                key={option.id}
                type="button"
                onClick={() => pickSingle(option)}
                className="group/opt cursor-pointer rounded-md border border-zinc-700/70 bg-zinc-800/50 px-3 py-2 text-left transition-colors duration-150 hover:border-cyan-400/50 hover:bg-cyan-400/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-300/50"
              >
                <span className="text-[12.5px] font-medium text-zinc-100">{option.label}</span>
                {option.description && (
                  <span className="mt-0.5 block text-[11px] leading-snug text-zinc-400">
                    {option.description}
                  </span>
                )}
              </button>
            ) : (
              <label
                key={option.id}
                className="flex cursor-pointer items-start gap-2 rounded-md border border-zinc-700/70 bg-zinc-800/50 px-3 py-2 transition-colors duration-150 hover:border-cyan-400/40 hover:bg-cyan-400/5"
              >
                <input
                  type="checkbox"
                  checked={checked.has(option.id)}
                  onChange={() => toggleMulti(option.id)}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-cyan-400"
                />
                <span>
                  <span className="text-[12.5px] font-medium text-zinc-100">{option.label}</span>
                  {option.description && (
                    <span className="mt-0.5 block text-[11px] leading-snug text-zinc-400">
                      {option.description}
                    </span>
                  )}
                </span>
              </label>
            ),
          )}
        </div>
      )}

      {item.allowFreeText && (
        <div className="mt-2 flex items-center gap-1.5">
          <input
            type="text"
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              if (item.mode === 'single') submitText()
              else confirmMulti()
            }}
            placeholder={item.options.length > 0 ? '或自定义…' : '输入你的回答…'}
            className="min-w-0 flex-1 rounded-md border border-zinc-700/70 bg-zinc-900/60 px-2.5 py-1.5 text-[12px] text-zinc-100 placeholder:text-zinc-500 focus-visible:border-cyan-400/50 focus-visible:outline-none"
          />
          {item.mode === 'single' && (
            <button
              type="button"
              onClick={submitText}
              disabled={freeText.trim().length === 0}
              className="shrink-0 cursor-pointer rounded-md border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1.5 text-[12px] font-medium text-cyan-200 transition-colors hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              提交
            </button>
          )}
        </div>
      )}

      <div className="mt-2.5 flex items-center justify-between gap-2">
        {item.allowSkip ? (
          <button
            type="button"
            onClick={skip}
            className="cursor-pointer rounded-md px-2 py-1 text-[11.5px] text-zinc-400 transition-colors hover:text-zinc-200"
          >
            跳过 / 你来定
          </button>
        ) : (
          <span />
        )}
        {item.mode === 'multi' && (
          <button
            type="button"
            onClick={confirmMulti}
            disabled={multiEmpty}
            className="cursor-pointer rounded-md border border-cyan-400/40 bg-cyan-400/15 px-3 py-1.5 text-[12px] font-semibold text-cyan-100 transition-colors hover:bg-cyan-400/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-300/50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            确认
          </button>
        )}
      </div>
    </div>
  )
}

/** Read-only recap shown after the user answers — keeps the transcript clean. */
function AnsweredSummary({ item }: { item: ChoiceRequestItem }) {
  const answer = item.answer
  const labels = answer?.selected.map((o) => o.label) ?? []
  const text = answer?.freeText?.trim()
  const skipped = answer?.skipped === true && labels.length === 0 && !text

  return (
    <div
      data-testid="ask-user-card-answered"
      className="mb-1 rounded-lg border border-zinc-700/60 bg-zinc-900/40 px-3 py-2.5"
    >
      <p className="mb-1 text-[12px] leading-snug text-zinc-400">{item.question}</p>
      {skipped ? (
        <p className="text-[12.5px] font-medium text-zinc-500">已跳过（交给你决定）</p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {labels.map((label, i) => (
            <span
              key={`${label}-${i}`}
              className="rounded-md border border-cyan-400/30 bg-cyan-400/10 px-2 py-0.5 text-[12px] font-medium text-cyan-200"
            >
              {label}
            </span>
          ))}
          {text && <span className="text-[12.5px] text-zinc-200">“{text}”</span>}
        </div>
      )}
    </div>
  )
}

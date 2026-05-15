import { useRef } from 'react'
import type { MediaRef } from '../../components/shared/media-tokens/types'
import { useTokenAutocomplete, TokenAutocomplete, MentionChips } from '../../components/shared/media-tokens'
import { useAutosizeTextarea } from '../../hooks/useAutosizeTextarea'
import '../../components/shared/media-tokens/media-tokens.css'

interface Props {
  text: string
  onChange: (s: string) => void
  perPromptCount: number
  onPerPromptCountChange: (n: number) => void
  mediaRefs?: MediaRef[]
}

/**
 * BatchPromptMulti - 多提示词模式:textarea(整段)+ 每条出 1 或 2 张
 * 替代 PunkPromptMulti 的米白 sticker + P5 tab。
 */
export default function BatchPromptMulti({
  text,
  onChange,
  perPromptCount,
  onPerPromptCountChange,
  mediaRefs = [],
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const ac = useTokenAutocomplete({
    mediaRefs,
    textareaRef: taRef,
    value: text,
    onValueChange: onChange,
  })
  // Multi-prompt mode usually has many lines; cap at 36 so the page can
  // still scroll if someone pastes a 200-line corpus.
  useAutosizeTextarea(taRef, text, { minRows: 10, maxRows: 36 })

  const lineCount = text.split('\n').filter((l) => l.trim()).length

  return (
    <div className="border-2 border-zinc-700 bg-zinc-900/60 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <label className="font-mono text-[11px] uppercase tracking-[0.2em] text-cyberpunk-yellow/80">
          // MULTI 批量提示词
        </label>
        <span className="font-mono text-[11px] text-zinc-500 tabular-nums">
          {lineCount} 行 × {perPromptCount}
        </span>
      </div>

      <div className="relative">
        <textarea
          ref={taRef}
          value={text}
          onChange={ac.handleChange}
          onKeyDown={ac.handleKeyDown}
          rows={10}
          placeholder={'一只赛博狐少女, 霓虹品红, 涩谷夜景\n\n机械蝴蝶, 油画风, 暖色\n\n现代极简客厅, 等距视角\n\n... 用换行/空行分隔不同提示词\n输入 @ 引用参考图'}
          className="w-full px-3 py-2.5 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 font-sans text-sm focus:outline-none focus:border-cyberpunk-yellow resize-none transition-[height] duration-100"
        />
        <TokenAutocomplete
          visible={ac.visible}
          suggestions={ac.suggestions}
          selectedIndex={ac.selectedIndex}
          position={ac.position}
          theme="default"
          onSelect={ac.selectToken}
          onClose={ac.handleClose}
          onHover={ac.handleHover}
        />
        <MentionChips value={text} mediaRefs={mediaRefs} theme="default" onValueChange={onChange} />
      </div>

      <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
        ⚠ 用<strong className="text-zinc-300"> 换行 </strong>分隔不同提示词(空行可选,仅可读性用)
      </p>

      {/* 每条出几张 */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-400">
          // 每条出张数
        </span>
        {[1, 2].map((n) => {
          const active = perPromptCount === n
          return (
            <button
              key={n}
              type="button"
              onClick={() => onPerPromptCountChange(n)}
              aria-pressed={active}
              className={`px-3 py-1 border-2 font-mono text-xs uppercase tracking-wider transition-colors ${
                active
                  ? 'border-cyberpunk-yellow bg-cyberpunk-yellow text-cyberpunk-black'
                  : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500'
              }`}
            >
              × {n}
            </button>
          )
        })}
      </div>
    </div>
  )
}

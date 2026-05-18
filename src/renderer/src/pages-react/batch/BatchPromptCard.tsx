import { useRef } from 'react'
import type { MediaRef } from '../../components/shared/media-tokens/types'
import { useTokenAutocomplete, TokenAutocomplete, MentionChips } from '../../components/shared/media-tokens'
import { useAutosizeTextarea } from '../../hooks/useAutosizeTextarea'
import '../../components/shared/media-tokens/media-tokens.css'

interface Props {
  prompt: string
  count: number
  onPromptChange: (s: string) => void
  onCountChange: (n: number) => void
  mediaRefs?: MediaRef[]
}

/**
 * BatchPromptCard - 抽卡模式:单条提示词 + 抽卡数量滑块
 * 替代 PunkPromptCard 的米白 sticker + 粉红 P5 滑块卡片。
 */
export default function BatchPromptCard({
  prompt,
  count,
  onPromptChange,
  onCountChange,
  mediaRefs = [],
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const ac = useTokenAutocomplete({
    mediaRefs,
    textareaRef: taRef,
    value: prompt,
    onValueChange: onPromptChange,
  })
  useAutosizeTextarea(taRef, prompt, { minRows: 6, maxRows: 24 })

  return (
    <div className="border-2 border-zinc-700 bg-zinc-900/60 p-4 space-y-3">
      {/* 标签 */}
      <div className="flex items-center justify-between gap-2">
        <label className="font-mono text-[11px] uppercase tracking-[0.2em] text-cyberpunk-yellow/80">
          // INPUT 提示词
        </label>
        <span className="font-mono text-[11px] text-zinc-500 tabular-nums">
          {prompt.trim().length} chars
        </span>
      </div>

      {/* textarea + autocomplete */}
      <div className="relative">
        <textarea
          ref={taRef}
          value={prompt}
          onChange={ac.handleChange}
          onKeyDown={ac.handleKeyDown}
          rows={6}
          placeholder={'描述你想要生成的图片...\n\n例: 一只穿水手服的赛博狐少女, 霓虹品红配色,\n站在涩谷十字路口, 半色调, 高对比\n\n输入 @ 引用参考图'}
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
        <MentionChips value={prompt} mediaRefs={mediaRefs} theme="default" onValueChange={onPromptChange} />
      </div>

      <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
        ⚠ 同一提示词跑 N 次,服务器照扣费 · 违规图照样烧钱
      </p>

      {/* 抽卡数量 slider */}
      <div className="border border-zinc-700 bg-zinc-950/60 px-3 py-2.5">
        <div className="flex items-center justify-between gap-3 mb-1.5">
          <label className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-400">
            // QUANTITY 抽卡数
          </label>
          <span className="text-2xl font-orbitron font-bold text-cyberpunk-yellow leading-none tabular-nums">
            {count}
          </span>
        </div>

        <input
          type="range"
          min={2}
          max={10}
          value={count}
          onChange={(e) => onCountChange(Number(e.target.value))}
          aria-label="抽卡数量"
          className="w-full accent-cyberpunk-yellow"
        />

        <div className="mt-1 flex justify-between font-mono text-[10px] uppercase tracking-wider text-zinc-500">
          <span>02 min</span>
          <span>10 max</span>
        </div>
      </div>
    </div>
  )
}

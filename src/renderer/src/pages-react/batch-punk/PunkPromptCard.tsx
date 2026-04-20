import { useRef } from 'react'
import type { MediaRef } from '../../components/shared/media-tokens/types'
import { useTokenAutocomplete, TokenAutocomplete, MentionChips } from '../../components/shared/media-tokens'
import '../../components/shared/media-tokens/media-tokens.css'

interface Props {
  prompt: string
  count: number
  onPromptChange: (s: string) => void
  onCountChange: (n: number) => void
  mediaRefs?: MediaRef[]
}

/**
 * PunkPromptCard - 抽卡模式: 单提示词 + 抽卡数量 滑块
 */
export default function PunkPromptCard({ prompt, count, onPromptChange, onCountChange, mediaRefs = [] }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const ac = useTokenAutocomplete({
    mediaRefs,
    textareaRef: taRef,
    value: prompt,
    onValueChange: onPromptChange,
  })

  return (
    <div
      className="p-sticker"
      style={{
        background: 'var(--punk-cream)',
        padding: '1.2rem 1.4rem',
        marginBottom: 18,
      }}
    >
      {/* Label 行 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 10,
          flexWrap: 'wrap',
          gap: 10,
        }}
      >
        <label className="p-display p-italic" style={{ fontSize: 22, color: 'var(--punk-black)' }}>
          INPUT // 提示词
        </label>
        <span className="p-mono" style={{ fontSize: 12, color: 'var(--punk-pink-deep)', fontWeight: 900 }}>
          {prompt.trim().length} CHARS
        </span>
      </div>

      <textarea
        ref={taRef}
        value={prompt}
        onChange={ac.handleChange}
        onKeyDown={ac.handleKeyDown}
        rows={6}
        placeholder={`一只穿水手服的赛博狐少女, 霓虹品红配色,\n站在涩谷十字路口, 手持电锯,\n90s 漫画拼贴风, 半色调, 高对比\n\n输入 @ 引用参考图`}
        className="p-textarea"
        style={{ background: '#fffbef', borderWidth: 3 }}
      />
      <TokenAutocomplete
        visible={ac.visible}
        suggestions={ac.suggestions}
        selectedIndex={ac.selectedIndex}
        position={ac.position}
        theme="punk"
        onSelect={ac.selectToken}
        onClose={ac.handleClose}
        onHover={ac.handleHover}
      />
      <MentionChips value={prompt} mediaRefs={mediaRefs} theme="punk" onValueChange={onPromptChange} />

      <p
        className="p-mono"
        style={{
          fontSize: 11,
          color: 'var(--punk-black)',
          marginTop: 8,
          fontWeight: 700,
          textTransform: 'uppercase',
        }}
      >
        ⚠ 同一提示词跑 N 次, 服务器照扣费 - 违规图照样烧钱
      </p>

      {/* ===== 数量滑块 ===== */}
      <div
        style={{
          marginTop: 18,
          padding: '12px 14px',
          background: 'var(--punk-pink)',
          border: '3px solid var(--punk-black)',
          boxShadow: '4px 4px 0 var(--punk-black)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 8,
          }}
        >
          <label className="p-display" style={{ fontSize: 16, color: 'var(--punk-cream)' }}>
            QUANTITY // 抽卡数
          </label>
          <span
            className="p-display p-italic"
            style={{
              fontSize: 36,
              color: 'var(--punk-cream)',
              lineHeight: 1,
              textShadow: '3px 3px 0 var(--punk-black)',
            }}
          >
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
          className="p-range"
        />

        <div
          className="p-mono"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 10,
            color: 'var(--punk-cream)',
            marginTop: 4,
            fontWeight: 900,
          }}
        >
          <span>02 MIN</span>
          <span>10 MAX</span>
        </div>
      </div>
    </div>
  )
}

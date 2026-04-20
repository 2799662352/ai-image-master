import { useRef } from 'react'
import type { MediaRef } from '../../components/shared/media-tokens/types'
import { useTokenAutocomplete, TokenAutocomplete, MentionChips } from '../../components/shared/media-tokens'
import '../../components/shared/media-tokens/media-tokens.css'

interface Props {
  text: string
  onChange: (s: string) => void
  perPromptCount: number
  onPerPromptCountChange: (n: number) => void
  mediaRefs?: MediaRef[]
}

/**
 * PunkPromptMulti - 多提示词模式: textarea (空行/换行分隔) + 每条出几张
 */
export default function PunkPromptMulti({
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

  const lineCount = text.split('\n').filter((l) => l.trim()).length

  return (
    <div
      className="p-sticker"
      style={{
        background: 'var(--punk-cream)',
        padding: '1.2rem 1.4rem',
        marginBottom: 18,
      }}
    >
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
          MULTI // 批量提示词
        </label>
        <span
          className="p-mono"
          style={{ fontSize: 12, color: 'var(--punk-pink-deep)', fontWeight: 900 }}
        >
          {lineCount} LINE{lineCount === 1 ? '' : 'S'} × {perPromptCount}
        </span>
      </div>

      <textarea
        ref={taRef}
        value={text}
        onChange={ac.handleChange}
        onKeyDown={ac.handleKeyDown}
        rows={10}
        placeholder={`一只赛博狐少女, 霓虹品红, 涩谷夜景\n\n机械蝴蝶, 油画风, 暖色\n\n现代极简客厅, 等距视角\n\n... 用空行分隔不同提示词\n输入 @ 引用参考图`}
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
      <MentionChips value={text} mediaRefs={mediaRefs} theme="punk" onValueChange={onChange} />

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
        ⚠ 用<strong> 换行 </strong>分隔不同提示词 (空行可选, 仅可读性用)
      </p>

      {/* 每条提示词出几张 */}
      <div
        style={{
          marginTop: 14,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <span className="p-display" style={{ fontSize: 14 }}>
          每条出张数:
        </span>
        {[1, 2].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onPerPromptCountChange(n)}
            className={`p-tab ${perPromptCount === n ? 'p-tab--active' : ''}`}
            style={{ padding: '0.3rem 0.8rem', fontSize: 14 }}
          >
            × {n}
          </button>
        ))}
      </div>
    </div>
  )
}

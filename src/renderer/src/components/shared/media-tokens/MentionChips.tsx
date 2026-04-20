import { useMemo } from 'react'
import type { MediaRef, TokenTheme } from './types'
import { TOKEN_REGEX } from './types'

interface Props {
  value: string
  mediaRefs: MediaRef[]
  theme: TokenTheme
  onValueChange: (v: string) => void
}

export default function MentionChips({ value, mediaRefs, theme, onValueChange }: Props) {
  const themeClass = `mt-theme-${theme}`
  const isPunk = theme === 'punk'

  const tokens = useMemo(() => {
    const found: { n: number; raw: string }[] = []
    const re = new RegExp(TOKEN_REGEX.source, TOKEN_REGEX.flags)
    let m: RegExpExecArray | null
    while ((m = re.exec(value)) !== null) {
      found.push({ n: Number(m[1]), raw: m[0] })
    }
    return found
  }, [value])

  if (tokens.length === 0) return null

  const removeToken = (raw: string) => {
    const updated = value
      .replace(new RegExp(`\\s?${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s?`, 'g'), ' ')
      .replace(/ {2,}/g, ' ')
      .trim()
    onValueChange(updated)
  }

  return (
    <div className={themeClass}>
      <div className="mt-chips" role="group" aria-label="已引用参考图">
        {tokens.map(({ n, raw }, i) => {
          const ref = mediaRefs.find((r) => r.index === n)
          const missing = !ref
          return (
            <span key={`${raw}-${i}`} className={`mt-chip ${missing ? 'mt-chip--dimmed' : ''}`}>
              {ref?.url ? (
                <img src={ref.url} alt="" className="mt-chip-thumb" />
              ) : (
                <span className="mt-chip-thumb" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, background: isPunk ? 'var(--punk-cream-dim)' : '#3f3f46' }}>📷</span>
              )}
              <span className="mt-chip-label">
                {isPunk ? `@${ref?.label || `图片${n}`}` : (ref?.label || `图片${n}`)}
              </span>
              <button
                type="button"
                className="mt-chip-remove"
                aria-label={`移除 图片${n}`}
                onClick={() => removeToken(raw)}
              >
                ×
              </button>
            </span>
          )
        })}
      </div>
    </div>
  )
}

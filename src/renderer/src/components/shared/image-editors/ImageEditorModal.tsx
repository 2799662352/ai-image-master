import { lazy, Suspense, Component, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const MultiAngleEditor = lazy(() => import('./MultiAngleEditor'))
const LightEditor = lazy(() => import('./LightEditor'))

class WebGLErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children
  }
}

export interface ImageChoice {
  url: string
  label?: string
}

interface Props {
  editorType: 'angle' | 'light'
  imageUrl: string
  /** 可选:多张参考图时渲染顶部缩略图条, 用户可切换 */
  imageChoices?: ImageChoice[]
  theme: 'punk' | 'default'
  onInjectPrompt: (prompt: string) => void
  onClose: () => void
}

export default function ImageEditorModal({
  editorType,
  imageUrl,
  imageChoices,
  theme,
  onInjectPrompt,
  onClose,
}: Props) {
  const isPunk = theme === 'punk'
  const [currentUrl, setCurrentUrl] = useState(imageUrl)

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.6)',
  }

  const panelClass = isPunk
    ? 'border-3 border-[var(--punk-black)] bg-[var(--punk-bg)]'
    : 'bg-zinc-900 rounded-xl shadow-2xl border border-zinc-700'

  const panelStyle: React.CSSProperties = isPunk
    ? { boxShadow: '6px 6px 0px var(--punk-black)' }
    : {}

  const fallbackUI = (
    <div className="p-8 text-center text-zinc-400">
      3D 预览加载失败(可能硬件加速未开启)
    </div>
  )

  const showPicker = imageChoices && imageChoices.length > 1

  return createPortal(
    <div style={overlayStyle} onClick={onClose}>
      <div
        className={`relative max-w-[90vw] max-h-[90vh] overflow-auto p-4 ${panelClass}`}
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {showPicker && (
          <div
            className="mb-3 flex gap-2 items-center flex-wrap"
            style={
              isPunk
                ? {
                    padding: 8,
                    border: '2px solid var(--punk-black)',
                    background: 'var(--punk-cream)',
                  }
                : {
                    padding: 8,
                    borderRadius: 8,
                    background: 'rgba(255,255,255,0.05)',
                  }
            }
          >
            <span
              className={isPunk ? 'p-mono' : 'text-xs'}
              style={{
                fontWeight: 900,
                fontSize: 11,
                letterSpacing: '0.08em',
                color: isPunk ? 'var(--punk-black)' : '#a1a1aa',
              }}
            >
              参考图 / REF.IMG
            </span>
            {imageChoices!.map((ch, i) => {
              const active = ch.url === currentUrl
              return (
                <button
                  key={ch.url}
                  type="button"
                  onClick={() => setCurrentUrl(ch.url)}
                  title={ch.label || `#${i + 1}`}
                  style={{
                    width: 44,
                    height: 44,
                    padding: 0,
                    cursor: 'pointer',
                    border: isPunk
                      ? `3px solid ${active ? 'var(--punk-toxic)' : 'var(--punk-black)'}`
                      : `2px solid ${active ? '#22d3ee' : '#3f3f46'}`,
                    outline: 'none',
                    background: 'transparent',
                    boxShadow: isPunk && active ? '3px 3px 0 var(--punk-pink)' : undefined,
                    transform: active ? 'scale(1.05)' : 'scale(1)',
                    transition: 'transform 120ms ease',
                  }}
                >
                  <img
                    src={ch.url}
                    alt={ch.label || `ref-${i + 1}`}
                    style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                </button>
              )
            })}
          </div>
        )}

        <WebGLErrorBoundary fallback={fallbackUI}>
          <Suspense fallback={<div className="p-8 text-center text-zinc-500">加载中...</div>}>
            {editorType === 'angle' ? (
              <MultiAngleEditor
                imageUrl={currentUrl}
                onInjectPrompt={onInjectPrompt}
                onClose={onClose}
              />
            ) : (
              <LightEditor
                imageUrl={currentUrl}
                onInjectPrompt={onInjectPrompt}
                onClose={onClose}
              />
            )}
          </Suspense>
        </WebGLErrorBoundary>
      </div>
    </div>,
    document.body,
  )
}

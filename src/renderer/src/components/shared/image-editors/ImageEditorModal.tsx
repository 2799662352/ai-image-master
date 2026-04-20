import { lazy, Suspense, Component, useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

const MultiAngleEditor = lazy(() => import('./MultiAngleEditor'))
const LightEditor = lazy(() => import('./LightEditor'))

class WebGLErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.warn('[WebGL ErrorBoundary]', error.message, info.componentStack)
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children
  }
}

interface Props {
  editorType: 'angle' | 'light'
  imageUrl: string
  theme: 'punk' | 'default'
  onInjectPrompt: (prompt: string) => void
  onClose: () => void
}

export default function ImageEditorModal({
  editorType,
  imageUrl,
  theme,
  onInjectPrompt,
  onClose,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const isPunk = theme === 'punk'

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
      3D 预览加载失败（可能硬件加速未开启）
    </div>
  )

  return createPortal(
    <div style={overlayStyle} onClick={onClose}>
      <div
        className={`relative max-w-[90vw] max-h-[90vh] overflow-auto p-4 ${panelClass}`}
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <WebGLErrorBoundary fallback={fallbackUI}>
          <Suspense fallback={<div className="p-8 text-center text-zinc-500">加载中...</div>}>
            {editorType === 'angle' ? (
              <MultiAngleEditor
                imageUrl={imageUrl}
                onInjectPrompt={onInjectPrompt}
                onClose={onClose}
              />
            ) : (
              <LightEditor
                imageUrl={imageUrl}
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

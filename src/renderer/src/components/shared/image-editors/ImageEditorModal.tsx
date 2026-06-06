import { lazy, Suspense, Component, useState, useCallback, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { withRefPrefix } from './prompts'
import { useDisplaySrc } from '../../../hooks/useDisplaySrc'

/**
 * 候选 thumb —— 抽组件让 useDisplaySrc 在 .map() 里安全使用。
 * `currentUrl` / `setCurrentUrl(ch.url)` 仍传原始 url 给 Multi/Light Editor,
 * 那些 WebGL 编辑器需要原图喂 texture, blob:URL 跨进程/canvas 加载不一定可读。
 */
function ChoiceThumb({ url, label, style }: { url: string; label?: string; style: React.CSSProperties }) {
  const imgSrc = useDisplaySrc(url)
  return (
    <img
      src={imgSrc}
      alt={label || 'ref'}
      loading="lazy"
      decoding="async"
      style={style}
    />
  )
}

const MultiAngleEditor = lazy(() => import('./MultiAngleEditor'))
const LightEditor = lazy(() => import('./LightEditor'))
const PanoramaEditor = lazy(() => import('./PanoramaEditor'))

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
  editorType: 'angle' | 'light' | 'panorama'
  imageUrl: string
  /** 可选:多张参考图时渲染顶部缩略图条, 用户可切换 */
  imageChoices?: ImageChoice[]
  theme: 'punk' | 'default'
  onInjectPrompt: (prompt: string) => void
  /** 全景编辑器初始 Tab:'generate' 生成 / 'preview' 进入查看,默认 preview */
  panoramaTab?: 'preview' | 'generate'
  onClose: () => void
}

export default function ImageEditorModal({
  editorType,
  imageUrl,
  imageChoices,
  theme,
  onInjectPrompt,
  panoramaTab = 'preview',
  onClose,
}: Props) {
  const isPunk = theme === 'punk'
  const [currentUrl, setCurrentUrl] = useState(imageUrl)

  // 仅当提供 imageChoices (多参考图场景) 时才加前缀 【@图片N】;
  // 从结果网格 hover 打开 modal 不传 imageChoices, 保持裸 prompt.
  const wrappedInject = useCallback(
    (raw: string) => {
      if (!imageChoices || imageChoices.length === 0) {
        onInjectPrompt(raw)
        return
      }
      const idx = imageChoices.findIndex((c) => c.url === currentUrl)
      const refIndex = idx >= 0 ? idx + 1 : 1
      onInjectPrompt(withRefPrefix(raw, refIndex))
    },
    [imageChoices, currentUrl, onInjectPrompt],
  )

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.6)',
  }

  // NOTE: 加 `donor-punk` 让 portal 内部也能解析 `var(--punk-*)` 以及 `.p-*` 工具类;
  // `.donor-punk` 自带 `overflow: hidden`, 通过 inline style 把滚动行为还原成 auto.
  const panelClass = isPunk
    ? 'donor-punk border-3 border-[var(--punk-black)] bg-[var(--punk-bg)]'
    : 'bg-zinc-900 rounded-xl shadow-2xl border border-zinc-700'

  const panelStyle: React.CSSProperties = isPunk
    ? { boxShadow: '6px 6px 0px var(--punk-black)', overflow: 'auto' }
    : {}

  const fallbackUI = (
    <div className="p-8 text-center text-zinc-400">
      3D 预览加载失败(可能硬件加速未开启)
    </div>
  )

  const showPicker = imageChoices && imageChoices.length > 1

  // 全景查看器:自带大舞台 + 工具栏 + 全屏/关闭,跳过居中面板与缩略图条。
  if (editorType === 'panorama') {
    return createPortal(
      <div style={{ ...overlayStyle, background: 'rgba(0,0,0,0.85)' }} onClick={onClose}>
        <div onClick={(e) => e.stopPropagation()}>
          <WebGLErrorBoundary fallback={fallbackUI}>
            <Suspense fallback={<div className="p-8 text-center text-zinc-500">加载中...</div>}>
              <PanoramaEditor
                imageUrl={currentUrl}
                theme={theme}
                onInjectPrompt={wrappedInject}
                canRef={!!currentUrl}
                initialTab={panoramaTab}
                onClose={onClose}
              />
            </Suspense>
          </WebGLErrorBoundary>
        </div>
      </div>,
      document.body,
    )
  }

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
                  <ChoiceThumb
                    url={ch.url}
                    label={ch.label || `ref-${i + 1}`}
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
                theme={theme}
                onInjectPrompt={wrappedInject}
                onClose={onClose}
              />
            ) : (
              <LightEditor
                imageUrl={currentUrl}
                theme={theme}
                onInjectPrompt={wrappedInject}
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

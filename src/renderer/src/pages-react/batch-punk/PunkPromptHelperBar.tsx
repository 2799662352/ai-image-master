import { useState, useMemo } from 'react'
import { useUIPrefsStore } from '../../stores/useUIPrefsStore'
import type { BatchRefImage } from '../../stores/useBatchStore'
import ImageEditorModal, {
  type ImageChoice,
} from '../../components/shared/image-editors/ImageEditorModal'
import '../../components/shared/image-editors/image-editors.css'

interface Props {
  refImages: BatchRefImage[]
  /** 注入 prompt 到当前模式的输入框 */
  onInject: (text: string) => void
}

/**
 * PunkPromptHelperBar — 生图前的视觉 prompt 辅助:
 * [多角度] [打光] 按钮, 基于用户上传的参考图构造 prompt 注入输入框.
 * 无参考图时按钮禁用并提示.
 */
export default function PunkPromptHelperBar({ refImages, onInject }: Props) {
  const enabled = useUIPrefsStore((s) => s.imageEditorToolbar.enabled)
  const [editorState, setEditorState] = useState<{
    type: 'angle' | 'light'
    imageUrl: string
  } | null>(null)

  const imageChoices = useMemo<ImageChoice[]>(
    () =>
      refImages.map((r, i) => ({
        url: r.base64,
        label: r.fileName || `REF-${i + 1}`,
      })),
    [refImages],
  )

  if (!enabled) return null

  const hasRef = refImages.length > 0
  const openEditor = (type: 'angle' | 'light') => {
    if (!hasRef) return
    setEditorState({ type, imageUrl: refImages[0].base64 })
  }

  const btnBase: React.CSSProperties = {
    padding: '8px 14px',
    fontWeight: 900,
    fontSize: 12,
    letterSpacing: '0.04em',
    cursor: hasRef ? 'pointer' : 'not-allowed',
    opacity: hasRef ? 1 : 0.45,
    border: '3px solid var(--punk-black)',
    background: 'var(--punk-cream)',
    color: 'var(--punk-black)',
    boxShadow: hasRef ? '3px 3px 0 var(--punk-black)' : 'none',
    transition: 'transform 100ms ease, box-shadow 100ms ease',
  }

  return (
    <>
      <div
        role="toolbar"
        aria-label="视觉 prompt 辅助"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          margin: '4px 0 16px',
          flexWrap: 'wrap',
        }}
      >
        <span
          className="p-mono"
          style={{
            fontSize: 11,
            fontWeight: 900,
            letterSpacing: '0.08em',
            color: 'var(--punk-black)',
            opacity: 0.7,
          }}
        >
          // VISUAL.PROMPT
        </span>
        <button
          type="button"
          disabled={!hasRef}
          onClick={() => openEditor('angle')}
          className="p-mono"
          style={btnBase}
          title={hasRef ? '基于参考图构造多角度 prompt' : '请先上传参考图'}
        >
          [ 多角度 // ANGLE ]
        </button>
        <button
          type="button"
          disabled={!hasRef}
          onClick={() => openEditor('light')}
          className="p-mono"
          style={btnBase}
          title={hasRef ? '基于参考图构造打光 prompt' : '请先上传参考图'}
        >
          [ 打光 // LIGHT ]
        </button>
        {!hasRef && (
          <span
            className="p-mono"
            style={{
              fontSize: 10,
              color: 'var(--punk-black)',
              opacity: 0.6,
              letterSpacing: '0.06em',
            }}
          >
            ← 先上传参考图
          </span>
        )}
        {hasRef && refImages.length > 1 && (
          <span
            className="p-mono"
            style={{
              fontSize: 10,
              color: 'var(--punk-black)',
              opacity: 0.7,
              letterSpacing: '0.06em',
            }}
          >
            {refImages.length} 张可选
          </span>
        )}
      </div>

      {editorState && (
        <ImageEditorModal
          editorType={editorState.type}
          imageUrl={editorState.imageUrl}
          imageChoices={imageChoices}
          theme="punk"
          onInjectPrompt={(p) => {
            onInject(p)
            setEditorState(null)
          }}
          onClose={() => setEditorState(null)}
        />
      )}
    </>
  )
}

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
 * BatchPromptHelperBar — 生图前的视觉 prompt 辅助:
 * [多角度] [打光] 按钮,基于用户上传的参考图构造 prompt 注入输入框。
 * 无参考图时按钮禁用。
 *
 * 替代 PunkPromptHelperBar 的米白按钮 + 黑边 P5 投影。
 */
export default function BatchPromptHelperBar({ refImages, onInject }: Props) {
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

  const btnClass = hasRef
    ? 'px-3 py-1.5 border-2 border-zinc-700 bg-zinc-900 text-zinc-200 font-mono text-[11px] uppercase tracking-wider hover:border-cyberpunk-yellow hover:text-cyberpunk-yellow transition-colors'
    : 'px-3 py-1.5 border-2 border-zinc-800 bg-zinc-900/40 text-zinc-600 font-mono text-[11px] uppercase tracking-wider cursor-not-allowed'

  return (
    <>
      <div
        role="toolbar"
        aria-label="视觉 prompt 辅助"
        className="flex items-center gap-2 flex-wrap"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
          // visual prompt
        </span>
        <button
          type="button"
          disabled={!hasRef}
          onClick={() => openEditor('angle')}
          className={btnClass}
          title={hasRef ? '基于参考图构造多角度 prompt' : '请先上传参考图'}
        >
          多角度 // angle
        </button>
        <button
          type="button"
          disabled={!hasRef}
          onClick={() => openEditor('light')}
          className={btnClass}
          title={hasRef ? '基于参考图构造打光 prompt' : '请先上传参考图'}
        >
          打光 // light
        </button>
        {!hasRef && (
          <span className="font-mono text-[10px] text-zinc-500">
            ← 先上传参考图
          </span>
        )}
        {hasRef && refImages.length > 1 && (
          <span className="font-mono text-[10px] text-zinc-500">
            {refImages.length} 张可选
          </span>
        )}
      </div>

      {editorState && (
        <ImageEditorModal
          editorType={editorState.type}
          imageUrl={editorState.imageUrl}
          imageChoices={imageChoices}
          theme="default"
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

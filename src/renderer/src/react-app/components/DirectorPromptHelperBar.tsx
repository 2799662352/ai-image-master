import { useState, useMemo } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'
import { useUIPrefsStore } from '../../stores/useUIPrefsStore'
import ImageEditorModal, {
  type ImageChoice,
} from '../../components/shared/image-editors/ImageEditorModal'
import '../../components/shared/image-editors/image-editors.css'

/**
 * DirectorPromptHelperBar — Director 模式下的视觉 prompt 辅助工具栏。
 * [多角度] [打光] 按钮基于参考图弹出 3D 编辑器，将生成的 prompt 追加到场景描述。
 * 与 PunkPromptHelperBar 同源，但使用 Director 暗色主题与 Director store。
 */
export function DirectorPromptHelperBar() {
  const enabled = useUIPrefsStore((s) => s.imageEditorToolbar.enabled)
  const referenceImages = useDirectorStore((s) => s.referenceImages)
  const sceneDescription = useDirectorStore((s) => s.sceneDescription)
  const setSceneDescription = useDirectorStore((s) => s.setSceneDescription)

  const [editorState, setEditorState] = useState<{
    type: 'angle' | 'light'
    imageUrl: string
  } | null>(null)

  const imageChoices = useMemo<ImageChoice[]>(
    () =>
      referenceImages.map((r, i) => ({
        url: `data:${r.mimeType};base64,${r.data}`,
        label: r.name || `REF-${i + 1}`,
      })),
    [referenceImages],
  )

  if (!enabled) return null

  const hasRef = referenceImages.length > 0

  const openEditor = (type: 'angle' | 'light') => {
    if (!hasRef) return
    setEditorState({ type, imageUrl: imageChoices[0].url })
  }

  const handleInject = (text: string) => {
    const sep = sceneDescription && !sceneDescription.endsWith('\n') ? '\n\n' : ''
    setSceneDescription(sceneDescription + sep + text)
    setEditorState(null)
  }

  const btnClass = (active: boolean) =>
    `px-3 py-1 text-xs font-mono border rounded-none transition-colors ${
      active
        ? 'bg-[#09090B] border-[#3F3F46] text-purple-300 hover:border-purple-400 hover:text-purple-200 cursor-pointer'
        : 'bg-[#09090B] border-[#27272A] text-white/30 cursor-not-allowed'
    }`

  return (
    <>
      <div
        role="toolbar"
        aria-label="视觉 prompt 辅助"
        className="flex items-center gap-2 mb-2 flex-wrap"
      >
        <span className="text-[10px] text-white/40 font-mono uppercase tracking-wider">
          // VISUAL.PROMPT
        </span>
        <button
          type="button"
          disabled={!hasRef}
          onClick={() => openEditor('angle')}
          className={btnClass(hasRef)}
          title={hasRef ? '基于参考图构造多角度 prompt' : '请先上传参考图'}
        >
          [ 多角度 // ANGLE ]
        </button>
        <button
          type="button"
          disabled={!hasRef}
          onClick={() => openEditor('light')}
          className={btnClass(hasRef)}
          title={hasRef ? '基于参考图构造打光 prompt' : '请先上传参考图'}
        >
          [ 打光 // LIGHT ]
        </button>
        {!hasRef && (
          <span className="text-[10px] text-white/40 font-mono">
            ← 先上传参考图
          </span>
        )}
        {hasRef && referenceImages.length > 1 && (
          <span className="text-[10px] text-white/50 font-mono">
            {referenceImages.length} 张可选
          </span>
        )}
      </div>

      {editorState && (
        <ImageEditorModal
          editorType={editorState.type}
          imageUrl={editorState.imageUrl}
          imageChoices={imageChoices}
          theme="default"
          onInjectPrompt={handleInject}
          onClose={() => setEditorState(null)}
        />
      )}
    </>
  )
}

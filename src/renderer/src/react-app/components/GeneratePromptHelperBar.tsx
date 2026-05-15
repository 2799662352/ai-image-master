import { useCallback, useMemo, useState } from 'react'
import { useUIPrefsStore } from '../../stores/useUIPrefsStore'
import ImageEditorModal, {
  type ImageChoice,
} from '../../components/shared/image-editors/ImageEditorModal'
import '../../components/shared/image-editors/image-editors.css'
import { useVanillaPageRefImages } from '../hooks/useVanillaPageRefImages'

interface RawRefImage {
  base64: string
  fileName: string
  mimeType: string
  id: number
  [key: string]: unknown
}

const getGeneratePage = (): any => {
  const w = window as any
  return w.getGeneratePageTS?.() ?? w.generatePageTS ?? null
}

function toDataUrl(img: RawRefImage): string {
  return img.base64.startsWith('data:')
    ? img.base64
    : `data:${img.mimeType};base64,${img.base64}`
}

/**
 * GeneratePromptHelperBar — 图生图模式的视觉 prompt 辅助:
 *   [多角度] [打光] 按钮,基于已上传参考图构造 prompt 并注入 #promptInput。
 *
 * 桥接 vanilla GeneratePage:
 *   - 读: useVanillaPageRefImages (MutationObserver 事件驱动,见 hook 注释)
 *   - 写: 修改 #promptInput.value + dispatch 'input' 事件,让 vanilla 同步内部 state
 *
 * 无参考图时按钮禁用并显示「← 先上传参考图」提示,行为与 BatchPromptHelperBar 一致。
 */
export function GeneratePromptHelperBar() {
  const enabled = useUIPrefsStore((s) => s.imageEditorToolbar.enabled)
  const [editorState, setEditorState] = useState<{
    type: 'angle' | 'light'
    imageUrl: string
  } | null>(null)

  const refImages = useVanillaPageRefImages<RawRefImage>({
    getPage: getGeneratePage,
    previewElementId: 'referenceImagesPreview',
    same: (a, b) => a?.id === b?.id,
  })

  const imageChoices = useMemo<ImageChoice[]>(
    () =>
      refImages.map((r, i) => ({
        url: toDataUrl(r),
        label: r.fileName || `REF-${i + 1}`,
      })),
    [refImages],
  )

  const injectPrompt = useCallback((text: string) => {
    const el = document.getElementById('promptInput') as HTMLTextAreaElement | null
    if (!el) {
      setEditorState(null)
      return
    }
    const current = el.value.trim()
    const next = current ? `${current}, ${text}` : text
    el.value = next
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.focus()
    setEditorState(null)
  }, [])

  if (!enabled) return null

  const hasRef = refImages.length > 0
  const openEditor = (type: 'angle' | 'light') => {
    if (!hasRef) return
    setEditorState({ type, imageUrl: toDataUrl(refImages[0]) })
  }

  const btnClass = hasRef
    ? 'px-3 py-1.5 border-2 border-zinc-700 bg-zinc-900 text-zinc-200 font-mono text-[11px] uppercase tracking-wider hover:border-cyberpunk-yellow hover:text-cyberpunk-yellow transition-colors'
    : 'px-3 py-1.5 border-2 border-zinc-800 bg-zinc-900/40 text-zinc-600 font-mono text-[11px] uppercase tracking-wider cursor-not-allowed'

  return (
    <>
      <div
        role="toolbar"
        aria-label="视觉 prompt 辅助"
        className="flex items-center gap-2 flex-wrap mt-2"
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
          onInjectPrompt={injectPrompt}
          onClose={() => setEditorState(null)}
        />
      )}
    </>
  )
}

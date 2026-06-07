import { useCallback, useMemo } from 'react'
import VisualPromptBar from '../../components/shared/image-editors/VisualPromptBar'
import type { ImageChoice } from '../../components/shared/image-editors/ImageEditorModal'
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
 * GeneratePromptHelperBar — 图生图模式的视觉 prompt 辅助(薄壳)。
 *
 * 桥接 vanilla GeneratePage:
 *   - 读: useVanillaPageRefImages(MutationObserver 事件驱动)
 *   - 写: 修改 #promptInput.value + dispatch 'input',让 vanilla 同步内部 state
 * UI / 交互全部交给共享 VisualPromptBar。
 */
export function GeneratePromptHelperBar() {
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
    if (!el) return
    const current = el.value.trim()
    el.value = current ? `${current}, ${text}` : text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.focus()
  }, [])

  return <VisualPromptBar imageChoices={imageChoices} onInject={injectPrompt} variant="cyber" containerClassName="mt-2" />
}

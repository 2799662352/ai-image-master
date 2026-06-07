import { useCallback, useMemo } from 'react'
import VisualPromptBar from '../../components/shared/image-editors/VisualPromptBar'
import type { ImageChoice } from '../../components/shared/image-editors/ImageEditorModal'
import { useVanillaPageRefImages } from '../hooks/useVanillaPageRefImages'

interface RawCompareRefImage {
  dataUrl: string
  name: string
  size?: number
}

const getComparePage = (): any => {
  const w = window as any
  return w.getComparePageTS?.() ?? w.comparePageTS ?? null
}

/**
 * ComparePromptHelperBar — 模型对比页的视觉 prompt 辅助(薄壳)。
 *
 * 桥接 vanilla ComparePage(CompareReferenceImage = { dataUrl, name }):
 *   - 读: useVanillaPageRefImages(MutationObserver 事件驱动)
 *   - 写: 修改 #comparePrompt.value + dispatch 'input' 让 vanilla 同步
 */
export function ComparePromptHelperBar() {
  const refImages = useVanillaPageRefImages<RawCompareRefImage>({
    getPage: getComparePage,
    previewElementId: 'compareReferenceImageArea',
    same: (a, b) => a?.name === b?.name && (a?.size ?? 0) === (b?.size ?? 0),
  })

  const imageChoices = useMemo<ImageChoice[]>(
    () =>
      refImages.map((r, i) => ({
        url: r.dataUrl,
        label: r.name || `REF-${i + 1}`,
      })),
    [refImages],
  )

  const injectPrompt = useCallback((text: string) => {
    const el = document.getElementById('comparePrompt') as HTMLTextAreaElement | null
    if (!el) return
    const current = el.value.trim()
    el.value = current ? `${current}, ${text}` : text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.focus()
  }, [])

  return <VisualPromptBar imageChoices={imageChoices} onInject={injectPrompt} variant="cyber" containerClassName="mt-2" />
}

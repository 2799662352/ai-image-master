import { useMemo } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'
import VisualPromptBar from '../../components/shared/image-editors/VisualPromptBar'
import type { ImageChoice } from '../../components/shared/image-editors/ImageEditorModal'

/**
 * DirectorPromptHelperBar — Director 模式的视觉 prompt 辅助(薄壳)。
 * 注入目标为场景描述,使用 director 紫色主题。
 */
export function DirectorPromptHelperBar() {
  const referenceImages = useDirectorStore((s) => s.referenceImages)
  const sceneDescription = useDirectorStore((s) => s.sceneDescription)
  const setSceneDescription = useDirectorStore((s) => s.setSceneDescription)

  const imageChoices = useMemo<ImageChoice[]>(
    () =>
      referenceImages.map((r, i) => ({
        url: `data:${r.mimeType};base64,${r.data}`,
        label: r.name || `REF-${i + 1}`,
      })),
    [referenceImages],
  )

  const handleInject = (text: string) => {
    const sep = sceneDescription && !sceneDescription.endsWith('\n') ? '\n\n' : ''
    setSceneDescription(sceneDescription + sep + text)
  }

  return <VisualPromptBar imageChoices={imageChoices} onInject={handleInject} variant="director" />
}

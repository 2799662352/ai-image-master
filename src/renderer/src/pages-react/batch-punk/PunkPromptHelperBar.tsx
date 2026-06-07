import { useMemo } from 'react'
import type { BatchRefImage } from '../../stores/useBatchStore'
import VisualPromptBar from '../../components/shared/image-editors/VisualPromptBar'
import type { ImageChoice } from '../../components/shared/image-editors/ImageEditorModal'

interface Props {
  refImages: BatchRefImage[]
  /** 注入 prompt 到当前模式的输入框 */
  onInject: (text: string) => void
}

/**
 * PunkPromptHelperBar — Punk 主题的视觉 prompt 辅助(薄壳)。
 * UI / 交互交给共享 VisualPromptBar(punk 主题)。
 */
export default function PunkPromptHelperBar({ refImages, onInject }: Props) {
  const imageChoices = useMemo<ImageChoice[]>(
    () =>
      refImages.map((r, i) => ({
        url: r.base64,
        label: r.fileName || `REF-${i + 1}`,
      })),
    [refImages],
  )

  return <VisualPromptBar imageChoices={imageChoices} onInject={onInject} variant="punk" />
}

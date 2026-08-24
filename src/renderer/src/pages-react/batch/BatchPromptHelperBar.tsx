import { useMemo } from 'react'
import type { BatchRefImage } from '../../stores/useBatchStore'
import VisualPromptBar from '../../components/shared/image-editors/VisualPromptBar'
import type { ImageChoice } from '../../components/shared/image-editors/ImageEditorModal'

interface Props {
  refImages: BatchRefImage[]
  /** 注入 prompt 到当前模式的输入框 */
  onInject: (text: string) => void
  /** 提供后出现「图层分离」按钮;不传则该页不接这个动作。 */
  onLayerSplit?: (imageUrl: string) => void
  /** 已进入拆图状态(按钮显示为按下)。 */
  splitArmed?: boolean
}

/**
 * BatchPromptHelperBar — 批量生成页的视觉 prompt 辅助(薄壳)。
 * UI / 交互交给共享 VisualPromptBar,这里只负责把 BatchRefImage 映射为候选。
 */
export default function BatchPromptHelperBar({
  refImages,
  onInject,
  onLayerSplit,
  splitArmed,
}: Props) {
  const imageChoices = useMemo<ImageChoice[]>(
    () =>
      refImages.map((r, i) => ({
        url: r.base64,
        label: r.fileName || `REF-${i + 1}`,
      })),
    [refImages],
  )

  return (
    <VisualPromptBar
      imageChoices={imageChoices}
      onInject={onInject}
      variant="cyber"
      onLayerSplit={onLayerSplit}
      splitArmed={splitArmed}
    />
  )
}

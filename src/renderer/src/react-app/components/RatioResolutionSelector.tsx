import { useDirectorStore } from '../stores/useDirectorStore'
import { useCurrentModelConfig } from '../hooks/useCurrentModelConfig'
import { ImageParamControls } from './ImageParamControls'

/**
 * Director 页的「比例 / 分辨率 / 清晰度」三轴选择器。
 * 仅做 store 绑定 + 主题选择, 选项/能力/归位/markup 全部走共享的 ImageParamControls。
 */
export function RatioResolutionSelector() {
  const currentRatio = useDirectorStore((s) => s.currentRatio)
  const setRatio = useDirectorStore((s) => s.setRatio)
  const currentResolution = useDirectorStore((s) => s.currentResolution)
  const setResolution = useDirectorStore((s) => s.setResolution)
  const currentQuality = useDirectorStore((s) => s.currentQuality)
  const setQuality = useDirectorStore((s) => s.setQuality)
  const currentCount = useDirectorStore((s) => s.currentCount)
  const setCount = useDirectorStore((s) => s.setCount)

  const modelConfig = useCurrentModelConfig()

  return (
    <ImageParamControls
      variant="director"
      modelConfig={modelConfig}
      ratio={currentRatio}
      onRatioChange={setRatio}
      resolution={currentResolution}
      onResolutionChange={setResolution}
      quality={currentQuality}
      onQualityChange={setQuality}
      count={currentCount}
      onCountChange={setCount}
      preferRatio="16:9"
    />
  )
}

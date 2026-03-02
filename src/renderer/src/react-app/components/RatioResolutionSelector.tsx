import { useEffect, useMemo, useState } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'

interface RatioOption {
  key: string
  label?: string
  description?: string
}

interface ResolutionOption {
  key: string
  label?: string
  description?: string
}

interface GenerateModelConfig {
  name?: string
  ratios?: RatioOption[]
  resolutions?: ResolutionOption[]
  defaultResolution?: string
  capabilities?: {
    resolutionControl?: boolean
  }
}

const FALLBACK_RATIO_OPTIONS: RatioOption[] = [
  { key: 'auto', label: '自适应', description: '智能' },
  { key: '1:1', label: '方形 1:1', description: '常用' },
  { key: '16:9', label: '横版 16:9', description: '宽屏' },
  { key: '9:16', label: '竖版 9:16', description: '竖屏' },
  { key: '4:3', label: '横版 4:3', description: '标准' },
  { key: '3:4', label: '竖版 3:4', description: '标准' },
  { key: '3:2', label: '横版 3:2', description: '经典' },
  { key: '2:3', label: '竖版 2:3', description: '经典' },
  { key: '21:9', label: '影院 21:9', description: '超宽屏' },
  { key: '5:4', label: '横版 5:4', description: '传统' },
  { key: '4:5', label: '竖版 4:5', description: '社媒' },
]

const FALLBACK_RESOLUTION_OPTIONS: ResolutionOption[] = [
  { key: '2K', label: '2K 高清', description: '标准' },
  { key: '4K', label: '4K 超清', description: '细节' },
]

const selectClass =
  'w-full px-3 py-2 bg-white bg-opacity-90 border border-white border-opacity-30 rounded-none text-gray-800 font-medium focus:outline-none focus:ring-2 focus:ring-purple-400'

export function RatioResolutionSelector() {
  const currentRatio = useDirectorStore((s) => s.currentRatio)
  const setRatio = useDirectorStore((s) => s.setRatio)
  const currentResolution = useDirectorStore((s) => s.currentResolution)
  const setResolution = useDirectorStore((s) => s.setResolution)
  const [modelConfig, setModelConfig] = useState<GenerateModelConfig | null>(null)

  useEffect(() => {
    let active = true
    let lastModelName = ''

    const syncFromCurrentModel = () => {
      const api = (window as any).aiImageAPI
      const currentModel = api?.getCurrentModel?.() as GenerateModelConfig | undefined
      if (!active || !currentModel) return
      const name = currentModel.name || ''
      if (name !== lastModelName) {
        lastModelName = name
        setModelConfig(currentModel)
      }
    }

    syncFromCurrentModel()
    const timer = window.setInterval(syncFromCurrentModel, 800)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  const ratioOptions = useMemo(() => {
    return Array.isArray(modelConfig?.ratios) && modelConfig?.ratios.length
      ? modelConfig.ratios
      : FALLBACK_RATIO_OPTIONS
  }, [modelConfig])

  const supportsResolution = useMemo(() => {
    return Boolean(modelConfig?.capabilities?.resolutionControl && modelConfig?.resolutions?.length)
  }, [modelConfig])

  const resolutionOptions = useMemo(() => {
    if (supportsResolution) return modelConfig?.resolutions || FALLBACK_RESOLUTION_OPTIONS
    return FALLBACK_RESOLUTION_OPTIONS
  }, [modelConfig, supportsResolution])

  useEffect(() => {
    if (ratioOptions.some((opt) => opt.key === currentRatio)) return
    const preferred = ratioOptions.find((opt) => opt.key === '16:9')
    setRatio(preferred?.key || ratioOptions[0]?.key || '16:9')
  }, [currentRatio, ratioOptions, setRatio])

  useEffect(() => {
    if (!supportsResolution) return
    if (resolutionOptions.some((opt) => opt.key === currentResolution)) return
    const preferred = resolutionOptions.find((opt) => opt.key === (modelConfig?.defaultResolution || '2K'))
    setResolution(preferred?.key || resolutionOptions[0]?.key || '2K')
  }, [currentResolution, resolutionOptions, setResolution, modelConfig, supportsResolution])

  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="bg-[#27272A] rounded-none p-4">
        <h3 className="text-white font-semibold flex items-center mb-3">
          <i className="fas fa-crop-alt text-yellow-400 mr-2" />
          图片尺寸
        </h3>
        <select
          value={currentRatio}
          onChange={(e) => setRatio(e.target.value)}
          className={selectClass}
        >
          {ratioOptions.map((opt) => (
            <option key={opt.key} value={opt.key}>
              {opt.description ? `${opt.label || opt.key} ${opt.description}` : (opt.label || opt.key)}
            </option>
          ))}
        </select>
      </div>

      <div className={`bg-[#27272A] rounded-none p-4 ${supportsResolution ? '' : 'opacity-60'}`}>
        <h3 className="text-white font-semibold flex items-center mb-3">
          <i className="fas fa-expand-arrows-alt text-yellow-400 mr-2" />
          清晰度
        </h3>
        {supportsResolution ? (
          <select
            value={currentResolution}
            onChange={(e) => setResolution(e.target.value)}
            className={selectClass}
          >
            {resolutionOptions.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {opt.description ? `${opt.label || opt.key} ${opt.description}` : (opt.label || opt.key)}
              </option>
            ))}
          </select>
        ) : (
          <div className="w-full px-3 py-2 bg-white bg-opacity-10 border border-white border-opacity-20 text-white/70 text-sm">
            当前模型不支持清晰度切换（按模型默认）
          </div>
        )}
      </div>
    </div>
  )
}

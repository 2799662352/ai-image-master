import { useEffect, useState } from 'react'
import type { ImageParamModelConfig } from '../../services/api/imageParamControls'

/**
 * 统一获取「当前模型配置快照」。
 *
 * - 传入 modelKey 时: 跟随 modelKey 变化重新读取(Batch/Generate 用 currentModelKey)。
 * - 不传 modelKey 时: 每 800ms 轮询一次 getCurrentModel()(Director 用, 无 key 依赖)。
 *
 * 把对 window.aiImageAPI.getCurrentModel 的访问收口到一处。
 */
export function useCurrentModelConfig(modelKey?: string): ImageParamModelConfig | null {
  const [modelConfig, setModelConfig] = useState<ImageParamModelConfig | null>(null)

  useEffect(() => {
    const read = (): ImageParamModelConfig | undefined => {
      const api = (window as unknown as { aiImageAPI?: { getCurrentModel?: () => unknown } })
        .aiImageAPI
      return api?.getCurrentModel?.() as ImageParamModelConfig | undefined
    }

    if (modelKey !== undefined) {
      setModelConfig(read() || null)
      return
    }

    // 无 key: 轮询(模型切换由旧版 model-selector 触发, 无法订阅)
    let active = true
    let lastName = ''
    const sync = () => {
      const cfg = read()
      if (!active || !cfg) return
      const name = (cfg as { name?: string }).name || ''
      if (name !== lastName) {
        lastName = name
        setModelConfig(cfg)
      }
    }
    sync()
    const timer = window.setInterval(sync, 800)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [modelKey])

  return modelConfig
}

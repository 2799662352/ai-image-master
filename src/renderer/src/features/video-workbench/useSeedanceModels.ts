// 「当前站点能提交哪些 Seedance 档位」——工作台卡片的模型下拉数据源。
//
// 为什么不在渲染端直接枚举 `SEEDANCE_MODEL_CAPABILITIES` 的键:能力表描述的是
// 「这个档位的规格」,不是「这个站点现在能不能提交」。国内 2.5 就走过这条路
// (`SEEDANCE_CN_2_5_ENABLED`,2026-08-12 已开,`SEEDANCE_CN_25=0` 随时能关回去);
// 枚举能力表会摆出一个注定被上游拒的选项 —— 那比少摆一个更糟,用户点了才发现不能用。
//
// 站点切换(RegionSwitch / 设置页)经 `seedance:config-changed` 广播,这里跟着变,
// 与 RegionSwitch 是同一份主进程状态,不会漂移。

import { useEffect, useState } from 'react'
import type { SeedanceKeyState, SeedanceModelAlias } from '../../../../types/seedance'

/** preload 桥缺失 / 旧主进程没报 models 时的兜底:保守只给 2.0 家族。 */
export const FALLBACK_SEEDANCE_MODELS: readonly SeedanceModelAlias[] = ['2.0', '2.0-fast', '2.0-mini']

interface SeedanceConfigApi {
  getConfig?: () => Promise<SeedanceKeyState>
  onConfigChanged?: (cb: (state: SeedanceKeyState) => void) => () => void
}

function getSeedanceApi(): SeedanceConfigApi | undefined {
  return (window as Window & { electronAPI?: { seedance?: SeedanceConfigApi } }).electronAPI?.seedance
}

function pick(state: SeedanceKeyState | undefined): readonly SeedanceModelAlias[] | null {
  const list = state?.models
  return Array.isArray(list) && list.length > 0 ? list : null
}

export function useSeedanceModels(): readonly SeedanceModelAlias[] {
  const [models, setModels] = useState<readonly SeedanceModelAlias[]>(FALLBACK_SEEDANCE_MODELS)

  useEffect(() => {
    const api = getSeedanceApi()
    if (!api?.getConfig) return
    let mounted = true
    void api
      .getConfig()
      .then((state) => {
        const next = pick(state)
        if (mounted && next) setModels(next)
      })
      .catch(() => {
        // 拉取失败保持兜底档位,不把工作台卡成空下拉。
      })
    const unsub = api.onConfigChanged?.((state) => {
      const next = pick(state)
      if (mounted && next) setModels(next)
    })
    return () => {
      mounted = false
      unsub?.()
    }
  }, [])

  return models
}

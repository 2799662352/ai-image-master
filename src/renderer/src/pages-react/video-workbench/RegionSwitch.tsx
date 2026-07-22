// 「生成视频」工作台 —— Seedance 海外/国内站点切换胶囊。
//
// 与设置页 SeedanceSection 的站点切换共用同一份主进程配置
// (safeStorage 持久化,seedance:set-config 写入):这里选「海外」提交就走
// vvdance.ai(dreamina-*),选「国内」就走 vvdance.yongmuai.com(doubao-*)。
// 任一处改动经 `seedance:config-changed` 广播,两边即时对齐。

import { useEffect, useState } from 'react'
import type { SeedanceKeyState, SeedanceRegion } from '../../../../types/seedance'

interface SeedanceConfigApi {
  seedance?: {
    getConfig?: () => Promise<SeedanceKeyState>
    setConfig?: (config: { region?: SeedanceRegion }) => Promise<SeedanceKeyState>
    onConfigChanged?: (cb: (state: SeedanceKeyState) => void) => () => void
  }
}

function getSeedanceApi(): SeedanceConfigApi['seedance'] {
  return (window as Window & { electronAPI?: SeedanceConfigApi }).electronAPI?.seedance
}

const REGION_OPTIONS: Array<{ value: SeedanceRegion; label: string; hint: string }> = [
  { value: 'global', label: '海外', hint: 'vvdance.ai · dreamina-*' },
  { value: 'cn', label: '国内', hint: 'vvdance.yongmuai.com · doubao-*' },
]

export function RegionSwitch() {
  const [region, setRegion] = useState<SeedanceRegion | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const api = getSeedanceApi()
    if (!api?.getConfig) return
    let mounted = true
    void api.getConfig().then((state) => {
      if (mounted && state) setRegion(state.region ?? 'global')
    })
    const unsub = api.onConfigChanged?.((state) => {
      if (mounted && state) setRegion(state.region ?? 'global')
    })
    return () => {
      mounted = false
      unsub?.()
    }
  }, [])

  // preload 桥缺失(旧窗口/测试环境)时不渲染,不挡工作台其余功能
  if (region === null) return null

  const handleSwitch = async (next: SeedanceRegion) => {
    if (next === region || saving) return
    const api = getSeedanceApi()
    if (!api?.setConfig) return
    setSaving(true)
    try {
      const state = await api.setConfig({ region: next })
      if (state) setRegion(state.region ?? next)
    } catch (e) {
      console.warn('[VideoWorkbench] 站点切换失败:', e)
    } finally {
      setSaving(false)
    }
  }

  const active = REGION_OPTIONS.find((o) => o.value === region) ?? REGION_OPTIONS[0]

  return (
    <div className="flex items-center gap-2" title={`当前站点:${active.hint}`}>
      <span className="text-white/30 text-[10px] uppercase tracking-wider">站点</span>
      <div className="inline-flex border border-[#3F3F46] overflow-hidden" role="group" aria-label="Seedance 站点">
        {REGION_OPTIONS.map((o, i) => (
          <button
            key={o.value}
            type="button"
            disabled={saving}
            aria-pressed={region === o.value}
            className={[
              'text-xs px-2.5 py-1.5 transition-colors disabled:opacity-50',
              i > 0 ? 'border-l border-[#3F3F46]' : '',
              region === o.value
                ? 'bg-[#FCE300] text-black font-bold'
                : 'bg-[#18181B] text-white/60 hover:text-[#FCE300]',
            ].join(' ')}
            onClick={() => void handleSwitch(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

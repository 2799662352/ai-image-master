// RegionSwitch 单测:工作台站点切换与设置页共享同一份主进程 region 配置。
// 契约:mount 拉 getConfig;点按钮走 setConfig({ region });
// seedance:config-changed 广播(设置页改动)能把本组件对齐;桥缺失时不渲染。

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SeedanceKeyState } from '../../../../../types/seedance'
import { RegionSwitch } from '../RegionSwitch'

function makeState(region: 'global' | 'cn'): SeedanceKeyState {
  // 可用档位由主进程按站点算,渲染端只照抄。这里刻意让两站给出不同档位来验证
  // 「照抄」这件事 —— 国内 2.5 的灰度关掉时(`SEEDANCE_CN_25=0`)就是这个形状。
  return {
    hasKey: true,
    source: 'store',
    hasSecret: false,
    region,
    models: region === 'cn' ? ['2.0', '2.0-fast', '2.0-mini'] : ['2.5', '2.0', '2.0-fast', '2.0-mini'],
  }
}

function mockSeedanceApi(initial: 'global' | 'cn') {
  let configListener: ((state: SeedanceKeyState) => void) | null = null
  const getConfig = vi.fn(async () => makeState(initial))
  const setConfig = vi.fn(async (cfg: { region?: 'global' | 'cn' }) =>
    makeState(cfg.region ?? initial),
  )
  const onConfigChanged = vi.fn((cb: (state: SeedanceKeyState) => void) => {
    configListener = cb
    return () => {
      configListener = null
    }
  })
  ;(window as any).electronAPI = { seedance: { getConfig, setConfig, onConfigChanged } }
  return {
    getConfig,
    setConfig,
    emitConfigChanged: (state: SeedanceKeyState) => configListener?.(state),
  }
}

afterEach(() => {
  // vitest globals:false 下 RTL 不会自动 cleanup,手动卸载防跨用例 DOM 残留
  cleanup()
  delete (window as any).electronAPI
})

describe('RegionSwitch', () => {
  it('mount 拉取当前 region 并高亮对应按钮', async () => {
    mockSeedanceApi('cn')
    render(<RegionSwitch />)
    const cnBtn = await screen.findByRole('button', { name: '国内' })
    expect(cnBtn.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '海外' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('点击另一站点 → setConfig({ region }) 并切换高亮', async () => {
    const api = mockSeedanceApi('global')
    render(<RegionSwitch />)
    const cnBtn = await screen.findByRole('button', { name: '国内' })
    await act(async () => {
      cnBtn.click()
    })
    expect(api.setConfig).toHaveBeenCalledWith({ region: 'cn' })
    await waitFor(() => expect(cnBtn.getAttribute('aria-pressed')).toBe('true'))
  })

  it('点击当前站点不触发 setConfig', async () => {
    const api = mockSeedanceApi('global')
    render(<RegionSwitch />)
    const globalBtn = await screen.findByRole('button', { name: '海外' })
    await act(async () => {
      globalBtn.click()
    })
    expect(api.setConfig).not.toHaveBeenCalled()
  })

  it('设置页切站(config-changed 广播)→ 本组件同步高亮', async () => {
    const api = mockSeedanceApi('global')
    render(<RegionSwitch />)
    await screen.findByRole('button', { name: '海外' })
    act(() => {
      api.emitConfigChanged(makeState('cn'))
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '国内' }).getAttribute('aria-pressed')).toBe('true'),
    )
  })

  it('preload 桥缺失(旧窗口/纯 web)时不渲染', () => {
    delete (window as any).electronAPI
    const { container } = render(<RegionSwitch />)
    expect(container.firstChild).toBeNull()
  })
})

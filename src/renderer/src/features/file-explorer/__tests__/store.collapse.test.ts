/**
 * fxCollapsed — 工作区展示栏「收起但保持挂载」状态:
 *  - toggleFxCollapsed 翻转 + localStorage 持久化(FX_COLLAPSED_KEY 与
 *    FX_OPEN_KEY 同风格 '1'/'0');
 *  - 初始化从 localStorage 恢复;
 *  - 所有「自动打开面板」路径(openCanvasTab / openAiChange / setFxOpen(true)
 *    / toggleFx 开)必须同时解除收起,避免 agent 打开文件但面板收着看不见。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileChange } from '../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../store'

const FX_COLLAPSED_KEY = 'agent-chat:fx-collapsed'

function makeChange(): FileChange {
  return {
    path: 'D:/repo/src/foo.ts',
    operation: 'edit',
    diff: [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,1 @@',
      '-const b = 2',
      '+const b = 3',
    ].join('\n'),
    added: 1,
    removed: 1,
  }
}

beforeEach(() => {
  localStorage.clear()
  useFileExplorerStore.setState(useFileExplorerStore.getInitialState(), true)
})

describe('fxCollapsed 收起状态', () => {
  it('默认不收起,toggleFxCollapsed 翻转并持久化', () => {
    expect(useFileExplorerStore.getState().fxCollapsed).toBe(false)

    useFileExplorerStore.getState().toggleFxCollapsed()
    expect(useFileExplorerStore.getState().fxCollapsed).toBe(true)
    expect(localStorage.getItem(FX_COLLAPSED_KEY)).toBe('1')

    useFileExplorerStore.getState().toggleFxCollapsed()
    expect(useFileExplorerStore.getState().fxCollapsed).toBe(false)
    expect(localStorage.getItem(FX_COLLAPSED_KEY)).toBe('0')
  })

  it('初始化从 localStorage 恢复收起状态', async () => {
    localStorage.setItem(FX_COLLAPSED_KEY, '1')
    vi.resetModules()
    const mod = await import('../store')
    expect(mod.useFileExplorerStore.getState().fxCollapsed).toBe(true)
  })

  it('setFxOpen(true) 解除收起(revealPath 等复用该入口)', () => {
    useFileExplorerStore.setState({ fxOpen: false, fxCollapsed: true } as never)
    useFileExplorerStore.getState().setFxOpen(true)
    expect(useFileExplorerStore.getState().fxCollapsed).toBe(false)
    expect(localStorage.getItem(FX_COLLAPSED_KEY)).toBe('0')
  })

  it('setFxOpen(false) 不改收起标记(关闭语义保持不变)', () => {
    useFileExplorerStore.setState({ fxOpen: true, fxCollapsed: true } as never)
    useFileExplorerStore.getState().setFxOpen(false)
    expect(useFileExplorerStore.getState().fxCollapsed).toBe(true)
  })

  it('toggleFx 打开面板时解除收起', () => {
    useFileExplorerStore.setState({ fxOpen: false, fxCollapsed: true } as never)
    useFileExplorerStore.getState().toggleFx()
    expect(useFileExplorerStore.getState().fxOpen).toBe(true)
    expect(useFileExplorerStore.getState().fxCollapsed).toBe(false)
  })

  it('openCanvasTab 自动打开面板并解除收起(新建与重激活两条路径)', () => {
    useFileExplorerStore.setState({ fxOpen: false, fxCollapsed: true } as never)
    useFileExplorerStore.getState().openCanvasTab()
    expect(useFileExplorerStore.getState().fxOpen).toBe(true)
    expect(useFileExplorerStore.getState().fxCollapsed).toBe(false)

    // 再收起,重激活已有 canvas tab 也要解除收起
    useFileExplorerStore.getState().toggleFxCollapsed()
    expect(useFileExplorerStore.getState().fxCollapsed).toBe(true)
    useFileExplorerStore.getState().openCanvasTab()
    expect(useFileExplorerStore.getState().fxCollapsed).toBe(false)
    expect(localStorage.getItem(FX_COLLAPSED_KEY)).toBe('0')
  })

  it('openAiChange 自动打开面板并解除收起', async () => {
    useFileExplorerStore.setState({ fxOpen: false, fxCollapsed: true } as never)
    await useFileExplorerStore.getState().openAiChange(makeChange())
    expect(useFileExplorerStore.getState().fxOpen).toBe(true)
    expect(useFileExplorerStore.getState().fxCollapsed).toBe(false)
  })
})

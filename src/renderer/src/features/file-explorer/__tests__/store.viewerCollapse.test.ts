/**
 * fxViewerCollapsed — 「只收中间查看器」状态(保留左侧文件树):
 *  - toggleFxViewerCollapsed 翻转 + localStorage 持久化('1'/'0');
 *  - 初始化从 localStorage 恢复;
 *  - 「自动打开面板」路径(openCanvasTab / openAiChange / setFxOpen(true) /
 *    toggleFx 开)与用户点开文件(openTab)必须同时解除查看器收起,
 *    否则打开的内容不可见。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileChange } from '../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../store'

const FX_VIEWER_COLLAPSED_KEY = 'agent-chat:fx-viewer-collapsed'

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

describe('fxViewerCollapsed 只收查看器状态', () => {
  it('默认不收起,toggleFxViewerCollapsed 翻转并持久化', () => {
    expect(useFileExplorerStore.getState().fxViewerCollapsed).toBe(false)

    useFileExplorerStore.getState().toggleFxViewerCollapsed()
    expect(useFileExplorerStore.getState().fxViewerCollapsed).toBe(true)
    expect(localStorage.getItem(FX_VIEWER_COLLAPSED_KEY)).toBe('1')

    useFileExplorerStore.getState().toggleFxViewerCollapsed()
    expect(useFileExplorerStore.getState().fxViewerCollapsed).toBe(false)
    expect(localStorage.getItem(FX_VIEWER_COLLAPSED_KEY)).toBe('0')
  })

  it('初始化从 localStorage 恢复', async () => {
    localStorage.setItem(FX_VIEWER_COLLAPSED_KEY, '1')
    vi.resetModules()
    const mod = await import('../store')
    expect(mod.useFileExplorerStore.getState().fxViewerCollapsed).toBe(true)
  })

  it('setFxOpen(true) 解除查看器收起', () => {
    useFileExplorerStore.setState({ fxOpen: false, fxViewerCollapsed: true } as never)
    useFileExplorerStore.getState().setFxOpen(true)
    expect(useFileExplorerStore.getState().fxViewerCollapsed).toBe(false)
    expect(localStorage.getItem(FX_VIEWER_COLLAPSED_KEY)).toBe('0')
  })

  it('toggleFx 打开面板时解除查看器收起', () => {
    useFileExplorerStore.setState({ fxOpen: false, fxViewerCollapsed: true } as never)
    useFileExplorerStore.getState().toggleFx()
    expect(useFileExplorerStore.getState().fxOpen).toBe(true)
    expect(useFileExplorerStore.getState().fxViewerCollapsed).toBe(false)
  })

  it('openCanvasTab 解除查看器收起(新建与重激活两条路径)', () => {
    useFileExplorerStore.setState({ fxOpen: true, fxViewerCollapsed: true } as never)
    useFileExplorerStore.getState().openCanvasTab()
    expect(useFileExplorerStore.getState().fxViewerCollapsed).toBe(false)

    useFileExplorerStore.getState().toggleFxViewerCollapsed()
    expect(useFileExplorerStore.getState().fxViewerCollapsed).toBe(true)
    useFileExplorerStore.getState().openCanvasTab()
    expect(useFileExplorerStore.getState().fxViewerCollapsed).toBe(false)
    expect(localStorage.getItem(FX_VIEWER_COLLAPSED_KEY)).toBe('0')
  })

  it('openAiChange 解除查看器收起', async () => {
    useFileExplorerStore.setState({ fxOpen: false, fxViewerCollapsed: true } as never)
    await useFileExplorerStore.getState().openAiChange(makeChange())
    expect(useFileExplorerStore.getState().fxViewerCollapsed).toBe(false)
  })

  it('openTab 打开文件解除查看器收起(已有 tab 重激活路径)', async () => {
    useFileExplorerStore.setState({
      fxOpen: true,
      fxViewerCollapsed: true,
      tabs: [
        {
          id: 't1',
          path: 'D:/a.txt',
          name: 'a.txt',
          source: 'workspace',
          kind: 'text',
          state: null,
          diskContent: '',
          diskMtime: 0,
          dirty: false,
        },
      ],
      activeTabId: null,
    } as never)
    await useFileExplorerStore.getState().openTab('D:/a.txt', 'workspace')
    expect(useFileExplorerStore.getState().fxViewerCollapsed).toBe(false)
    expect(localStorage.getItem(FX_VIEWER_COLLAPSED_KEY)).toBe('0')
  })

  it('fxCollapsed(整栏收起)与 fxViewerCollapsed 互不影响', () => {
    useFileExplorerStore.getState().toggleFxViewerCollapsed()
    useFileExplorerStore.getState().toggleFxCollapsed()
    expect(useFileExplorerStore.getState().fxViewerCollapsed).toBe(true)
    expect(useFileExplorerStore.getState().fxCollapsed).toBe(true)
    useFileExplorerStore.getState().toggleFxCollapsed()
    expect(useFileExplorerStore.getState().fxViewerCollapsed).toBe(true)
  })
})

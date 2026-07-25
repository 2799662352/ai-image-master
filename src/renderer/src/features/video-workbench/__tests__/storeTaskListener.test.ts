// 任务回流监听的挂载生命周期单测。
//
// 背景(这组测试防的回归):工作台页被 AppLayout 的 `<Activity mode="hidden">`
// 托管,React 在 hidden 时会销毁 effect —— 页面 effect 的 cleanup 一执行就退订
// 了 seedance:task-update。而全局 SeedanceTaskListener 对 source==='workbench'
// 直接 return,没有兜底消费者,于是切走标签页期间完成的任务广播全部落地无人,
// 卡片永久停在「渲染中」且不写历史。
//
// 修法:mountWorkbenchTaskListener 改为引用计数 —— AppLayout 挂一份常驻,页面
// 再挂一份;页面被隐藏只把计数减到 1,底层订阅不断。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SeedanceTaskUpdate } from '../../../../types/seedance'
import { ServiceRegistry } from '../../../services/ServiceBridge'
import { mountWorkbenchTaskListener, resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../store'
import { resetWorkbenchDbForTest } from '../WorkbenchDb'

function mockBridge() {
  const unsubscribe = vi.fn()
  let handler: ((u: SeedanceTaskUpdate) => void) | null = null
  const onTaskUpdate = vi.fn((cb: (u: SeedanceTaskUpdate) => void) => {
    handler = cb
    return unsubscribe
  })
  ;(window as any).electronAPI = {
    seedance: { onTaskUpdate },
    videoWorkbench: { submit: vi.fn(async () => ({ success: true, taskId: 'task-1' })) },
  }
  return {
    onTaskUpdate,
    unsubscribe,
    emit: (patch: Partial<SeedanceTaskUpdate>) =>
      handler?.({
        taskId: 'task-1',
        prompt: 'p',
        model: '2.0',
        resolution: '720p',
        ratio: '16:9',
        duration: 5,
        status: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        source: 'workbench',
        ...patch,
      } as SeedanceTaskUpdate),
  }
}

async function submitOneCard(): Promise<string> {
  useVideoWorkbenchStore.getState().addCards([{ prompt: '一只赛博猫在雨夜奔跑' }])
  await useVideoWorkbenchStore.getState().startCards()
  return useVideoWorkbenchStore.getState().cards[0].clientId!
}

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  ServiceRegistry.clear()
  delete (window as any).electronAPI
})

describe('mountWorkbenchTaskListener 引用计数', () => {
  it('多处挂载只向 preload 订阅一次', () => {
    const { onTaskUpdate } = mockBridge()
    mountWorkbenchTaskListener()
    mountWorkbenchTaskListener()
    expect(onTaskUpdate).toHaveBeenCalledTimes(1)
  })

  it('页面被 Activity 隐藏(卸载其中一处)后,广播仍能到达卡片', async () => {
    const bridge = mockBridge()
    const unmountApp = mountWorkbenchTaskListener()
    const unmountPage = mountWorkbenchTaskListener()
    const clientId = await submitOneCard()

    // 标签页切走 → 页面 effect cleanup
    unmountPage()
    expect(bridge.unsubscribe).not.toHaveBeenCalled()

    bridge.emit({ clientId, status: 'succeeded', persistence: 'running' })
    expect(useVideoWorkbenchStore.getState().cards[0].status).toBe('succeeded')

    unmountApp()
    expect(bridge.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('同一个卸载句柄重复调用只减一次计数', () => {
    const bridge = mockBridge()
    const unmountApp = mountWorkbenchTaskListener()
    const unmountPage = mountWorkbenchTaskListener()

    unmountPage()
    unmountPage()
    unmountPage()
    expect(bridge.unsubscribe).not.toHaveBeenCalled()

    unmountApp()
    expect(bridge.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('全部卸载后再次挂载会重新订阅', () => {
    const bridge = mockBridge()
    mountWorkbenchTaskListener()()
    expect(bridge.unsubscribe).toHaveBeenCalledTimes(1)

    mountWorkbenchTaskListener()
    expect(bridge.onTaskUpdate).toHaveBeenCalledTimes(2)
  })

  it('preload 桥缺失时返回无害 noop', () => {
    expect(() => mountWorkbenchTaskListener()()).not.toThrow()
  })
})

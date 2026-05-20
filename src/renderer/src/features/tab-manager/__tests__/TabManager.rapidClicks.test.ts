/**
 * 回归测试:v4.3.9 闪屏修复
 *
 * 用户快速连续点击不同 tab 时,旧实现:
 *   - onTabChange 回调在两层 RAF 后才触发(stale 闭包)
 *   - ServiceBridge 双向同步把 stale newTab 反推回 useTabStore
 *   - useTabStore.subscribe 又把 stale tab 喂回 tabManager
 *   - 结果:用户看到 ~16ms 的旧页面内容闪现
 *
 * 修复后:
 *   - onTabChange 同步触发,与 updateTabUI 在同一个 task 内
 *   - generation counter 取消 stale RAF,activate/deactivate 只对最终 tab 跑
 *   - reentrancyGuard 杜绝双向同步形成回环
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createTabManager, type TabManager } from '../TabManager'

describe('TabManager rapid clicks (v4.3.9 flicker fix)', () => {
  let manager: TabManager
  let rafCallbacks: Array<() => void> = []
  let rafIdCounter = 0
  let originalRAF: typeof globalThis.requestAnimationFrame
  let originalCAF: typeof globalThis.cancelAnimationFrame

  beforeEach(() => {
    // mock 出 #xxxPanel 元素,switchTab 会检查存在性
    document.body.innerHTML = `
      <button class="tab-btn" data-tab="generate"></button>
      <button class="tab-btn" data-tab="batch"></button>
      <button class="tab-btn" data-tab="agentWorkspace"></button>
      <div id="generatePanel" class="tab-panel"></div>
      <div id="batchPanel" class="tab-panel hidden"></div>
      <div id="agentWorkspacePanel" class="tab-panel hidden"></div>
    `

    // 手动控制 RAF,模拟"用户在 RAF 触发前又点了一次"
    rafCallbacks = []
    rafIdCounter = 0
    originalRAF = globalThis.requestAnimationFrame
    originalCAF = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = ((cb: () => void) => {
      rafIdCounter += 1
      const id = rafIdCounter
      rafCallbacks.push(() => {
        // 模拟"如果还没被取消才跑"
        if ((rafCallbacks as any).__cancelled?.has(id)) return
        cb()
      })
      return id
    }) as any
    globalThis.cancelAnimationFrame = ((id: number) => {
      const set = ((rafCallbacks as any).__cancelled ??= new Set<number>())
      set.add(id)
    }) as any

    manager = createTabManager({ defaultTab: 'generate' })
  })

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRAF
    globalThis.cancelAnimationFrame = originalCAF
  })

  function flushRAF(): void {
    const queue = rafCallbacks.slice()
    rafCallbacks.length = 0
    for (const cb of queue) cb()
  }

  test('快速点击 batch → agentWorkspace:中间态不残留,UI 直接落在最终 tab', () => {
    manager.switchTab('batch', false)
    // 用户 10ms 后又点了 agentWorkspace,RAF 还没跑
    manager.switchTab('agentWorkspace', false)

    // updateTabUI 是同步的,DOM 应该已经是 agentWorkspace 状态
    expect(document.querySelector('.tab-btn.active')?.getAttribute('data-tab')).toBe('agentWorkspace')
    expect(document.getElementById('batchPanel')?.classList.contains('hidden')).toBe(true)
    expect(document.getElementById('agentWorkspacePanel')?.classList.contains('hidden')).toBe(false)
  })

  test('onTabChange 同步触发,且每次 switchTab 都收到对应的 newTab(无 stale)', () => {
    const calls: Array<{ newTab: string; oldTab: string }> = []
    manager.onTabChange((newTab, oldTab) => calls.push({ newTab, oldTab }))

    manager.switchTab('batch', false)
    manager.switchTab('agentWorkspace', false)

    // 必须同步收到 2 次回调,且 newTab 与调用顺序一致
    expect(calls).toEqual([
      { newTab: 'batch', oldTab: 'generate' },
      { newTab: 'agentWorkspace', oldTab: 'batch' },
    ])
  })

  test('stale RAF 被取消:activatePage 只对最终 tab 跑一次', () => {
    const activated: string[] = []
    manager.setPages({
      batch: { onActivate: () => activated.push('batch') },
      agentWorkspace: { onActivate: () => activated.push('agentWorkspace') },
    })

    manager.switchTab('batch', false)
    manager.switchTab('agentWorkspace', false)

    // 把两次 switchTab 排队的 RAF 都跑完
    flushRAF() // 第一层 RAF (deactivate)
    flushRAF() // 第二层 RAF (activate)

    expect(activated).toEqual(['agentWorkspace'])
  })

  test('reentrancyGuard:onTabChange 回调里再调 switchTab 不会无限循环', () => {
    const calls: string[] = []
    manager.onTabChange((newTab) => {
      calls.push(newTab)
      // 模拟 ServiceBridge 的双向同步:回调里又触发了 switchTab
      // 旧实现这里会导致 stale 反推;新实现会被 reentrancyGuard 吞掉
      if (calls.length < 5) {
        manager.switchTab(newTab === 'batch' ? 'generate' : 'batch', false)
      }
    })

    manager.switchTab('batch', false)

    // 只应该有一次回调,不会因为重入产生级联
    expect(calls).toEqual(['batch'])
    expect(manager.getCurrentTab()).toBe('batch')
  })

  test('相同 tab 重复 switchTab 是 no-op,不触发回调', () => {
    const cb = vi.fn()
    manager.onTabChange(cb)

    manager.switchTab('batch', false)
    manager.switchTab('batch', false) // 第二次应该 bail
    manager.switchTab('batch', false) // 第三次也 bail

    expect(cb).toHaveBeenCalledTimes(1)
  })
})

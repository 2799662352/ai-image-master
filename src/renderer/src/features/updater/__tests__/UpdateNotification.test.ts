import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createUpdateNotification } from '../UpdateNotification'

describe('UpdateNotification updater event compatibility', () => {
  const listeners = new Map<string, (...args: any[]) => void>()

  beforeEach(() => {
    listeners.clear()
    document.body.innerHTML = ''
    ;(window as any).electronAPI = {
      on: vi.fn((channel: string, callback: (...args: any[]) => void) => {
        listeners.set(channel, callback)
      })
    }
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as any).electronAPI
  })

  it('does not crash when update-error callback receives single payload arg', () => {
    const notification = createUpdateNotification()
    notification.init()

    const onError = listeners.get('updater:update-error')
    expect(onError).toBeTypeOf('function')

    expect(() => {
      onError?.({ message: 'network failed' })
    }).not.toThrow()

    const title = document.querySelector('.update-title')?.textContent
    expect(title).toContain('更新失败')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { ToolRouter } from '../ToolRouter'

describe('ToolRouter', () => {
  it('runs main handlers before renderer fallback', async () => {
    const win = { webContents: { send: vi.fn() } } as any
    const router = new ToolRouter(win)
    router.registerMain('ping', async () => ({ ok: true }))
    await expect(router.call('ping', {})).resolves.toEqual({ ok: true })
    expect(win.webContents.send).not.toHaveBeenCalled()
  })
})

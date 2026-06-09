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

  it('reverse-maps the codex thread id to a db thread id on the renderer request', () => {
    const send = vi.fn()
    const win = { webContents: { send } } as any
    const router = new ToolRouter(win)
    router.setThreadIdResolver((codexId) => (codexId === 'codex-uuid-1' ? 'db-thread-1' : undefined))

    void router.call('generate_image', { prompt: 'a cat' }, 'codex-uuid-1')

    expect(send).toHaveBeenCalledTimes(1)
    const [, request] = send.mock.calls[0]
    expect(request.toolName).toBe('generate_image')
    expect(request.threadId).toBe('db-thread-1')
  })

  it('omits threadId when the codex id cannot be mapped (renderer falls back)', () => {
    const send = vi.fn()
    const win = { webContents: { send } } as any
    const router = new ToolRouter(win)
    router.setThreadIdResolver(() => undefined)

    void router.call('generate_image', { prompt: 'a cat' }, 'unknown-codex-id')

    const [, request] = send.mock.calls[0]
    expect(request.threadId).toBeUndefined()
  })
})

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

  describe('renderer tool timeouts', () => {
    it('a regular renderer tool still times out at the ~33-min ceiling', async () => {
      vi.useFakeTimers()
      try {
        const win = { webContents: { send: vi.fn() } } as any
        const router = new ToolRouter(win)
        const call = router.call('generate_image', { prompt: 'x' })
        call.catch(() => {}) // avoid an unhandled rejection between ticks

        vi.advanceTimersByTime(2_000_000 + 1)

        await expect(call).rejects.toThrow('Renderer tool timed out: generate_image')
      } finally {
        vi.useRealTimers()
      }
    })

    it('ask_user survives the regular ceiling and only times out after 6 hours', async () => {
      vi.useFakeTimers()
      try {
        const send = vi.fn()
        const win = { webContents: { send } } as any
        const router = new ToolRouter(win)
        const call = router.call('ask_user', { question: 'q' })
        const settled = vi.fn()
        call.catch(settled)

        // Past the regular renderer ceiling: the human may still be away.
        vi.advanceTimersByTime(2_000_000 + 1)
        await Promise.resolve()
        expect(settled).not.toHaveBeenCalled()

        // A late click still resolves the pending call.
        const [, request] = send.mock.calls[0]
        router.handleRendererResponse({ id: request.id, ok: true, result: { answered: true } })
        await expect(call).resolves.toEqual({ answered: true })
      } finally {
        vi.useRealTimers()
      }
    })

    it('ask_user rejects once the 6-hour window elapses', async () => {
      vi.useFakeTimers()
      try {
        const win = { webContents: { send: vi.fn() } } as any
        const router = new ToolRouter(win)
        const call = router.call('ask_user', { question: 'q' })
        call.catch(() => {}) // avoid an unhandled rejection between ticks

        vi.advanceTimersByTime(21_600_000 + 1)

        await expect(call).rejects.toThrow('Renderer tool timed out: ask_user')
      } finally {
        vi.useRealTimers()
      }
    })
  })
})

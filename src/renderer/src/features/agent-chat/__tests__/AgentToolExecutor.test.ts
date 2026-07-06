import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentToolExecutor } from '../AgentToolExecutor'
import { ServiceRegistry, SERVICE_KEYS } from '../../../services/ServiceBridge'

describe('AgentToolExecutor', () => {
  it('constructs without side effects', () => {
    expect(new AgentToolExecutor()).toBeInstanceOf(AgentToolExecutor)
  })
})

/**
 * open_image_viewer 回归:agent 常传 LOCAL 路径(director_capture /
 * generate_image 落盘在 %APPDATA%),沙箱 renderer 的 <img src> 加载不了裸
 * OS 路径 —— 必须先经 attachments IPC 转 blob: 再交给 ImageViewer
 * (线上表现:Lightbox 只显示 alt「查看图片」占位)。
 */
describe('open_image_viewer local-path resolution', () => {
  const readThumb = vi.fn()
  const viewerOpen = vi.fn()

  beforeEach(() => {
    readThumb.mockReset()
    viewerOpen.mockReset()
    ;(globalThis as unknown as { electronAPI?: unknown }).electronAPI = {
      attachments: { readThumb },
    }
    let n = 0
    ;(globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL =
      () => `blob:viewer-${++n}`
    ;(globalThis.URL as unknown as { revokeObjectURL: (s: string) => void }).revokeObjectURL =
      () => {}
    ServiceRegistry.register(SERVICE_KEYS.IMAGE_VIEWER, { open: viewerOpen })
  })

  afterEach(() => {
    delete (globalThis as unknown as { electronAPI?: unknown }).electronAPI
    ServiceRegistry.clear()
  })

  function callOpen(params: Record<string, unknown>): Promise<unknown> {
    const exec = new AgentToolExecutor() as unknown as {
      openImageViewer: (p: Record<string, unknown>) => Promise<unknown>
    }
    return exec.openImageViewer(params)
  }

  it('converts Windows paths to blob: URLs before opening the viewer', async () => {
    readThumb.mockResolvedValue({
      ok: true,
      base64: Buffer.from('png').toString('base64'),
      mime: 'image/png',
    })
    const res = await callOpen({
      urls: ['C:\\Users\\me\\AppData\\Roaming\\catimation\\shot.png'],
    })
    expect(res).toEqual({ opened: true, count: 1 })
    expect(viewerOpen).toHaveBeenCalledTimes(1)
    const [urls] = viewerOpen.mock.calls[0]
    expect(urls).toHaveLength(1)
    expect(urls[0]).toMatch(/^blob:/)
  })

  it('passes web URLs through untouched', async () => {
    const res = await callOpen({ urls: ['https://cdn.example.com/a.png'] })
    expect(res).toEqual({ opened: true, count: 1 })
    expect(viewerOpen).toHaveBeenCalledWith(['https://cdn.example.com/a.png'], 0)
    expect(readThumb).not.toHaveBeenCalled()
  })

  it('skips unloadable files and reports skipped count', async () => {
    readThumb
      .mockResolvedValueOnce({ ok: false, reason: 'file not found' })
      .mockResolvedValueOnce({
        ok: true,
        base64: Buffer.from('png').toString('base64'),
        mime: 'image/png',
      })
    const res = await callOpen({
      urls: ['C:\\gone\\missing.png', 'C:\\ok\\shot.png'],
      startIndex: 1,
    })
    expect(res).toEqual({ opened: true, count: 1, skipped: 1 })
    // startIndex clamps into the surviving list.
    expect(viewerOpen).toHaveBeenCalledWith([expect.stringMatching(/^blob:/)], 0)
  })

  it('throws when nothing is displayable so the agent sees a real error', async () => {
    readThumb.mockResolvedValue({ ok: false, reason: 'file not found' })
    await expect(callOpen({ urls: ['C:\\gone\\missing.png'] })).rejects.toThrow(
      /none of the provided URLs/,
    )
    expect(viewerOpen).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * cinematography-kb-mcp key reuse (catimation-style runtime injection).
 *
 * The app mirrors the 设置 → 运镜知识库 DASHSCOPE key (stored in
 * `localStorage[dashscope_api_key]`) to the MAIN process via
 * `setProviderApiKey('cinematography-kb', key)`. The main process keeps an
 * in-memory copy and injects it at codex spawn via
 * `-c mcp_servers.cinematography_kb.env.DASHSCOPE_API_KEY` — the secret is NEVER
 * written to config.toml. Mirrors the apiyi-mcp bridge exactly.
 */
describe('ApiService.syncCinematographyKbKeyToMcp', () => {
  let setProviderApiKey: ReturnType<typeof vi.fn>

  const flush = () => new Promise((r) => setTimeout(r, 0))

  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    setProviderApiKey = vi.fn(async () => ({ ok: true }))
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
      agent: { setProviderApiKey },
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  async function makeService() {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    await flush()
    setProviderApiKey.mockClear()
    return service
  }

  it('pushes the stored DASHSCOPE key to the main process under the cinematography-kb slot', async () => {
    localStorage.setItem('dashscope_api_key', 'sk-dashscope')
    const service = await makeService()

    service.syncCinematographyKbKeyToMcp()

    expect(setProviderApiKey).toHaveBeenCalledWith('cinematography-kb', 'sk-dashscope')
  })

  it('trims whitespace around the stored key', async () => {
    localStorage.setItem('dashscope_api_key', '  sk-padded  ')
    const service = await makeService()

    service.syncCinematographyKbKeyToMcp()

    expect(setProviderApiKey).toHaveBeenCalledWith('cinematography-kb', 'sk-padded')
  })

  it('pushes an empty string when unset so clearing the key propagates', async () => {
    const service = await makeService()

    service.syncCinematographyKbKeyToMcp()

    expect(setProviderApiKey).toHaveBeenCalledWith('cinematography-kb', '')
  })

  it('no-ops gracefully when the agent bridge is unavailable', async () => {
    localStorage.setItem('dashscope_api_key', 'sk-dashscope')
    const service = await makeService()
    delete (window as unknown as { electronAPI?: unknown }).electronAPI

    expect(() => service.syncCinematographyKbKeyToMcp()).not.toThrow()
  })
})

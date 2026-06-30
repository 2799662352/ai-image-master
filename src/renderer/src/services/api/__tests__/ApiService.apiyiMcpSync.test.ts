import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * apiyi-mcp key reuse (catimation-style runtime injection).
 *
 * The app mirrors whichever apiyi-family key the user already saved in 设置
 * (`api_key_apiyi` / `api_key_b-apiyi`, or the 图像理解 fallbacks) to the MAIN
 * process via `setProviderApiKey('apiyi-mcp', key)`. The main process keeps an
 * in-memory copy and injects it at codex spawn via
 * `-c mcp_servers.apiyi.env.APIYI_API_KEY` — the secret is NEVER written to
 * config.toml, so the MCP JSON editor stays key-less. The renderer therefore
 * does NOT touch config and does NOT pin the model (the seed owns the model so
 * a user can hand-switch to a thinking model in the editor).
 *
 * Push happens ONLY when a key is actually stored in 设置; with no key we no-op
 * (a user managing the key by hand in the editor is left untouched).
 */
describe('ApiService.syncApiyiKeyToMcp', () => {
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
    // Let the construction-time microtask sync settle, then clear so each test
    // only asserts on its own explicit call.
    await flush()
    setProviderApiKey.mockClear()
    return service
  }

  it('pushes the official apiyi key to the main process under the apiyi-mcp slot', async () => {
    localStorage.setItem('api_key_apiyi', 'sk-official')
    const service = await makeService()

    service.syncApiyiKeyToMcp()

    expect(setProviderApiKey).toHaveBeenCalledWith('apiyi-mcp', 'sk-official')
  })

  it('prefers the official apiyi slot over b-apiyi', async () => {
    localStorage.setItem('api_key_apiyi', 'sk-official')
    localStorage.setItem('api_key_b-apiyi', 'sk-bstation')
    const service = await makeService()

    service.syncApiyiKeyToMcp()

    expect(setProviderApiKey).toHaveBeenCalledWith('apiyi-mcp', 'sk-official')
  })

  it('falls back to b-apiyi then the 图像理解 keys', async () => {
    localStorage.setItem('vision_api_key_b-apiyi', 'sk-vision')
    const service = await makeService()

    service.syncApiyiKeyToMcp()

    expect(setProviderApiKey).toHaveBeenCalledWith('apiyi-mcp', 'sk-vision')
  })

  it('no-ops when no apiyi-family key is configured (hand-edited config left alone)', async () => {
    const service = await makeService()

    service.syncApiyiKeyToMcp()

    expect(setProviderApiKey).not.toHaveBeenCalled()
  })

  it('no-ops gracefully when the agent bridge is unavailable', async () => {
    localStorage.setItem('api_key_apiyi', 'sk-official')
    const service = await makeService()
    delete (window as unknown as { electronAPI?: unknown }).electronAPI

    expect(() => service.syncApiyiKeyToMcp()).not.toThrow()
  })

  it('saving the API key on an apiyi site triggers the push', async () => {
    const service = await makeService()
    // default current site is b-apiyi

    service.saveApiKey('sk-just-saved')
    await flush()

    expect(setProviderApiKey).toHaveBeenCalledWith('apiyi-mcp', 'sk-just-saved')
  })
})

// 后端直通 RPC 门面：19 个方法原先在 AgentManager 里逐字重复同一段 try/catch。
// 这里钉住那段信封的三条性质（缺方法的报错文案、data 的省略、错误的字符串化），
// 以及门面必须**惰性**取 backend —— 直接捕获实例会在将来 backend 被替换后失效。

import { describe, it, expect, vi } from 'vitest'
import { createBackendRpcFacade } from '../backendRpcFacade'
import type { IAgentBackend } from '../types'

function facadeWith(backend: Partial<IAgentBackend>) {
  return createBackendRpcFacade(() => backend as IAgentBackend)
}

describe('backendRpcFacade 信封', () => {
  it('成功时包 { ok: true, data }', async () => {
    const rpc = facadeWith({ listPlugins: vi.fn(async () => ({ marketplaces: [] }) as never) })
    await expect(rpc.listPlugins()).resolves.toEqual({ ok: true, data: { marketplaces: [] } })
  })

  it('后端不支持该方法时报 “X API unavailable”,不抛异常', async () => {
    const rpc = facadeWith({})
    await expect(rpc.listPlugins()).resolves.toEqual({
      ok: false,
      error: 'Plugin list API unavailable',
    })
  })

  it('后端抛错时如实带上消息', async () => {
    const rpc = facadeWith({
      listPlugins: vi.fn(async () => { throw new Error('boom') }) as never,
    })
    await expect(rpc.listPlugins()).resolves.toEqual({ ok: false, error: 'boom' })
  })

  it('非 Error 的抛出物也字符串化,不产生 undefined 文案', async () => {
    const rpc = facadeWith({
      listPlugins: vi.fn(async () => { throw 'plain string' }) as never,
    })
    await expect(rpc.listPlugins()).resolves.toEqual({ ok: false, error: 'plain string' })
  })

  it('无返回值的方法不带 data 键（保持原有形状,别给消费方塞 data: undefined）', async () => {
    const uninstallPlugin = vi.fn(async () => {})
    const rpc = facadeWith({ uninstallPlugin: uninstallPlugin as never })
    const res = await rpc.uninstallPlugin('p1')

    expect(res).toEqual({ ok: true })
    expect(Object.hasOwn(res, 'data')).toBe(false)
    expect(uninstallPlugin).toHaveBeenCalledWith('p1')
  })

  it('参数原样透传给后端', async () => {
    const installPlugin = vi.fn(async () => ({ installed: true }) as never)
    const rpc = facadeWith({ installPlugin })
    await rpc.installPlugin({ pluginId: 'x' } as never)

    expect(installPlugin).toHaveBeenCalledWith({ pluginId: 'x' })
  })

  it('惰性取 backend：门面创建后换掉 backend 仍打到新的那个', async () => {
    let backend: Partial<IAgentBackend> = {}
    const rpc = createBackendRpcFacade(() => backend as IAgentBackend)

    await expect(rpc.listPlugins()).resolves.toMatchObject({ ok: false })

    backend = { listPlugins: vi.fn(async () => ({ marketplaces: ['later'] }) as never) }
    await expect(rpc.listPlugins()).resolves.toEqual({
      ok: true,
      data: { marketplaces: ['later'] },
    })
  })
})

describe('backendRpcFacade 形状变体', () => {
  it('readConfig 用 config 键而不是 data（沿用原有契约）', async () => {
    const rpc = facadeWith({ readConfig: vi.fn(async () => ({ config: { a: 1 } }) as never) })
    await expect(rpc.readConfig()).resolves.toEqual({ ok: true, config: { a: 1 } })
  })

  it('mcpOAuthLogin 用 authorization_url 键', async () => {
    const rpc = facadeWith({
      mcpOAuthLogin: vi.fn(async () => ({ authorization_url: 'https://auth' }) as never),
    })
    await expect(rpc.mcpOAuthLogin('srv')).resolves.toEqual({
      ok: true,
      authorization_url: 'https://auth',
    })
  })

  it('每个方法的 unavailable 文案沿用原文,不被统一改写', async () => {
    const rpc = facadeWith({})
    const cases: Array<[Promise<{ error?: string }>, string]> = [
      [rpc.listMcpServers(), 'MCP list API unavailable'],
      [rpc.batchWriteConfig([]), 'MCP batch write API unavailable'],
      [rpc.writeConfigValue('k', 1), 'MCP write value API unavailable'],
      [rpc.readConfig(), 'MCP read config API unavailable'],
      [rpc.reloadMcpServers(), 'MCP reload API unavailable'],
      [rpc.mcpOAuthLogin('s'), 'MCP OAuth API unavailable'],
      [rpc.listInstalledPlugins(), 'Installed plugins API unavailable'],
      [rpc.readPlugin({} as never), 'Plugin read API unavailable'],
      [rpc.installPlugin({} as never), 'Plugin install API unavailable'],
      [rpc.uninstallPlugin('p'), 'Plugin uninstall API unavailable'],
      [rpc.listApps(), 'Apps list API unavailable'],
    ]
    for (const [promise, expected] of cases) {
      await expect(promise).resolves.toMatchObject({ ok: false, error: expected })
    }
  })
})

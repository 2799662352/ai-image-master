import { beforeEach, describe, expect, it } from 'vitest'

/**
 * 内置配置不许再指回 Miau 的源站 IP。
 *
 * 2026-07-28 把 Miau 网关从 `http://175.178.198.17:3000` 换成加速域名
 * `https://miauapi.13797248455.xyz`(实测同一实例:401 报文形状一致;明文 http
 * 不可达,只有 https 通)。
 *
 * 之所以要一道闸而不是靠记性:换域名的同时,主进程 CSP 里那几条
 * `http://175.178.198.17:*` 例外已经撤掉了(新地址落在通配的 `https:` 里)。
 * 所以将来谁再把某个模型指回那个明文 IP,症状**不是变慢,而是被 CSP 直接拦掉** ——
 * 表现为出图无声失败,而不是一条能读懂的网络错误。
 *
 * 上一次同类事故:v4.4.10 把 codex/grok 移出被封的 right.codes,两天后新加的
 * Claude 通道又指了回去,v4.4.13 才再修一次。只有读配置的检查能拦住这种回潮。
 */

const RAW_MIAU_HOST = '175.178.198.17'

describe('Miau 网关地址', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('内置站点与内置模型都不再指向源站 IP', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()

    const offenders: string[] = []
    for (const [key, site] of Object.entries(service.getAllSites())) {
      if (site.baseURL.includes(RAW_MIAU_HOST)) offenders.push(`site ${key} → ${site.baseURL}`)
    }
    for (const [key, model] of Object.entries(service.getAllModels())) {
      for (const field of ['baseURL', 'editURL'] as const) {
        const url = model[field]
        if (typeof url === 'string' && url.includes(RAW_MIAU_HOST)) {
          offenders.push(`model ${key}.${field} → ${url}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  it('Miau 站点走 https —— 明文 http 既连不上,也会被 CSP 拦下', async () => {
    const { ApiService } = await import('../ApiService')
    const site = new ApiService().getAllSites()['antigravity']

    expect(site).toBeDefined()
    expect(site.baseURL.startsWith('https://')).toBe(true)
  })
})

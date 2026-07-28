import { beforeEach, describe, expect, it } from 'vitest'

/**
 * 内置配置不许再指回 Miau 的源站 IP。
 *
 * 2026-07-28 把 Miau 网关从 `http://175.178.198.17:3000` 换成加速域名
 * `https://miauapi.13797248455.xyz`(实测同一实例:401 报文形状一致;明文 http
 * 不可达,只有 https 通)。
 *
 * 之所以要一道闸而不是靠记性:上一次同类事故是 v4.4.10 把 codex/grok 移出被封的
 * right.codes,两天后新加的 Claude 通道又指了回去,v4.4.13 才再修一次。加速域名
 * 这种「换了也能跑,只是慢」的迁移更容易回潮 —— 指回源站不会报错,只是国内用户
 * 悄悄变慢,没有任何症状会提醒你。只有读配置的检查能拦住。
 *
 * 注意:主进程 CSP 仍然放行 `http://175.178.198.17:*`,那是给**存量历史图片**留的
 * (转存失败时历史里存的是模型直出 URL),不代表这里可以再指回去。
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

  it('Miau 站点走 https —— 实测明文 http 根本连不上', async () => {
    const { ApiService } = await import('../ApiService')
    const site = new ApiService().getAllSites()['antigravity']

    expect(site).toBeDefined()
    expect(site.baseURL.startsWith('https://')).toBe(true)
  })
})

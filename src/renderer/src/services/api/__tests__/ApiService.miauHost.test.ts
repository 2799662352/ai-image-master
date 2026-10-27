import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MIAU_BASE_URL } from '../../../../../shared/miau'

/**
 * 主进程注入器里的默认网关 origin。
 *
 * **读源码文本而不是 import 它**:那个模块的 import 链会拉进 `electron`
 * (`app` / `safeStorage`)与整个 gatewayToken 落盘模块 —— 在这个渲染层测试文件里
 * 把它们 mock 起来实测会让 vitest worker 直接超时挂死。而这条测试要的只是一个
 * 字面量,不需要模块语义。
 *
 * 代价是没有类型检查,所以下面**必须**先断言「真的读到了」:常量一旦改名,正则匹配
 * 不到就会静默跳过比对 —— 一条永远绿的测试比没有测试更糟。
 */
function readInjectorDefaultOrigin(): string {
  const file = resolve(process.cwd(), 'src/main/services/auth/gatewayHeaderInjector.ts')
  const matched = /DEFAULT_GATEWAY_ORIGIN\s*=\s*'([^']+)'/.exec(readFileSync(file, 'utf8'))
  expect(matched, `没能从 ${file} 里读出 DEFAULT_GATEWAY_ORIGIN`).not.toBeNull()
  return matched![1]
}

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

  // 🚨 网关 host 在仓库里有**三份互相独立的字面量**,彼此没有任何编译期联系:
  //
  //   1. `main/services/auth/gatewayHeaderInjector.ts` 的 `DEFAULT_GATEWAY_ORIGIN`
  //      —— 注入器 URL 过滤器的默认值,决定**哪些请求会被换上平台凭据**;
  //   2. `ApiService.ts` 的 `DEFAULT_GATEWAY_BASE_URL`(经 `resolveGatewayBaseUrl()`
  //      成为 `apiSites[MIAU_SITE_KEY].baseURL`)—— 决定**哪些请求会被打上计费标记头**;
  //   3. `shared/miau.ts` 的 `MIAU_BASE_URL` —— agent 对话/理解与万相 3.0 那两条路的基址。
  //
  // 三处目前一致,但漂移的**方向性后果完全不同**:
  //   - 改 (2) → 渲染层打标记、注入器不认 → 401。响亮,查得出来。
  //   - 改 (1) → **渲染层不再打标记,而请求照样打到网关** → 静默用自填 Key 计费。
  //     用户以为在花平台余额,实际在花自己的钱,桌面端一个信号都没有。
  //
  // 开发构建的 `CATIMATION_GATEWAY_ORIGIN` 覆盖两边已经共用同一个变量名(各自的测试
  // 盯着),这里守的是**默认值**这一半 —— 那是安装包里唯一会生效的那个值。
  //
  // 刻意不做重构(把三处收成一份要同时动主进程 / 渲染层 / shared 三个边界),一道闸够了。
  // 同一分支上刚为 `BILLING_MARKER_HEADER` 做过同类的真源收拢,`src/types/authApi.ts`
  // 里写了为什么那次的重复是致命的:两边测试各自硬编码自己那份,只改一边照样双绿。
  // 这条测试存在的意义,就是不让那种「双绿」再发生一次。
  it('注入器、渲染层站点、shared 基址三处的网关 host 必须一致', async () => {
    // ⚠️ 必须先清掉开发覆盖再 import。
    //
    // `import.meta.env.DEV` 在 vitest 下**为真**,所以 `resolveGatewayBaseUrl()` 会去读
    // `CATIMATION_GATEWAY_ORIGIN`。开发者本地只要设过它(比如为了拿测试服跑一次真机),
    // 这条测试就会拿覆盖值去比默认值、莫名其妙地红 —— 而红的原因跟他改的代码毫无关系。
    //
    // 站点定义是模块级常量、在 import 那一刻就定死,所以清环境变量必须在 import **之前**,
    // 且要 resetModules 让上一条用例的模块图作废。
    delete process.env.CATIMATION_GATEWAY_ORIGIN
    vi.resetModules()

    const { ApiService, DEFAULT_GATEWAY_BASE_URL, MIAU_SITE_KEY } = await import('../ApiService')

    const injectorHost = new URL(readInjectorDefaultOrigin()).host

    expect(new URL(DEFAULT_GATEWAY_BASE_URL).host).toBe(injectorHost)
    expect(new URL(MIAU_BASE_URL).host).toBe(injectorHost)
    // 站点定义本身也要比一次,而不只是比那个常量:有人在 `apiSites` 里直接写死一个
    // 别的字面量、绕开 `resolveGatewayBaseUrl()`,上面两条照样绿。
    expect(new URL(new ApiService().getAllSites()[MIAU_SITE_KEY].baseURL).host).toBe(injectorHost)
  })

  // 覆盖生效时,站点地址必须跟着走 —— 否则渲染层发到 A、注入器只认 B,凭据一次都注不进去。
  // 与上一条是一对:那条守「安装包里的默认值」,这条守「开发构建里覆盖真的贯通」。
  it('开发构建下,覆盖会同时改掉站点地址', async () => {
    process.env.CATIMATION_GATEWAY_ORIGIN = 'https://gw.example.test'
    vi.resetModules()
    try {
      const { ApiService, MIAU_SITE_KEY } = await import('../ApiService')
      expect(new ApiService().getAllSites()[MIAU_SITE_KEY].baseURL).toBe('https://gw.example.test')
    } finally {
      delete process.env.CATIMATION_GATEWAY_ORIGIN
      vi.resetModules()
    }
  })
})

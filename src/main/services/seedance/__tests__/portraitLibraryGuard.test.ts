// 「万相不要人像库兜底」这条产品硬要求的护栏。
//
// 提交路径上挂着两件 Seedance 专属的事 —— 提交前的 asset:// 存在性校验、提交前的
// 素材库登记。两者对万相都是错的:它只认公网 https 直链,不认识 `asset://`。
//
// 光靠代码注释守不住这条:入口有两个(工作台 UI 的 video-workbench:submit 与 MCP
// 的 generate_video),每处两件事,漏一处就是线上出问题而测试全绿。所以这里既测
// 谓词本身,也用源码断言把「两个入口都真的问过它」钉死 —— 后者照抄本仓库既有的
// viewersUseIpc.test.ts 的写法。
//
// vvdance 直连删除之后,素材库只剩平台那一个:这里同时守「vvdance 那一整套没有回来」。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { upstreamAcceptsInlineMedia, usesPlatformAssetLibrary } from '../assetLibraryPolicy'

/**
 * 「素材库要不要参与」取决于**计费模式**;「上游吃不吃 base64 内联」只取决于 **provider** ——
 * 换了钱包上游仍然是 Seedance(经网关中转),内联与否不因此改变。合成一个谓词的后果就是
 * 当初的 bug:改对了一个问题,另一个跟着被改错。
 */
describe('upstreamAcceptsInlineMedia', () => {
  it('Seedance 吃内联,与计费模式无关', () => {
    for (const alias of ['2.0', '2.0-fast', '2.0-mini', '2.5'] as const) {
      expect(upstreamAcceptsInlineMedia(alias)).toBe(true)
    }
  })

  it('万相不吃 —— DashScope 只认可下载的 https', () => {
    expect(upstreamAcceptsInlineMedia('wan3')).toBe(false)
  })

  it('缺省(未指定模型)按 2.0 处理', () => {
    expect(upstreamAcceptsInlineMedia(undefined)).toBe(true)
  })
})

describe('usesPlatformAssetLibrary', () => {
  it('平台余额下的 Seedance 走平台素材库', () => {
    for (const alias of ['2.0', '2.0-fast', '2.0-mini', '2.5'] as const) {
      expect(usesPlatformAssetLibrary(alias, 'platform')).toBe(true)
    }
  })

  /**
   * 🧬 变异点:把谓词里的 `billing === 'platform'` 删掉,这条必红。
   *
   * 自填 Miau Key 没有登录态、也就没有平台 JWT,素材库那一整套(核验 / 登记)对它不可用;
   * 放行的话每次提交都会拿空凭据去打平台素材库接口。
   */
  it('自填 Key 与缺省意向都不走素材库 —— 没有登录态就没有库', () => {
    expect(usesPlatformAssetLibrary('2.0', 'own-key')).toBe(false)
    expect(usesPlatformAssetLibrary('2.0', undefined)).toBe(false)
  })

  it('万相在任何计费模式下都不走', () => {
    expect(usesPlatformAssetLibrary('wan3', 'platform')).toBe(false)
    expect(usesPlatformAssetLibrary('wan3', 'own-key')).toBe(false)
  })
})

describe('两个提交入口都必须问过这个谓词', () => {
  const runtimeSource = readFileSync(join(__dirname, '..', 'runtime.ts'), 'utf8')

  /**
   * 平台余额的 asset:// 核验也要两个入口都有。漏一个的表现是:工作台提交前就拦下并说清
   * 原因,agent 那条却照样建任务、排完队才回一句英文的 `asset … is not found`。
   */
  it('平台余额下两个入口都在提交前核验素材库引用', () => {
    const guarded =
      runtimeSource.match(
        /if \(usesPlatformAssetLibrary\(input\.model, \w+\)\) \{[\s\S]{0,400}?await verifyPlatformAssetReferences\(content, scope, getPlatformAsset\)/g,
      ) ?? []
    expect(guarded).toHaveLength(2)
    const calls = runtimeSource.match(/await verifyPlatformAssetReferences\(/g) ?? []
    expect(calls).toHaveLength(2)
  })

  /**
   * agent 的素材库工具必须跟随计费。以前固定走自填 Key 的人像库,平台余额的用户让
   * agent 挑素材,挑回来的 id 在平台池里不存在(2026-09-24 实机)。
   */
  it('agent 的 list / add 素材库工具都按计费分派到平台素材库', () => {
    expect(runtimeSource).toContain(
      "return resolveVideoBilling() === 'platform' ? activePlatformScope() : null",
    )
    const listFn = /router\.registerMain\('list_portrait_library'[\s\S]*?\n {2}\}\)/.exec(runtimeSource)?.[0] ?? ''
    expect(listFn).toMatch(/agentPlatformScope\(\)[\s\S]{0,120}listPlatformLibraryForAgent\(/)
    const addFn = /async function addAsset\([\s\S]*?\n {2}\}\r?\n/.exec(runtimeSource)?.[0] ?? ''
    expect(addFn).toMatch(/agentPlatformScope\(\)[\s\S]{0,600}ensureAsset\(/)
  })

  /**
   * 自填 Key 没有素材库:list 回一个带说明的空页(别抛错,agent 才不会拿同样的参数重试),
   * add 则明确报错(别假装存好了)。
   */
  it('没有平台素材库时 agent 的 list 回空页、add 报错', () => {
    const listFn = /router\.registerMain\('list_portrait_library'[\s\S]*?\n {2}\}\)/.exec(runtimeSource)?.[0] ?? ''
    expect(listFn).toContain("library: 'none'")
    const addFn = /async function addAsset\([\s\S]*?\n {2}\}\r?\n/.exec(runtimeSource)?.[0] ?? ''
    expect(addFn).toMatch(/throw new Error\('add_to_portrait_library: 人像库只在登录/)
  })

  /**
   * vvdance 直连整条路删除了:它的素材库 / 凭据 / 站点不该在运行时里以任何形式回来。
   * 回来的表现是「平台余额的用户被拿空的 vvdance 凭据校验素材」那一类说不清的错误。
   */
  it('runtime.ts 里没有 vvdance 素材库 / 凭据的任何入口', () => {
    for (const gone of [
      'verifyContentAssetReferences',
      'importImagesToPortraitLibrary',
      'usesSeedanceAssetLibrary',
      'getSeedanceApiKey',
      'getSeedanceApiSecret',
      'createSeedanceTransport',
      "'seedance:get-config'",
      "'seedance:assets-list'",
    ]) {
      expect(runtimeSource, `runtime.ts 不该再出现 ${gone}`).not.toContain(gone)
    }
  })

  // 另一个同源的坑:小素材(≤512KB)默认被读成 base64 内联进 content[],不是 URL。
  // Seedance 吃这一套,DashScope 只认可下载的 https。不跳过内联捷径的后果很隐蔽 ——
  // 大图正常、小图报错,用户完全想不到是体积的问题。
  it('非 Seedance provider 必须跳过内联捷径(alwaysRelay)', () => {
    // 这一处**刻意不吃 billing**:上游吃不吃内联与钱从哪个钱包出无关。
    // 用另一个谓词正是为了让这件事在类型上说得出口。
    expect(runtimeSource).toContain(
      'upstreamAcceptsInlineMedia(input.model) ? undefined : { alwaysRelay: true }',
    )
    // buildContent 里五处素材解析都要带上这个选项,漏一处就是那一类素材内联。
    const withOptions = runtimeSource.match(/resolveMediaUrl\([^)]*mediaOptions\)/g) ?? []
    expect(withOptions).toHaveLength(5)
  })

  /**
   * 平台模式下「自动入库」必须在 `materializeAssetRefs` 里接上,且两个提交入口都要调它。
   * 漏一个的表现是「MCP 出的片进库、工作台出的不进」这种说不清的不一致。
   */
  it('自动入库只剩平台库一条分支,两个入口都要调 materializeAssetRefs', () => {
    const entryCalls = runtimeSource.match(/await materializeAssetRefs\(/g) ?? []
    expect(entryCalls.length).toBe(2)
    expect(runtimeSource).toMatch(
      /billing === 'platform'\s*\?\s*await importImagesToPlatformLibrary\(content, \w+\)/,
    )
  })

  /**
   * 登记**不受**「默认上传人像库」开关管。
   *
   * 这条曾经反过来:开关关着就整个跳过。后来登记从「顺带的复用优化」变成了
   * 「过审的前提」—— 上游对直传 https 图做真人检测,只有 `asset://` 引用能过。
   * 于是「不登记」= 真人图必被拒,那不该由一个讲「要不要进库」的开关决定生成
   * 能不能成。开关的语义收窄成字面意思:登记照做,只是关着时立刻软删隐藏。
   *
   * 回归长这样:有人把 `if (!visible) return rewrites` 加回入库函数的开头。
   * 症状是「关掉开关后真人参考图就发不出去」—— 两件看起来毫不相干的事,
   * 用户不会把它们联系起来报给你。所以在这里钉死。
   */
  it('登记不被开关拦下 —— 开关只管可见性,不管入不入库', () => {
    const importFns =
      runtimeSource.match(/async function importImagesTo(?:Portrait|Platform)Library\([\s\S]*?\n\}/g) ?? []
    expect(importFns.length).toBe(1)
    for (const fn of importFns) {
      // 从签名里取出第二个形参(即那个开关)的名字,而不是硬编码 `visible` ——
      // 这样改名不会让守卫失效,也不会像 `if (!\w+)` 那样误伤 `!scope` 这类**合法**的早退
      // (没登录时本来就登记不了)。
      const flag = /content: SeedanceContentItem\[\],\s*(\w+): boolean/.exec(fn)?.[1]
      expect(flag).toBeDefined()
      expect(fn).not.toMatch(new RegExp(`if \\(!${flag}\\) return`))
    }
    // 而隐藏这条路必须真的在:否则开关就成了纯装饰。
    expect(runtimeSource).toMatch(/!visible[\s\S]{0,120}hidePlatformAsset\(/)
  })

  /**
   * 入库改写必须发生在 `taskManager.submit` **之前**。
   *
   * 这是 2026-08-31 那次改动的**全部意义**:上游对直传的 https 图做真人检测,
   * `InputImageSensitiveContentDetected.PrivacyInformation` 会拒掉整次生成,而已登记的
   * `asset://` 不走这道检测。登记发生在提交之后的话永远救不了当次 —— 用户看到的是
   * 一句关于「真人」的报错,它与「入库」之间没有任何字面关联,只能靠猜。
   *
   * 断言「submit 收到的是改写后的 content」而不是比较代码位置:前者是真正的不变量,
   * 有人把顺序挪回去、或者忘了把改写结果传下去,都会被抓住。
   *
   * 🧬 变异点:把任一处 `content: submitContent` 改回 `content`,这条必红。
   */
  it('提交拿到的是改写后的 content,不是原始的', () => {
    const submits = runtimeSource.match(/taskManager\.submit\(\{[\s\S]{0,240}?\}\)/g) ?? []
    expect(submits.length).toBe(2)
    for (const s of submits) {
      expect(s, `这处 submit 没用改写后的 content:\n${s}`).toContain('content: submitContent')
    }
  })

  /**
   * 万相必须原样放行,不能被改写成 `asset://`。
   *
   * `wan3/request.ts` 的 `requireHttpUrl` 见到 `asset://` 直接抛「万相 3.0 不支持
   * 人像库素材」。所以这个判据只能按**模型**来,不能按计费 —— 按计费判的话,
   * 平台模式下每一次万相生成都会挂,而那与本功能想解决的问题毫无关系。
   *
   * 🧬 变异点:删掉 `acceptsAssetRefs` 那道早退,这条必红。
   */
  it('只有认 asset:// 的模型才改写引用(万相原样放行)', () => {
    expect(runtimeSource).toContain(
      "const acceptsAssetRefs = capabilitiesFor(model ?? '2.0').provider === 'vvdance'",
    )
    expect(runtimeSource).toContain('if (!acceptsAssetRefs) return content')
  })

  /**
   * 网关地址必须与出网注入器**同源解析**,不能各写各的。
   *
   * 分叉的表现是「注入器盯着 A、视频提交打到 B」:测试服签的影子 token 发到生产网关
   * 一律 401,而错误里不会有任何一个字提到是地址配错了 —— 只会看见「Invalid token」,
   * 于是人去查 token 而不是查地址。
   *
   * 🧬 变异点:把任一个客户端的 `baseUrl` 那一行删掉(退回默认的 `MIAU_BASE_URL`),这条必红。
   */
  it('每一个打网关的视频客户端都各自接了 origin 解析', () => {
    // ⚠️ 这条**曾经写成** `expect(runtimeSource).toContain('baseUrl: …')` ——
    // 只证明「至少有一个客户端接了」。于是 2026-08-31 万相漏接 baseUrl 时它照样
    // 是绿的:seedanceGateway 那一处让整个文件包含了这个字符串。
    //
    // 后果是真机故障:测试服模式下 codex / 出图 / 平台版 Seedance 都跟着 override
    // 打测试网关并正常扣费,唯独万相把测试服签发的影子 token 发到生产网关,
    // 回一句 `401 无效的令牌` —— 别的功能全对,只有它错,人必然先去查凭据,
    // 而凭据是对的,错的是收件人。
    //
    // 所以现在**逐个构造点**查(同一个构造函数会出现多次:平台 / 自填 Key / 可灵都是
    // `createSeedanceGatewayClient`):新增一个网关客户端而忘了接 origin,这里会点名。
    const GATEWAY_CLIENTS = ['createWan3Client', 'createSeedanceGatewayClient'] as const
    const EXPECTED_MIN_SITES = { createWan3Client: 1, createSeedanceGatewayClient: 3 } as const

    const missing: string[] = []
    for (const fn of GATEWAY_CLIENTS) {
      const needle = `${fn}({`
      let from = 0
      let sites = 0
      for (;;) {
        const start = runtimeSource.indexOf(needle, from)
        if (start < 0) break
        sites++
        from = start + needle.length
        // 从构造点往后取一段足够覆盖整个选项对象的窗口。用窗口而不是配对花括号:
        // 选项里有箭头函数和模板串,手写配对反而更容易出错,而这一段本来就不长。
        const block = runtimeSource.slice(start, start + 2000)
        if (!block.includes('baseUrl: `${resolveGatewayOrigin()}/v1`')) {
          missing.push(`${fn}#${sites}`)
        }
      }
      expect(sites, `${fn} 在 runtime.ts 里的构造点数量`).toBeGreaterThanOrEqual(EXPECTED_MIN_SITES[fn])
    }

    expect(
      missing,
      missing.length === 0
        ? ''
        : `这些网关客户端没接 resolveGatewayOrigin():\n${missing.map((m) => `  - ${m}`).join('\n')}\n` +
          `不接就会回落到写死的生产 MIAU_BASE_URL —— 测试服模式下它会把测试服的\n` +
          `影子 token 发到生产网关,回一句 401,而错误里不会提到是地址分叉了。`,
    ).toEqual([])
  })
})

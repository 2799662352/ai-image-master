// 「万相不要人像库兜底」这条产品硬要求的护栏。
//
// 提交路径上挂着两件 Seedance 专属的事 —— 提交前的 asset:// 存在性校验、提交后的
// 人像库登记。两者对万相都是错的:它只认公网 https 直链,而那两次调用还要 Seedance
// 的 apiKey/apiSecret,只配了 Miau 密钥的用户会拿着空凭据去打别人家接口。
//
// 光靠代码注释守不住这条:入口有两个(工作台 UI 的 video-workbench:submit 与 MCP
// 的 generate_video),每处两件事,漏一处就是线上出问题而测试全绿。所以这里既测
// 谓词本身,也用源码断言把「两个入口都真的问过它」钉死 —— 后者照抄本仓库既有的
// viewersUseIpc.test.ts 的写法。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { upstreamAcceptsInlineMedia, usesSeedanceAssetLibrary } from '../assetLibraryPolicy'

describe('usesSeedanceAssetLibrary', () => {
  it('Seedance 全家走素材库 / 人像库', () => {
    for (const alias of ['2.0', '2.0-fast', '2.0-mini', '2.5'] as const) {
      expect(usesSeedanceAssetLibrary(alias)).toBe(true)
    }
  })

  it('万相 3.0 不走 —— 它只认 OSS/COS 直链', () => {
    expect(usesSeedanceAssetLibrary('wan3')).toBe(false)
  })

  it('缺省(未指定模型)按 2.0 处理,行为与接入万相之前一致', () => {
    expect(usesSeedanceAssetLibrary(undefined)).toBe(true)
  })

  /**
   * 🧬 变异点:把 `billing === 'platform'` 那一支删掉(退回只看 provider),这几条必红。
   *
   * 平台余额那条路用的是**平台的**素材库(`/api/volcengine-asset/*`,平台 JWT +
   * X-Project-Id),与 vvdance 的 `/api/open/v1/local-assets`(HMAC)是**两个池**,
   * `asset://` 不通用。只看 provider 的话,平台模式下仍会:
   *
   *   - 拿 vvdance 的 apiKey/apiSecret 去校验**平台的** asset id —— 那些 id 在
   *     vvdance 库里根本不存在,校验判定「缺失」并**硬拦下整次提交**
   *   - 把参考图导进 **vvdance 的**人像库,而用户看的是平台库
   *
   * 只配平台、没配 vvdance 密钥的用户撞不到(`assets.ts:375` 缺凭据提前 return),
   * **但从 vvdance 迁过来的用户两边密钥都有** —— 他们是这个 bug 的靶心,
   * 而报出来的是一句关于素材不存在的中文错误,根因完全看不出来。
   */
  it('平台余额下一律不碰 vvdance 素材库 —— 那是另一个池', () => {
    for (const alias of ['2.0', '2.0-fast', '2.0-mini', '2.5'] as const) {
      expect(usesSeedanceAssetLibrary(alias, 'platform')).toBe(false)
    }
  })

  it('自填 Key 与缺省意向保持原行为', () => {
    expect(usesSeedanceAssetLibrary('2.0', 'own-key')).toBe(true)
    expect(usesSeedanceAssetLibrary('2.0', undefined)).toBe(true)
  })

  it('万相在任何计费模式下都不走', () => {
    expect(usesSeedanceAssetLibrary('wan3', 'platform')).toBe(false)
    expect(usesSeedanceAssetLibrary('wan3', 'own-key')).toBe(false)
  })
})

/**
 * 与上面那个谓词**同源但不同问题**,拆开是这次修复的核心。
 *
 * 「要不要碰 vvdance 素材库」取决于计费模式;「上游吃不吃 base64 内联」只取决于
 * provider —— 平台模式下上游仍然是 Seedance(经网关中转),内联与否不因为换了钱包
 * 而改变。合成一个谓词的后果就是这次的 bug:改对了一个问题,另一个跟着被改错。
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
})

describe('两个提交入口都必须问过这个谓词', () => {
  const runtimeSource = readFileSync(join(__dirname, '..', 'runtime.ts'), 'utf8')

  it('runtime.ts 里 verifyContentAssetReferences / importImagesToPortraitLibrary 的每一次调用都在守卫内', () => {
    // 调用点数量与守卫数量必须对得上。新增一个提交入口却忘了加守卫,这里会红。
    // 允许带第二个实参(计费模式)。**不允许不带** —— 只传 model 的调用正是当初修的 bug,
    // 所以这里刻意要求逗号后面有东西。
    const verifyCalls = runtimeSource.match(/await verifyContentAssetReferences\(/g) ?? []
    const verifyGuards = runtimeSource.match(/if \(usesSeedanceAssetLibrary\(input\.model, \w+\)\) \{/g) ?? []
    expect(verifyCalls.length).toBeGreaterThan(0)
    expect(verifyGuards.length).toBe(verifyCalls.length)

    // 自动入库的分派 2026-08-31 收进了 `materializeAssetRefs`(为了能在提交前改写
    // 引用),所以它的谓词不再长在调用点上,而在那个函数里 —— 但仍必须存在。
    expect(runtimeSource).toMatch(/usesSeedanceAssetLibrary\(model, billing\)/)
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
   * 平台模式下「自动入库」必须**改道**到平台库,而不是跳过。
   *
   * 这条是补一个我自己造出来的缺口:修「平台模式别碰 vvdance 素材库」时,
   * `verifyContentAssetReferences` 与 `importImagesToPortraitLibrary` 共用同一个谓词,
   * 于是被一起关掉了。关 verify 是必须的(拿 vvdance 凭据去校验平台 id 会硬拦下提交);
   * 关 import 是**过度** —— 结果是平台用户生成用的参考图不会自动成为可复用的
   * `asset://` 锚点,下次跨镜锁同一张脸得手动再传一次,而 vvdance 用户有这个自动化。
   *
   * 两个提交入口都要有,漏一个的表现是「MCP 出的片进库、工作台出的不进」这种
   * 说不清的不一致。
   */
  it('平台模式下自动入库改道平台库,两个入口都要有', () => {
    // 分派收进了 `materializeAssetRefs`,所以「两个入口都有」现在等价于
    // 「两个入口都调它」+「它自己两条分支都在」。
    const entryCalls = runtimeSource.match(/await materializeAssetRefs\(/g) ?? []
    expect(entryCalls.length).toBe(2)
    expect(runtimeSource).toContain('importImagesToPortraitLibrary(content, enabled)')
    expect(runtimeSource).toContain('importImagesToPlatformLibrary(content, enabled)')
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
   * 🧬 变异点:把 `baseUrl` 那一行删掉(退回默认的 `MIAU_BASE_URL`),这条必红。
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
    // 所以现在**逐个客户端**查:新增第三个网关客户端而忘了接 origin,这里会点名。
    const GATEWAY_CLIENTS = ['createWan3Client', 'createSeedanceGatewayClient'] as const

    const missing: string[] = []
    for (const fn of GATEWAY_CLIENTS) {
      const start = runtimeSource.indexOf(`${fn}({`)
      expect(start, `${fn} 没在 runtime.ts 里构造`).toBeGreaterThanOrEqual(0)
      // 从构造点往后取一段足够覆盖整个选项对象的窗口。用窗口而不是配对花括号:
      // 选项里有箭头函数和模板串,手写配对反而更容易出错,而这一段本来就不长。
      const block = runtimeSource.slice(start, start + 2000)
      if (!block.includes('baseUrl: `${resolveGatewayOrigin()}/v1`')) missing.push(fn)
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

  it('没有任何一处裸调用(守卫之外直接调)', () => {
    // 把「守卫 + 紧随其后的调用」整段抠掉,剩下的正文里不该再出现这两个调用。
    const stripped = runtimeSource.replace(
      /if \(usesSeedanceAssetLibrary\(input\.model, \w+\)\) \{[\s\S]*?\n {6}\}/g,
      '',
    )
    expect(stripped).not.toContain('await verifyContentAssetReferences(')
    expect(stripped).not.toContain('void importImagesToPortraitLibrary(')
  })
})

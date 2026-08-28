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
    const verifyCalls = runtimeSource.match(/await verifyContentAssetReferences\(/g) ?? []
    const importCalls = runtimeSource.match(/void importImagesToPortraitLibrary\(/g) ?? []
    // 允许带第二个实参(计费模式)。**不允许不带** —— 只传 model 的调用正是这次修的 bug,
    // 所以这里刻意要求逗号后面有东西。
    const guards = runtimeSource.match(/if \(usesSeedanceAssetLibrary\(input\.model, \w+\)\) \{/g) ?? []

    expect(verifyCalls.length).toBeGreaterThan(0)
    expect(importCalls.length).toBeGreaterThan(0)
    expect(guards.length).toBe(verifyCalls.length + importCalls.length)
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

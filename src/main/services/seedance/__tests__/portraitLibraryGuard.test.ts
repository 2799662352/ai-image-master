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
import { usesSeedanceAssetLibrary } from '../wan3Request'

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
})

describe('两个提交入口都必须问过这个谓词', () => {
  const runtimeSource = readFileSync(join(__dirname, '..', 'runtime.ts'), 'utf8')

  it('runtime.ts 里 verifyContentAssetReferences / importImagesToPortraitLibrary 的每一次调用都在守卫内', () => {
    // 调用点数量与守卫数量必须对得上。新增一个提交入口却忘了加守卫,这里会红。
    const verifyCalls = runtimeSource.match(/await verifyContentAssetReferences\(/g) ?? []
    const importCalls = runtimeSource.match(/void importImagesToPortraitLibrary\(/g) ?? []
    const guards = runtimeSource.match(/if \(usesSeedanceAssetLibrary\(input\.model\)\) \{/g) ?? []

    expect(verifyCalls.length).toBeGreaterThan(0)
    expect(importCalls.length).toBeGreaterThan(0)
    expect(guards.length).toBe(verifyCalls.length + importCalls.length)
  })

  // 另一个同源的坑:小素材(≤512KB)默认被读成 base64 内联进 content[],不是 URL。
  // Seedance 吃这一套,DashScope 只认可下载的 https。不跳过内联捷径的后果很隐蔽 ——
  // 大图正常、小图报错,用户完全想不到是体积的问题。
  it('非 Seedance provider 必须跳过内联捷径(alwaysRelay)', () => {
    expect(runtimeSource).toContain(
      'usesSeedanceAssetLibrary(input.model) ? undefined : { alwaysRelay: true }',
    )
    // buildContent 里五处素材解析都要带上这个选项,漏一处就是那一类素材内联。
    const withOptions = runtimeSource.match(/resolveMediaUrl\([^)]*mediaOptions\)/g) ?? []
    expect(withOptions).toHaveLength(5)
  })

  it('没有任何一处裸调用(守卫之外直接调)', () => {
    // 把「守卫 + 紧随其后的调用」整段抠掉,剩下的正文里不该再出现这两个调用。
    const stripped = runtimeSource.replace(
      /if \(usesSeedanceAssetLibrary\(input\.model\)\) \{[\s\S]*?\n {6}\}/g,
      '',
    )
    expect(stripped).not.toContain('await verifyContentAssetReferences(')
    expect(stripped).not.toContain('void importImagesToPortraitLibrary(')
  })
})

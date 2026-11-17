/**
 * 联网搜索必须按能力表丢弃 —— 渲染端载荷里的 `webSearch` 不是可信输入。
 *
 * 为什么要有这道:工作台卡片的联网开关默认是开的(`cardSpec` 缺省 true),`startCards` 只看
 * `card.webSearch` 就把 `webSearch: true` 放进提交载荷,能力表只决定「要不要显示那个开关」。
 * 万相 / 可灵各有自己的组包层,根本不读这个字段;但 Roneyun-cn 与火山走同一个 Seedance 网关组包,
 * 它会照发 `metadata.tools`,而 Roneyun-cn 的网关(new-api #203)在预扣前就 400「不支持联网搜索」
 * —— 不丢的话,这条渠道的每一次**默认**提交都会被拒(2026-11-17 用真 key 对生产实测)。
 *
 * runtime.ts 一 import 就要 electron,所以和 agentUhdGate.test.ts / billingWiring.test.ts 一样读源码断言形状。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { capabilitiesFor } from '../../../../types/seedance'
import { buildSeedanceGatewayCreateBody } from '../../seedanceGateway/request'

const runtimeSource = readFileSync(join(__dirname, '..', 'runtime.ts'), 'utf8')

function submitHandlerBody(): string {
  const start = runtimeSource.indexOf("ipcMain.handle('video-workbench:submit'")
  expect(start, '找不到 video-workbench:submit').toBeGreaterThan(-1)
  const end = runtimeSource.indexOf("ipcMain.removeHandler('video-workbench:cancel')", start)
  expect(end).toBeGreaterThan(start)
  return runtimeSource.slice(start, end)
}

describe('工作台提交入口按能力表丢弃 webSearch', () => {
  /**
   * 🧬 变异点:把 `&& caps.webSearch` 删掉,这条必红。
   */
  it('只有能力表允许联网的模型才带 webSearch', () => {
    expect(submitHandlerBody()).toContain('...(payload?.webSearch === true && caps.webSearch ? { webSearch: true } : {})')
  })

  it('没有任何地方绕过这道闸直接读 payload.webSearch', () => {
    const reads = submitHandlerBody().match(/payload\??\.webSearch/g) ?? []
    expect(reads).toHaveLength(1)
  })
})

describe('组包层:webSearch 缺席时一个字都不出现', () => {
  const base = { model: 'cn-seedance-2.0-mini', content: [{ type: 'text' as const, text: 'x' }] }

  it('带 webSearch 才有 tools;没带 / false 都没有 —— 与能力表的 false 配合,Roneyun-cn 永远不会带 tools', () => {
    expect(buildSeedanceGatewayCreateBody({ ...base, webSearch: true }).metadata.tools).toEqual([{ type: 'web_search' }])
    expect('tools' in buildSeedanceGatewayCreateBody(base).metadata).toBe(false)
    expect('tools' in buildSeedanceGatewayCreateBody({ ...base, webSearch: false }).metadata).toBe(false)
  })

  it('Roneyun-cn 四个模型的能力表都是不联网', () => {
    for (const alias of ['cn-seedance-2.0', 'cn-seedance-2.0-fast', 'cn-seedance-2.0-mini', 'cn-seedance-2.5'] as const) {
      expect(capabilitiesFor(alias).webSearch, alias).toBe(false)
    }
  })
})

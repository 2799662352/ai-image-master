// 「计费意向一路走到 transportFor」的中间那一段护栏。
//
// 这一段在 runtime.ts 里,而 runtime.ts 顶层就 import electron、并在
// initSeedanceRuntime 里注册十几个 IPC handler —— 要真跑起来得先搭十来个 mock。
// 所以照本仓既有做法用源码断言把接线钉死(同 portraitLibraryGuard.test.ts,
// 那边守的是「两个提交入口都问过 usesSeedanceAssetLibrary」,同一类问题)。
//
// 这一层单独护栏的理由:两端都有真行为测试(渲染端 store 把 billingSource 放进
// 载荷、taskManager 按 billing 选 transport),唯独中间这一段只要有人手滑删掉,
// 两端的测试**全都照样是绿的**,而线上表现是「用户点了平台余额,扣的是他自己
// 的 vvdance key」—— 不报错、事后查不出来。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const runtimeSource = readFileSync(join(__dirname, '..', 'runtime.ts'), 'utf8')

/** 抠出某个 IPC handler 的正文(到下一个 removeHandler 为止)。 */
function handlerBody(channel: string, until: string): string {
  const start = runtimeSource.indexOf(`ipcMain.handle('${channel}'`)
  expect(start, `找不到 ${channel} 的 handler`).toBeGreaterThan(-1)
  const end = runtimeSource.indexOf(until, start)
  expect(end, `找不到 ${channel} 之后的 ${until}`).toBeGreaterThan(start)
  return runtimeSource.slice(start, end)
}

describe('平台余额通道必须被注册', () => {
  it('transportFor 的 registry 里有 seedanceGateway', () => {
    // 缺席时 transportFor 会抛「平台余额通道未就绪」—— 那是给配置问题准备的
    // 兜底,不该是接线之后的常态。
    expect(runtimeSource).toContain('seedanceGateway: seedanceGatewayTransport')
  })

  it('taskManager 也拿到了平台通道与兜底判据', () => {
    // 提交与轮询走的是 taskManager 自己那份 registry,与 transportOf 那份是
    // 两处 —— 只接一处的话「工作台能提交但重启接管走错路」这种半接线状态
    // 完全看不出来。
    expect(runtimeSource).toContain('seedanceGatewayTransport,')
    expect(runtimeSource).toContain('resolveBilling: resolveVideoBilling,')
  })

  it('取 token 的意向钉死在 platform,不让它自动兜底', () => {
    // 能走到这条 transport 就说明路由已经判定「这一次花平台余额」。再让它按
    // 「手上有什么用什么」兜底,一旦影子 token 恰好取不到就会静默换成用户自填的
    // Miau Key —— credentials.ts 明令禁止的跨模式回落。
    expect(runtimeSource).toMatch(
      /createSeedanceGatewayTokenResolver\(\s*gatewayTokenSources,\s*(\/\/[^\n]*\n\s*)*\(\) => 'platform',/,
    )
  })
})

describe('意向一路走到 transportFor', () => {
  it('工作台提交:读渲染层带来的 billing,并递给 taskManager', () => {
    const body = handlerBody('video-workbench:submit', "ipcMain.removeHandler('video-workbench:cancel')")

    // 读了。
    expect(body).toContain('coerceVideoBillingSource(payload?.billing)')
    // 而且真的用了 —— 只读不传等于没读,且两端的测试都察觉不到。
    const submitCall = /taskManager\.submit\(\{[\s\S]*?\n {6}\}\)/.exec(body)?.[0] ?? ''
    expect(submitCall, 'taskManager.submit 的调用块没找到').not.toBe('')
    expect(submitCall).toContain('billing')
  })

  it('对账与重取地址:每一次 transportOf 都带计费模式', () => {
    // transportOf 的第二个参数缺省时 transportFor 会按自填 Key 选路。一条平台
    // 任务因此会被拿 vvdance key 去问,回一句「任务不存在」——重启对账把它错杀成
    // 失败卡片,「重新保存」则永远失败。
    const calls = runtimeSource.match(/transportOf\([^)]*\)/g) ?? []
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call, `${call} 少了计费模式`).toMatch(/,/)
    }
  })

  it('重取地址那条路把任务自己的计费模式交给 persistVideo', () => {
    const body = handlerBody('video-workbench:repersist', "router.registerMain('generate_video'")
    expect(body).toContain('coerceVideoBillingSource(payload?.billing)')
  })
})

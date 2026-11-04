/**
 * 4K 只能由用户本人二次确认,AI 没有权限。
 *
 * runtime.ts 一 import 就要 electron,跑不起来,所以和 billingWiring.test.ts 一样读源码断言形状。
 * 这道闸的价值全在「位置」:必须在 announcePreparing(会广播「准备中」气泡并登记任务)之前,
 * 且不能被任何提前 return 绕开。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const runtimeSource = readFileSync(join(__dirname, '..', 'runtime.ts'), 'utf8')

function mcpHandlerHead(): string {
  const start = runtimeSource.indexOf("router.registerMain('generate_video'")
  expect(start, '找不到 generate_video 的主进程入口').toBeGreaterThan(-1)
  const announce = runtimeSource.indexOf('taskManager.announcePreparing(', start)
  expect(announce, 'generate_video 入口里找不到 announcePreparing').toBeGreaterThan(start)
  return runtimeSource.slice(start, announce)
}

describe('主进程 generate_video(只有 AI 会走)对 4K 的闸', () => {
  it('在 announcePreparing 之前就检查并抛错', () => {
    const head = mcpHandlerHead()
    expect(head).toContain('agentUhdRefusal(input)')
    expect(head).toMatch(/if \(uhdRefusal\) throw new Error\(uhdRefusal\)/)
  })

  it('闸前面没有任何 return / await —— 不能被提前分支绕开', () => {
    const head = mcpHandlerHead()
    const beforeGate = head.slice(0, head.indexOf('agentUhdRefusal(input)'))
    expect(beforeGate).not.toMatch(/\breturn\b/)
    expect(beforeGate).not.toMatch(/\bawait\b/)
  })

  it('工作台自己的提交 IPC 不走这道闸(那是用户本人,确认在渲染层弹窗里)', () => {
    const start = runtimeSource.indexOf("ipcMain.handle('video-workbench:submit'")
    expect(start).toBeGreaterThan(-1)
    const end = runtimeSource.indexOf("ipcMain.removeHandler('video-workbench:cancel')", start)
    expect(runtimeSource.slice(start, end)).not.toContain('agentUhdRefusal')
  })
})

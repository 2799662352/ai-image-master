// 主进程接线:两个通道转给 client;preload 里手写的通道名要和这里的常量一致
// (preload 不能 import 这个文件 —— 它会把 electron 主进程模块拖进预加载包)。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>()

vi.mock('electron', () => ({
  app: { isPackaged: true },
  net: { fetch: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    }),
  },
}))

vi.mock('../../auth/gatewayToken', () => ({
  getActivePoolToken: vi.fn(() => null),
  gatewayPlatformHeaders: vi.fn(() => ({})),
}))

import { VIDEO_BADCASE_IPC, registerVideoBadcaseIpc } from '../ipc'
import type { VideoBadcaseClient } from '../client'

function fakeClient(): VideoBadcaseClient & { report: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> } {
  return {
    report: vi.fn(async () => ({ ok: true as const, outcome: 'accepted' as const, caseId: 'c1' })),
    query: vi.fn(async () => ({ ok: true as const, record: null, rejection: null })),
  }
}

describe('registerVideoBadcaseIpc', () => {
  beforeEach(() => handlers.clear())

  it('注册 report / query 两个通道,并转给 client', async () => {
    const client = fakeClient()
    registerVideoBadcaseIpc(client)
    expect([...handlers.keys()].sort()).toEqual([VIDEO_BADCASE_IPC.QUERY, VIDEO_BADCASE_IPC.REPORT].sort())

    const input = { taskId: 'task_1', feedback: 'x', badcaseTypes: [] }
    const r = await handlers.get(VIDEO_BADCASE_IPC.REPORT)!({}, input)
    expect(client.report).toHaveBeenCalledWith(input)
    expect(r).toEqual({ ok: true, outcome: 'accepted', caseId: 'c1' })

    await handlers.get(VIDEO_BADCASE_IPC.QUERY)!({}, 'task_1')
    expect(client.query).toHaveBeenCalledWith('task_1')
  })

  it('重复注册不抛(热重载 / 测试里多次调用)', () => {
    const client = fakeClient()
    registerVideoBadcaseIpc(client)
    expect(() => registerVideoBadcaseIpc(client)).not.toThrow()
  })

  it('没有平台凭据时,默认 client 在请求出门前就返回 PLATFORM_NOT_READY', async () => {
    registerVideoBadcaseIpc() // 默认 client;getActivePoolToken 被 mock 成 null
    const r = await handlers.get(VIDEO_BADCASE_IPC.QUERY)!({}, 'task_1')
    expect(r).toMatchObject({ ok: false, code: 'PLATFORM_NOT_READY' })
  })

  it('入参不是对象 / 字符串时由 client 校验兜住,不抛', async () => {
    registerVideoBadcaseIpc()
    expect(await handlers.get(VIDEO_BADCASE_IPC.REPORT)!({}, undefined)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(await handlers.get(VIDEO_BADCASE_IPC.QUERY)!({}, 42)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
  })
})

describe('preload 通道名', () => {
  it('preload 里手写的字符串与主进程常量一致', () => {
    const preload = readFileSync(resolve(__dirname, '../../../../preload/index.ts'), 'utf8')
    expect(preload).toContain(`'${VIDEO_BADCASE_IPC.REPORT}'`)
    expect(preload).toContain(`'${VIDEO_BADCASE_IPC.QUERY}'`)
  })
})

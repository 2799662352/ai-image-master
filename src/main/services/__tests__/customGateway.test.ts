// @vitest-environment node

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CUSTOM_GATEWAY_STATE_FILE,
  PLATFORM_ON_CUSTOM_GATEWAY_ERROR,
  __resetCustomGatewayForTests,
  applyCustomGatewayState,
  createCustomGatewayFetch,
  customGatewayBaseUrl,
  customGatewayRoot,
  flushCustomGatewayPersist,
  getCustomGatewayState,
  initCustomGateway,
  isCustomGatewayActive,
  onCustomGatewayChange,
  platformTokenUnlessCustom,
  withCustomGatewayBilling,
} from '../customGateway'

const DEFAULT_ORIGIN = 'https://official.test'

let dir: string

beforeEach(() => {
  __resetCustomGatewayForTests()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-gw-'))
})

afterEach(async () => {
  // 落盘是后台串行队列:不等它排空就删目录,尾巴上的写入会在清理之后报错、
  // 把日志打到测试环境已经关掉的通道上(表现为 vitest 的 teardown 未处理错误)。
  await flushCustomGatewayPersist()
  __resetCustomGatewayForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

function stateFile(): string {
  return path.join(dir, CUSTOM_GATEWAY_STATE_FILE)
}

describe('状态:读盘 / 校验 / 落盘', () => {
  it('没有落盘文件 = 未启用', () => {
    initCustomGateway(dir)
    expect(getCustomGatewayState()).toEqual({ active: false, url: '' })
    expect(isCustomGatewayActive()).toBe(false)
    expect(customGatewayRoot()).toBeNull()
    expect(customGatewayBaseUrl()).toBeNull()
  })

  it('落盘的文件坏了 = 未启用,不抛', () => {
    fs.writeFileSync(stateFile(), '{not json')
    expect(() => initCustomGateway(dir)).not.toThrow()
    expect(isCustomGatewayActive()).toBe(false)
  })

  it('落盘里的地址不合法 = 未启用(哪怕 active 为真)', () => {
    fs.writeFileSync(stateFile(), JSON.stringify({ active: true, url: 'ftp://x.test' }))
    initCustomGateway(dir)
    expect(isCustomGatewayActive()).toBe(false)
  })

  it('落盘里写着 active:false 就是未启用,哪怕还留着一个合法地址', () => {
    fs.writeFileSync(stateFile(), JSON.stringify({ active: false, url: 'https://gw.example.com' }))
    initCustomGateway(dir)
    expect(getCustomGatewayState()).toEqual({ active: false, url: '' })
    expect(customGatewayRoot()).toBeNull()
  })

  it('启动时读回上次落盘的状态', () => {
    fs.writeFileSync(stateFile(), JSON.stringify({ active: true, url: 'https://gw.example.com' }))
    initCustomGateway(dir)
    expect(getCustomGatewayState()).toEqual({ active: true, url: 'https://gw.example.com' })
    expect(customGatewayRoot()).toBe('https://gw.example.com')
    expect(customGatewayBaseUrl()).toBe('https://gw.example.com/v1')
  })

  it('推来的状态会被归一化后落盘,重启能读回', async () => {
    initCustomGateway(dir)
    const r = applyCustomGatewayState({ active: true, url: 'https://gw.example.com/v1/' })
    expect(r).toEqual({
      ok: true,
      changed: true,
      state: { active: true, url: 'https://gw.example.com' },
    })
    await flushCustomGatewayPersist()
    expect(JSON.parse(fs.readFileSync(stateFile(), 'utf8'))).toEqual({
      active: true,
      url: 'https://gw.example.com',
    })

    __resetCustomGatewayForTests()
    initCustomGateway(dir)
    expect(customGatewayBaseUrl()).toBe('https://gw.example.com/v1')
  })

  it('落盘内容只有开关和地址,没有别的字段', async () => {
    initCustomGateway(dir)
    applyCustomGatewayState({ active: true, url: 'http://127.0.0.1:3000', apiKey: 'sk-secret' })
    await flushCustomGatewayPersist()
    const text = fs.readFileSync(stateFile(), 'utf8')
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['active', 'url'])
    expect(text).not.toContain('sk-secret')
  })

  it('关闭 = 清空地址;关闭后根地址是 null', () => {
    initCustomGateway(dir)
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })
    const r = applyCustomGatewayState({ active: false, url: 'https://ignored.example.com' })
    expect(r).toEqual({ ok: true, changed: true, state: { active: false, url: '' } })
    expect(customGatewayRoot()).toBeNull()
    expect(customGatewayBaseUrl()).toBeNull()
  })

  it('同样的状态再推一次:changed 为假、不通知监听者、不重写文件', async () => {
    initCustomGateway(dir)
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })
    await flushCustomGatewayPersist()
    const before = fs.statSync(stateFile()).mtimeMs

    const listener = vi.fn()
    onCustomGatewayChange(listener)
    const r = applyCustomGatewayState({ active: true, url: 'https://gw.example.com/' })
    expect(r).toMatchObject({ ok: true, changed: false })
    expect(listener).not.toHaveBeenCalled()
    await flushCustomGatewayPersist()
    expect(fs.statSync(stateFile()).mtimeMs).toBe(before)
  })

  it('变了会通知监听者,退订后不再通知', () => {
    initCustomGateway(dir)
    const listener = vi.fn()
    const off = onCustomGatewayChange(listener)
    applyCustomGatewayState({ active: true, url: 'https://a.example.com' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({ active: true, url: 'https://a.example.com' })
    off()
    applyCustomGatewayState({ active: true, url: 'https://b.example.com' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('开着的时候只换地址也算变了:通知监听者(Codex 要按新地址重启)', () => {
    initCustomGateway(dir)
    applyCustomGatewayState({ active: true, url: 'https://a.example.com' })
    const listener = vi.fn()
    onCustomGatewayChange(listener)

    const r = applyCustomGatewayState({ active: true, url: 'https://b.example.com' })

    expect(r).toMatchObject({ ok: true, changed: true, state: { active: true, url: 'https://b.example.com' } })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({ active: true, url: 'https://b.example.com' })
  })

  it('监听者抛错不影响状态生效,也不影响别的监听者', () => {
    initCustomGateway(dir)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const second = vi.fn()
    onCustomGatewayChange(() => {
      throw new Error('boom')
    })
    onCustomGatewayChange(second)
    const r = applyCustomGatewayState({ active: true, url: 'https://a.example.com' })
    expect(r).toMatchObject({ ok: true, changed: true })
    expect(second).toHaveBeenCalledTimes(1)
    expect(isCustomGatewayActive()).toBe(true)
    warn.mockRestore()
  })

  it.each([
    ['不是对象', 'oops'],
    ['null', null],
    ['active 不是布尔', { active: 'yes', url: 'https://a.example.com' }],
    ['缺 active', { url: 'https://a.example.com' }],
  ])('参数不对被整体拒收:%s', (_name, raw) => {
    initCustomGateway(dir)
    applyCustomGatewayState({ active: true, url: 'https://keep.example.com' })
    const r = applyCustomGatewayState(raw)
    expect(r.ok).toBe(false)
    expect(customGatewayRoot()).toBe('https://keep.example.com')
  })

  it.each([
    ['空地址', ''],
    ['不是字符串', 123],
    ['非 http(s) 协议', 'file:///etc/passwd'],
    ['带账号密码', 'https://user:pass@gw.example.com'],
  ])('生效时地址不合法 → 整体拒收、保持原状态:%s', (_name, url) => {
    initCustomGateway(dir)
    applyCustomGatewayState({ active: true, url: 'https://keep.example.com' })
    const r = applyCustomGatewayState({ active: true, url })
    expect(r).toEqual({ ok: false, error: '网关地址不合法' })
    expect(customGatewayRoot()).toBe('https://keep.example.com')
  })

  it('没调 initCustomGateway(没有落盘路径)时状态仍在内存里生效', () => {
    const r = applyCustomGatewayState({ active: true, url: 'https://a.example.com' })
    expect(r).toMatchObject({ ok: true, changed: true })
    expect(customGatewayRoot()).toBe('https://a.example.com')
  })

  it('落盘失败不影响内存里的生效', async () => {
    initCustomGateway(path.join(dir, 'no-such-dir'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    applyCustomGatewayState({ active: true, url: 'https://a.example.com' })
    await flushCustomGatewayPersist()
    expect(customGatewayRoot()).toBe('https://a.example.com')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('platformTokenUnlessCustom:平台 token 不跟着去自定义地址', () => {
  it('未启用:原样返回底层读到的值', () => {
    initCustomGateway(dir)
    expect(platformTokenUnlessCustom(() => 'sk-shadow')()).toBe('sk-shadow')
    expect(platformTokenUnlessCustom(() => null)()).toBeNull()
  })

  it('启用:一律当没有,而且根本不去读底层', () => {
    initCustomGateway(dir)
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })
    const read = vi.fn(() => 'sk-shadow')
    expect(platformTokenUnlessCustom(read)()).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('每次调用现看状态,不是包装时定死', () => {
    initCustomGateway(dir)
    const wrapped = platformTokenUnlessCustom(() => 'sk-shadow')
    expect(wrapped()).toBe('sk-shadow')
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })
    expect(wrapped()).toBeNull()
    applyCustomGatewayState({ active: false, url: '' })
    expect(wrapped()).toBe('sk-shadow')
  })
})

describe('withCustomGatewayBilling:新提交只会是自填 Key', () => {
  it('未启用:交给底层判定,并把调用方的意向原样传下去', () => {
    initCustomGateway(dir)
    const base = vi.fn((prefer?: 'platform' | 'own-key') => prefer ?? 'platform')
    const resolve = withCustomGatewayBilling(base, 'own-key')
    expect(resolve('own-key')).toBe('own-key')
    expect(resolve()).toBe('platform')
    expect(base).toHaveBeenNthCalledWith(1, 'own-key')
    expect(base).toHaveBeenNthCalledWith(2, undefined)
  })

  it('启用:不论调用方点名谁,都是自填 Key,不再问底层', () => {
    initCustomGateway(dir)
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })
    const base = vi.fn(() => 'platform' as const)
    const resolve = withCustomGatewayBilling<'platform' | 'own-key'>(base, 'own-key')
    expect(resolve('platform')).toBe('own-key')
    expect(resolve()).toBe('own-key')
    expect(base).not.toHaveBeenCalled()
  })
})

describe('createCustomGatewayFetch:出网改写 + 平台归属头护栏', () => {
  function setup() {
    const inner = vi.fn(async (_url: string, _init: RequestInit) => new Response('ok'))
    const wrapped = createCustomGatewayFetch(inner, () => DEFAULT_ORIGIN)
    return { inner, wrapped }
  }

  it('未启用:原样放行,地址一个字都不改', async () => {
    initCustomGateway(dir)
    const { inner, wrapped } = setup()
    const init = { method: 'POST', headers: { 'X-Platform-User-Id': 'u1' } }
    await wrapped(`${DEFAULT_ORIGIN}/v1/videos?x=1`, init)
    expect(inner).toHaveBeenCalledWith(`${DEFAULT_ORIGIN}/v1/videos?x=1`, init)
  })

  it('启用:发往官方域名的请求改发到用户的根地址,路径与查询串原样保留', async () => {
    initCustomGateway(dir)
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com:8443' })
    const { inner, wrapped } = setup()
    const init = { method: 'POST', headers: { Authorization: 'Bearer sk-own' } }
    await wrapped(`${DEFAULT_ORIGIN}/v1/video/generations?a=1&b=2`, init)
    expect(inner).toHaveBeenCalledWith('https://gw.example.com:8443/v1/video/generations?a=1&b=2', init)
  })

  it('启用 + 用户地址带子路径:子路径保留在最前面', async () => {
    initCustomGateway(dir)
    applyCustomGatewayState({ active: true, url: 'https://host.example.com/newapi' })
    const { inner, wrapped } = setup()
    await wrapped(`${DEFAULT_ORIGIN}/v1/videos/t1`, { method: 'GET' })
    expect(inner.mock.calls[0][0]).toBe('https://host.example.com/newapi/v1/videos/t1')
  })

  it('启用:发往别的域名(对象存储 / 下载)原样放行', async () => {
    initCustomGateway(dir)
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })
    const { inner, wrapped } = setup()
    await wrapped('https://cos.example.com/a/b.mp4?sig=1', { method: 'GET' })
    expect(inner.mock.calls[0][0]).toBe('https://cos.example.com/a/b.mp4?sig=1')
  })

  it('启用:官方域名上看起来像的域名(子域 / 后缀拼接)不会被误改写', async () => {
    initCustomGateway(dir)
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })
    const { inner, wrapped } = setup()
    await wrapped('https://official.test.evil.example/v1/videos', { method: 'GET' })
    await wrapped('https://sub.official.test/v1/videos', { method: 'GET' })
    expect(inner.mock.calls[0][0]).toBe('https://official.test.evil.example/v1/videos')
    expect(inner.mock.calls[1][0]).toBe('https://sub.official.test/v1/videos')
  })

  it('启用:不是合法 URL 的输入交给底层自己报错,不在这里吞', async () => {
    initCustomGateway(dir)
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })
    const { inner, wrapped } = setup()
    await wrapped('not a url', { method: 'GET' })
    expect(inner.mock.calls[0][0]).toBe('not a url')
  })

  it.each([
    ['X-Platform-User-Id', { 'X-Platform-User-Id': 'u1' }],
    ['x-project-id(小写)', { 'x-project-id': '345' }],
    ['X-Producer-Project-Id', { 'X-Producer-Project-Id': '9' }],
    ['X-Catimation-Billing', { 'X-Catimation-Billing': 'platform' }],
  ])('启用:带平台归属头(%s)的请求直接抛错、一个字节都不发', async (_name, headers) => {
    initCustomGateway(dir)
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })
    const { inner, wrapped } = setup()
    await expect(
      wrapped(`${DEFAULT_ORIGIN}/v1/videos`, { method: 'POST', headers }),
    ).rejects.toThrow(PLATFORM_ON_CUSTOM_GATEWAY_ERROR)
    expect(inner).not.toHaveBeenCalled()
  })

  it('启用:归属头写在 Headers 对象 / 二维数组里同样被拦', async () => {
    initCustomGateway(dir)
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })
    const { inner, wrapped } = setup()
    await expect(
      wrapped(`${DEFAULT_ORIGIN}/v1/videos`, { headers: new Headers({ 'X-Platform-User-Id': 'u1' }) }),
    ).rejects.toThrow(PLATFORM_ON_CUSTOM_GATEWAY_ERROR)
    await expect(
      wrapped(`${DEFAULT_ORIGIN}/v1/videos`, { headers: [['X-Project-Id', '1']] }),
    ).rejects.toThrow(PLATFORM_ON_CUSTOM_GATEWAY_ERROR)
    expect(inner).not.toHaveBeenCalled()
  })

  it('启用:只带自填 Key 的 Authorization 不会被护栏误伤', async () => {
    initCustomGateway(dir)
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })
    const { inner, wrapped } = setup()
    await wrapped(`${DEFAULT_ORIGIN}/v1/videos`, {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-own', 'Content-Type': 'application/json' },
    })
    expect(inner).toHaveBeenCalledTimes(1)
  })

  it('启用:发往别的域名的请求即使带归属头也不归这层管(不抛)', async () => {
    initCustomGateway(dir)
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })
    const { inner, wrapped } = setup()
    await wrapped('https://other.example.com/x', { headers: { 'X-Platform-User-Id': 'u1' } })
    expect(inner).toHaveBeenCalledTimes(1)
  })

  it('每次调用现看状态:关掉后立刻回到官方域名', async () => {
    initCustomGateway(dir)
    const { inner, wrapped } = setup()
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })
    await wrapped(`${DEFAULT_ORIGIN}/v1/a`, { method: 'GET' })
    applyCustomGatewayState({ active: false, url: '' })
    await wrapped(`${DEFAULT_ORIGIN}/v1/b`, { method: 'GET' })
    expect(inner.mock.calls[0][0]).toBe('https://gw.example.com/v1/a')
    expect(inner.mock.calls[1][0]).toBe(`${DEFAULT_ORIGIN}/v1/b`)
  })
})

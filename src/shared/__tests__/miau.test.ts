// Miau 网关基址的开发期覆盖。
//
// 存在的理由是 2026-08-29 真机撞到的那个:连着测试服跑,agent 聊天却仍打生产
// (base URL 写死),而平台影子 token 是测试服签的 —— 回一句 `Invalid token`,
// 人第一反应是去查 token,不会想到是地址。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIAU_BASE_URL, resolveMiauBaseUrl } from '../miau'

const ENV = 'CATIMATION_GATEWAY_ORIGIN'
const original = process.env[ENV]

beforeEach(() => {
  delete process.env[ENV]
})
afterEach(() => {
  if (original === undefined) delete process.env[ENV]
  else process.env[ENV] = original
})

describe('resolveMiauBaseUrl', () => {
  it('没设环境变量时就是生产', () => {
    expect(resolveMiauBaseUrl(false)).toBe(MIAU_BASE_URL)
  })

  it('开发构建认覆盖,并补上 /v1', () => {
    process.env[ENV] = 'http://43.161.233.87:3000'
    expect(resolveMiauBaseUrl(false)).toBe('http://43.161.233.87:3000/v1')
  })

  /**
   * 🧬 变异点:把 `isPackaged` 那道闸删掉,这条必红。
   *
   * 环境变量**攻击者也能设**(同一登录用户下的任何进程、快捷方式属性、外面套一层
   * 批处理)。打包产物若读它,就等于把「凭据只发给我们的网关」从编译期保证降级成
   * 一个攻击者同样握有开关的运行期配置 —— 改一个环境变量,真凭据就送到他自己的
   * 服务器上。完整论证见 `auth/gatewayHeaderInjector.resolveGatewayOrigin`。
   */
  it('打包产物一律忽略覆盖', () => {
    process.env[ENV] = 'http://evil.example'
    expect(resolveMiauBaseUrl(true)).toBe(MIAU_BASE_URL)
  })

  // 带路径的输入会拼出 `…/v1/v1`,那种 URL 打过去是 404,而 404 在这条链路上
  // 长得像「网关挂了」。只取 origin。
  it('只取 origin,丢掉输入里的路径', () => {
    process.env[ENV] = 'http://127.0.0.1:3000/v1/'
    expect(resolveMiauBaseUrl(false)).toBe('http://127.0.0.1:3000/v1')
  })

  it('非法 URL 回落生产,不抛', () => {
    process.env[ENV] = 'not a url'
    expect(resolveMiauBaseUrl(false)).toBe(MIAU_BASE_URL)
  })
})

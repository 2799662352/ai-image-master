// 万相走 Miau 网关,用的是**已经存在**的那枚 Miau token(apiKeys['qwen'],
// 用户在图片生成设置里填的那个,qwen 理解工具与 qwen 子代理一直在用)。
// 用户不需要为万相配置任何新东西 —— 这是选择走网关而不是直连百炼的主要理由。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetWan3Credentials,
  getWan3ApiKey,
  hasWan3ApiKey,
  setWan3TokenSource,
} from '../credentials'

const ORIGINAL_ENV = process.env.MIAU_API_KEY

beforeEach(() => {
  __resetWan3Credentials()
  delete process.env.MIAU_API_KEY
})

afterEach(() => {
  __resetWan3Credentials()
  if (ORIGINAL_ENV === undefined) delete process.env.MIAU_API_KEY
  else process.env.MIAU_API_KEY = ORIGINAL_ENV
})

describe('getWan3ApiKey', () => {
  it('取注入的 token 源', () => {
    setWan3TokenSource(() => 'miau-from-store')
    expect(getWan3ApiKey()).toBe('miau-from-store')
  })

  it('每次现取,不缓存 —— 用户改了密钥下一次提交就该生效', () => {
    let current = 'first'
    setWan3TokenSource(() => current)
    expect(getWan3ApiKey()).toBe('first')
    current = 'second'
    expect(getWan3ApiKey()).toBe('second')
  })

  it('两端空白都被裁掉', () => {
    setWan3TokenSource(() => '  padded  ')
    expect(getWan3ApiKey()).toBe('padded')
  })

  it('token 源没配 / 给空串时回落到环境变量', () => {
    process.env.MIAU_API_KEY = 'from-env'
    expect(getWan3ApiKey()).toBe('from-env')
    setWan3TokenSource(() => '')
    expect(getWan3ApiKey()).toBe('from-env')
  })

  it('token 源抛错时不连累提交链路,回落到环境变量', () => {
    // 这条链路只决定「能不能提交万相」,不该让一个取值异常炸掉整个视频服务。
    process.env.MIAU_API_KEY = 'from-env'
    setWan3TokenSource(() => {
      throw new Error('store not ready')
    })
    expect(getWan3ApiKey()).toBe('from-env')
  })

  it('都没有就是空串,不抛错', () => {
    expect(getWan3ApiKey()).toBe('')
  })
})

describe('hasWan3ApiKey', () => {
  it('据此在提交前给出「请先配置 Miau 密钥」而不是等上游 401', () => {
    expect(hasWan3ApiKey()).toBe(false)
    setWan3TokenSource(() => 'miau-token')
    expect(hasWan3ApiKey()).toBe(true)
  })
})

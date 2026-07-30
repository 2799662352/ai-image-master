// @vitest-environment node
//
// 钉住这条不变量:**任何** COS 失败都必须渲成人能读的文本。视频工作台那句
// 「COS relay upload failed ([object Object])」就是因为 SDK 抛的是裸对象而
// 调用方用了 String(e) —— 用户看不到原因,我们也无法据此判断该重试还是换文件。

import { describe, expect, it } from 'vitest'
import { describeCosError, isRetryableCosError } from '../cosErrors'

describe('describeCosError', () => {
  it('COS SDK 的裸对象不再渲成 [object Object]', () => {
    const sdkError = {
      code: 'AccessDenied',
      statusCode: 403,
      message: 'Access Denied.',
      headers: { 'x-cos-request-id': 'NjhmZmZm' },
    }
    const text = describeCosError(sdkError)
    expect(text).not.toContain('[object Object]')
    expect(text).toContain('AccessDenied')
    expect(text).toContain('HTTP 403')
    expect(text).toContain('NjhmZmZm')
  })

  it('带出内层原因 —— TLS / DNS / 代理故障只在内层错误上说真话', () => {
    const text = describeCosError({
      code: 'RequestError',
      error: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND cos.ap-guangzhou.myqcloud.com' },
    })
    expect(text).toContain('RequestError')
    expect(text).toContain('ENOTFOUND cos.ap-guangzhou.myqcloud.com')
  })

  it('信封为空时退回 JSON,仍然不是 [object Object]', () => {
    expect(describeCosError({ weird: 'shape' })).toBe('{"weird":"shape"}')
  })

  it('Error / 字符串 / 空值都有可读输出', () => {
    expect(describeCosError(new Error('boom'))).toContain('boom')
    expect(describeCosError('plain text')).toBe('plain text')
    expect(describeCosError(undefined)).toBe('unknown COS error')
    expect(describeCosError(null)).toBe('unknown COS error')
  })

  it('循环引用不会把整条链路带崩', () => {
    const cyclic: any = { statusCode: 0 }
    cyclic.self = cyclic
    expect(() => describeCosError(cyclic)).not.toThrow()
  })
})

describe('isRetryableCosError', () => {
  it('4xx 不重试 —— 票据/权限/请求本身错了,重试只是把失败推迟', () => {
    expect(isRetryableCosError({ statusCode: 403, code: 'AccessDenied' })).toBe(false)
    expect(isRetryableCosError({ statusCode: 400, code: 'InvalidArgument' })).toBe(false)
  })

  it('5xx 重试', () => {
    expect(isRetryableCosError({ statusCode: 503, code: 'ServiceUnavailable' })).toBe(true)
  })

  it('网络层错误码重试(含内层)', () => {
    expect(isRetryableCosError({ code: 'ECONNRESET' })).toBe(true)
    expect(isRetryableCosError({ code: 'RequestError', error: { code: 'ETIMEDOUT' } })).toBe(true)
    expect(isRetryableCosError({ cause: { code: 'EAI_AGAIN' } })).toBe(true)
  })

  it('没有错误码但文案指向超时/网络时也重试', () => {
    expect(isRetryableCosError(new Error('sliceUploadFile timeout'))).toBe(true)
    expect(isRetryableCosError({ message: 'socket hang up' })).toBe(true)
  })

  it('说不清的失败不重试 —— 无谓重试会把用户多耗几十秒', () => {
    expect(isRetryableCosError({ message: 'malformed key' })).toBe(false)
    expect(isRetryableCosError(undefined)).toBe(false)
  })
})

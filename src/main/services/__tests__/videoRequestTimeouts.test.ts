import { describe, expect, it } from 'vitest'
import {
  VIDEO_CREATE_TIMEOUT_MS,
  VIDEO_QUERY_TIMEOUT_MS,
  isAbortedByTimeout,
  videoRequestTimeoutMessage,
  videoRequestTimeoutMs,
} from '../videoRequestTimeouts'
import { translateVideoTaskError } from '../videoTaskError'

describe('videoRequestTimeouts', () => {
  it('提交五分钟、查询 30 秒:多图提交真实会超过 30s,查询是轻量 JSON', () => {
    expect(videoRequestTimeoutMs('create')).toBe(VIDEO_CREATE_TIMEOUT_MS)
    expect(videoRequestTimeoutMs('query')).toBe(VIDEO_QUERY_TIMEOUT_MS)
    expect(VIDEO_CREATE_TIMEOUT_MS).toBe(5 * 60_000)
    expect(VIDEO_QUERY_TIMEOUT_MS).toBe(30_000)
  })

  it('提交超时的文案必须说出「可能已计费、去核对明细」—— 这不是普通失败', () => {
    const msg = videoRequestTimeoutMessage('create', VIDEO_CREATE_TIMEOUT_MS)
    expect(msg).toMatch(/提交超过 5 分钟/)
    expect(msg).toMatch(/可能已被网关受理并计费/)
    expect(msg).toMatch(/使用明细/)
  })

  it('查询超时的文案只说会重试,不吓人', () => {
    const msg = videoRequestTimeoutMessage('query', VIDEO_QUERY_TIMEOUT_MS)
    expect(msg).toMatch(/查询任务状态超过 30 秒/)
    expect(msg).not.toMatch(/计费/)
  })

  it('isAbortedByTimeout:signal 已 abort 或错误名是 AbortError 都算', () => {
    const aborted = new AbortController()
    aborted.abort()
    expect(isAbortedByTimeout(new Error('whatever'), aborted.signal)).toBe(true)

    const live = new AbortController()
    const abortErr = new Error('This operation was aborted')
    abortErr.name = 'AbortError'
    expect(isAbortedByTimeout(abortErr, live.signal)).toBe(true)
    expect(isAbortedByTimeout(new Error('ECONNRESET'), live.signal)).toBe(false)
    expect(isAbortedByTimeout(null, live.signal)).toBe(false)
  })
})

describe('translateVideoTaskError 对裸 AbortError 的兜底', () => {
  it('把 Node 原话翻成提交超时的人话', () => {
    expect(translateVideoTaskError('This operation was aborted')).toMatch(/提交超过 5 分钟/)
    expect(translateVideoTaskError('The operation was aborted.')).toMatch(/可能已被网关受理并计费/)
    expect(translateVideoTaskError('AbortError')).toMatch(/使用明细/)
  })

  it('认不出的原样返回,不误伤别的错误', () => {
    expect(translateVideoTaskError('some upstream failure')).toBe('some upstream failure')
    // 含 aborted 但不是整句原话的,不动 —— 那可能是上游自己的错误文本。
    expect(translateVideoTaskError('task aborted by moderation')).toBe('task aborted by moderation')
  })
})

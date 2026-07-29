// worker 监管的判断逻辑。
//
// 为什么只测纯函数:真正的重生要起 utilityProcess + 真 PGlite + 真 Electron,
// 与 pgliteRecovery.ts 同款权衡 —— 判断抽出来单测,接线交给类型检查和手动验收。

import { describe, expect, it } from 'vitest'
import {
  RESPAWN_MAX,
  RESPAWN_WINDOW_MS,
  isConnectionLostError,
  pruneRespawnHistory,
  shouldRespawn,
} from '../pgliteSupervisor'

describe('isConnectionLostError', () => {
  it.each([
    ['Prisma 的统一报法', new Error('Server has closed the connection.')],
    ['错误码写在 message 里', new Error('boom code: P1017')],
    ['错误码挂在 code 字段上', Object.assign(new Error('boom'), { code: 'P1017' })],
    ['socket server 超限时那句裸文本', new Error('Too many connections')],
    ['worker 已经死了', Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })],
    ['worker 正在死的那一瞬', new Error('read ECONNRESET')],
    ['node-postgres 的说法', new Error('Connection terminated unexpectedly')],
    ['裸字符串', 'socket hang up'],
  ])('认得出「连接没了」:%s', (_label, err) => {
    expect(isConnectionLostError(err)).toBe(true)
  })

  it.each([
    ['唯一键冲突', Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })],
    ['外键违反', new Error('Foreign key constraint failed on the field: `threadId`')],
    ['SQL 语法错', new Error('syntax error at or near "SELCT"')],
    ['空值', null],
    ['undefined', undefined],
  ])('不把真实业务错误当瞬时错误:%s', (_label, err) => {
    // 重试业务错误只是把同一个错误再犯一遍
    expect(isConnectionLostError(err)).toBe(false)
  })
})

describe('shouldRespawn', () => {
  const now = 1_000_000

  it('没有历史时允许', () => {
    expect(shouldRespawn([], now)).toEqual({ allowed: true, recent: 0 })
  })

  it('窗口内到达上限就停手 —— 起不来时不该无限 fork', () => {
    const history = Array.from({ length: RESPAWN_MAX }, (_, i) => now - i * 1000)
    expect(shouldRespawn(history, now)).toEqual({ allowed: false, recent: RESPAWN_MAX })
  })

  it('滑出窗口的旧记录不计入', () => {
    const old = Array.from({ length: RESPAWN_MAX }, () => now - RESPAWN_WINDOW_MS - 1)
    expect(shouldRespawn(old, now)).toEqual({ allowed: true, recent: 0 })
  })

  it('不修改入参 —— 判断与收敛状态分开,测试不必同时盯两件事', () => {
    const history = [now - 1000]
    const frozen = [...history]
    shouldRespawn(history, now)
    expect(history).toEqual(frozen)
  })

  it('窗口与上限可覆盖(便于测试与调参)', () => {
    expect(shouldRespawn([now], now, { max: 1 })).toMatchObject({ allowed: false })
    expect(shouldRespawn([now - 50], now, { max: 1, windowMs: 10 })).toMatchObject({ allowed: true })
  })
})

describe('pruneRespawnHistory', () => {
  it('只留窗口内的', () => {
    const now = 500_000
    const history = [now - RESPAWN_WINDOW_MS - 1, now - 10, now]
    expect(pruneRespawnHistory(history, now)).toEqual([now - 10, now])
  })

  it('返回新数组,不改原数组', () => {
    const now = 500_000
    const history = [now - RESPAWN_WINDOW_MS - 1]
    const result = pruneRespawnHistory(history, now)
    expect(result).toEqual([])
    expect(history).toHaveLength(1)
  })
})

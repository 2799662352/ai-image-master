// worker 监管的判断逻辑。
//
// 为什么只测纯函数:真正的重生要起 utilityProcess + 真 PGlite + 真 Electron,
// 与 pgliteRecovery.ts 同款权衡 —— 判断抽出来单测,接线交给类型检查和手动验收。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RESPAWN_MAX,
  RESPAWN_WINDOW_MS,
  isConnectionLostError,
  isPoolAcquireTimeout,
  isRetryableOperation,
  planDbFailure,
  pruneRespawnHistory,
  shouldRespawn,
  takeRespawnSlot,
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

describe('isRetryableOperation', () => {
  it.each(['findUnique', 'findFirst', 'findMany', 'count', 'aggregate', 'groupBy'])(
    '读可以重试:%s',
    (op) => {
      expect(isRetryableOperation(op)).toBe(true)
    },
  )

  it.each(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'])(
    '写不能重试:%s —— 连接断在响应途中时写有没有落库是不确定的,重试会产生重复记录',
    (op) => {
      expect(isRetryableOperation(op)).toBe(false)
    },
  )

  it.each(['queryRaw', 'executeRaw', 'runCommandRaw'])(
    'raw 整体排除:%s —— 名字像读的 queryRaw 也能塞进 INSERT',
    (op) => {
      expect(isRetryableOperation(op)).toBe(false)
    },
  )
})

describe('isPoolAcquireTimeout', () => {
  it('认得出 pg 的取连接超时', () => {
    expect(isPoolAcquireTimeout(new Error('timeout exceeded when trying to connect'))).toBe(true)
  })

  it('不与「连接没了」混淆 —— 两者处置不同', () => {
    expect(isPoolAcquireTimeout(new Error('Server has closed the connection.'))).toBe(false)
  })
})

describe('planDbFailure', () => {
  it('取连接超时:连写也能安全重试 —— 查询压根没被执行', () => {
    const err = new Error('timeout exceeded when trying to connect')
    expect(planDbFailure(err, 'create')).toEqual({ retry: true, probeWorker: true })
    expect(planDbFailure(err, 'findMany')).toEqual({ retry: true, probeWorker: true })
  })

  it('连接没了:只重试读', () => {
    const err = new Error('Server has closed the connection.')
    expect(planDbFailure(err, 'findMany')).toEqual({ retry: true, probeWorker: true })
    // 写有没有落库不确定,重试会造重复记录
    expect(planDbFailure(err, 'create')).toEqual({ retry: false, probeWorker: true })
  })

  it('业务错误原样抛,也不去探活', () => {
    const err = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    expect(planDbFailure(err, 'create')).toEqual({ retry: false, probeWorker: false })
    expect(planDbFailure(err, 'findMany')).toEqual({ retry: false, probeWorker: false })
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

describe('takeRespawnSlot', () => {
  const now = 2_000_000

  it('允许时把这一次记进历史', () => {
    const slot = takeRespawnSlot([], now)
    expect(slot.allowed).toBe(true)
    expect(slot.history).toEqual([now])
  })

  it('额度用尽时不记账 —— 否则「查了没记」会让窗口无限往后滑', () => {
    // 全部严格早于 now,这样断言「now 没被记进去」才有意义
    const full = Array.from({ length: RESPAWN_MAX }, (_, i) => now - 1000 * (i + 1))
    const slot = takeRespawnSlot(full, now)
    expect(slot.allowed).toBe(false)
    expect(slot.history).toHaveLength(RESPAWN_MAX)
    expect(slot.history).not.toContain(now)
  })

  it('顺手收敛滑出窗口的旧记录', () => {
    const slot = takeRespawnSlot([now - RESPAWN_WINDOW_MS - 1, now - 5], now)
    expect(slot.history).toEqual([now - 5, now])
  })

  it('连续领额度会在第 RESPAWN_MAX+1 次被挡下', () => {
    let history: number[] = []
    for (let i = 0; i < RESPAWN_MAX; i++) {
      const slot = takeRespawnSlot(history, now + i)
      expect(slot.allowed).toBe(true)
      history = slot.history
    }
    expect(takeRespawnSlot(history, now + RESPAWN_MAX).allowed).toBe(false)
  })

  it('不修改入参', () => {
    const history = [now - 1]
    const frozen = [...history]
    takeRespawnSlot(history, now)
    expect(history).toEqual(frozen)
  })
})

// 熔断只在 exit 钩子里查是不够的:worker 死后 pgliteChild 为 null,后续每次
// getPrisma 都会走 startEmbeddedPGlite 那条懒恢复路径。两条都得过同一个闸,
// 否则一个起不来的 worker 会被每条查询各 fork 一次。
describe('两条恢复路径共用同一个熔断闸', () => {
  const source = readFileSync(path.resolve(__dirname, '../db.ts'), 'utf8')

  it('exit 钩子那条走 takeRespawnSlot', () => {
    const recover = source.slice(source.indexOf('async function recoverFromWorkerDeath'))
    expect(recover).toContain('takeRespawnSlot')
  })

  it('startEmbeddedPGlite 的懒恢复也走 takeRespawnSlot', () => {
    const start = source.slice(
      source.indexOf('export async function startEmbeddedPGlite'),
      source.indexOf('async function startEphemeralPGlite'),
    )
    expect(start).toContain('takeRespawnSlot')
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

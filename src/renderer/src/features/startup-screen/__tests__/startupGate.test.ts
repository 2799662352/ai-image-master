import { describe, it, expect } from 'vitest'
import {
  STARTUP_STORAGE_KEY,
  localDay,
  readPrefs,
  shouldPlay,
  markPlayed,
  type StorageLike,
} from '../startupGate'

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v)
    },
  }
}

/** 本地时间构造:不带 Z,避免测试依赖运行机器的时区 */
const at = (iso: string): Date => new Date(iso)

describe('localDay', () => {
  it('用本地日历日期,而不是 UTC', () => {
    // 本地 00:30 在 UTC+8 的机器上是前一天的 UTC 16:30,toISOString 会给出前一天
    expect(localDay(at('2026-11-09T00:30:00'))).toBe('2026-11-09')
    expect(localDay(at('2026-11-09T23:59:59'))).toBe('2026-11-09')
  })

  it('月 / 日补零', () => {
    expect(localDay(at('2026-01-05T12:00:00'))).toBe('2026-01-05')
  })
})

describe('readPrefs', () => {
  it('没有存档 → 每天一次,从没播过', () => {
    expect(readPrefs(memoryStorage())).toEqual({ mode: 'daily', lastPlayedDay: null })
  })

  it('没有存档时用调用方给的默认 mode;存档里明确写过的 mode 优先于默认', () => {
    expect(readPrefs(memoryStorage(), 'always')).toEqual({ mode: 'always', lastPlayedDay: null })
    const off = memoryStorage({ [STARTUP_STORAGE_KEY]: JSON.stringify({ mode: 'off' }) })
    expect(readPrefs(off, 'always').mode).toBe('off')
    // 存档只有日期、没写 mode(markPlayed 的产物)→ 仍用默认
    const dayOnly = memoryStorage({ [STARTUP_STORAGE_KEY]: JSON.stringify({ lastPlayedDay: '2026-11-08' }) })
    expect(readPrefs(dayOnly, 'always')).toEqual({ mode: 'always', lastPlayedDay: '2026-11-08' })
    // 不合法的 mode 一样回落到默认
    const bad = memoryStorage({ [STARTUP_STORAGE_KEY]: JSON.stringify({ mode: 'sometimes' }) })
    expect(readPrefs(bad, 'always').mode).toBe('always')
    // 取不到 storage 时也用默认
    expect(readPrefs(undefined, 'always').mode).toBe('always')
  })

  it('forceMode 压过存档里的一切:daily 今天播过、off、脏数据都照样按它走;日期仍照读', () => {
    const playedToday = memoryStorage({
      [STARTUP_STORAGE_KEY]: JSON.stringify({ mode: 'daily', lastPlayedDay: '2026-11-09' }),
    })
    expect(readPrefs(playedToday, 'daily', 'always')).toEqual({ mode: 'always', lastPlayedDay: '2026-11-09' })
    const off = memoryStorage({ [STARTUP_STORAGE_KEY]: JSON.stringify({ mode: 'off' }) })
    expect(readPrefs(off, 'daily', 'always').mode).toBe('always')
    expect(readPrefs(memoryStorage({ [STARTUP_STORAGE_KEY]: '{{坏' }), 'daily', 'always').mode).toBe('always')
    expect(readPrefs(undefined, 'daily', 'always').mode).toBe('always')
    // 不传 forceMode 时行为不变
    expect(readPrefs(playedToday, 'daily', undefined).mode).toBe('daily')
  })

  it('读出合法存档', () => {
    const s = memoryStorage({
      [STARTUP_STORAGE_KEY]: JSON.stringify({ mode: 'always', lastPlayedDay: '2026-11-08' }),
    })
    expect(readPrefs(s)).toEqual({ mode: 'always', lastPlayedDay: '2026-11-08' })
  })

  it('存档是脏数据时一律当不可信:坏 JSON / 非对象 / 未知模式 / 非日期', () => {
    const bad = [
      '{not json',
      'null',
      '42',
      '"daily"',
      JSON.stringify({ mode: 'sometimes', lastPlayedDay: '2026-11-08' }),
      JSON.stringify({ mode: 'daily', lastPlayedDay: 'yesterday' }),
      JSON.stringify({ mode: 'daily', lastPlayedDay: 20261108 }),
      JSON.stringify({ mode: 'daily', lastPlayedDay: '2026-13-45' }),
    ]
    for (const raw of bad) {
      const prefs = readPrefs(memoryStorage({ [STARTUP_STORAGE_KEY]: raw }))
      expect(prefs.mode === 'daily' || prefs.mode === 'always' || prefs.mode === 'off').toBe(true)
      // 脏的日期不能被当成「今天播过」
      expect(prefs.lastPlayedDay === null || /^\d{4}-\d{2}-\d{2}$/.test(prefs.lastPlayedDay)).toBe(true)
    }
    expect(
      readPrefs(memoryStorage({ [STARTUP_STORAGE_KEY]: JSON.stringify({ mode: 'sometimes' }) })).mode,
    ).toBe('daily')
    expect(
      readPrefs(memoryStorage({ [STARTUP_STORAGE_KEY]: JSON.stringify({ mode: 'daily', lastPlayedDay: 'yesterday' }) }))
        .lastPlayedDay,
    ).toBeNull()
    expect(
      readPrefs(memoryStorage({ [STARTUP_STORAGE_KEY]: JSON.stringify({ mode: 'daily', lastPlayedDay: '2026-13-45' }) }))
        .lastPlayedDay,
    ).toBeNull()
  })

  it('日期要是真实存在的:2 月 30 日、非闰年 2 月 29 日都不认,闰年 2 月 29 日认', () => {
    const day = (d: string) =>
      readPrefs(memoryStorage({ [STARTUP_STORAGE_KEY]: JSON.stringify({ mode: 'daily', lastPlayedDay: d }) }))
        .lastPlayedDay
    expect(day('2026-02-30')).toBeNull()
    expect(day('2025-02-29')).toBeNull()
    expect(day('2026-04-31')).toBeNull()
    expect(day('2024-02-29')).toBe('2024-02-29')
    expect(day('2026-12-31')).toBe('2026-12-31')
  })

  it('storage 读取抛错(隐私模式 / 被禁用)也不能抛出来', () => {
    const boom: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {},
    }
    expect(readPrefs(boom)).toEqual({ mode: 'daily', lastPlayedDay: null })
  })

  it('storage 不存在(undefined)时同样回落默认', () => {
    expect(readPrefs(undefined)).toEqual({ mode: 'daily', lastPlayedDay: null })
  })
})

describe('shouldPlay', () => {
  const now = at('2026-11-09T09:00:00')

  it('daily:今天没播过 → 播', () => {
    expect(shouldPlay({ mode: 'daily', lastPlayedDay: null }, now)).toBe(true)
    expect(shouldPlay({ mode: 'daily', lastPlayedDay: '2026-11-08' }, now)).toBe(true)
  })

  it('daily:今天播过 → 不播', () => {
    expect(shouldPlay({ mode: 'daily', lastPlayedDay: '2026-11-09' }, now)).toBe(false)
  })

  it('跨午夜:23:59 播过,第二天 00:01 要再播', () => {
    const p = { mode: 'daily' as const, lastPlayedDay: localDay(at('2026-11-09T23:59:00')) }
    expect(shouldPlay(p, at('2026-11-09T23:59:30'))).toBe(false)
    expect(shouldPlay(p, at('2026-11-10T00:01:00'))).toBe(true)
  })

  it('always:每次都播(调试 / 预览用)', () => {
    expect(shouldPlay({ mode: 'always', lastPlayedDay: '2026-11-09' }, now)).toBe(true)
  })

  it('off:永不播', () => {
    expect(shouldPlay({ mode: 'off', lastPlayedDay: null }, now)).toBe(false)
  })

  it('系统时钟被拨回(存档日期在未来):不是今天,照样播,不能被一个未来日期永久静音', () => {
    expect(shouldPlay({ mode: 'daily', lastPlayedDay: '2027-01-01' }, now)).toBe(true)
  })
})

describe('markPlayed', () => {
  it('写入今天的本地日期,保留 mode', () => {
    const s = memoryStorage({
      [STARTUP_STORAGE_KEY]: JSON.stringify({ mode: 'always', lastPlayedDay: '2026-11-01' }),
    })
    markPlayed(s, at('2026-11-09T09:00:00'))
    expect(JSON.parse(s.data[STARTUP_STORAGE_KEY])).toEqual({ mode: 'always', lastPlayedDay: '2026-11-09' })
  })

  it('没有存档时只写日期,不把默认 mode 固化进存档', () => {
    const s = memoryStorage()
    markPlayed(s, at('2026-11-09T09:00:00'))
    expect(JSON.parse(s.data[STARTUP_STORAGE_KEY])).toEqual({ lastPlayedDay: '2026-11-09' })
  })

  it('存档里的 mode 不合法时也不固化(当作没写过)', () => {
    const s = memoryStorage({ [STARTUP_STORAGE_KEY]: JSON.stringify({ mode: 'sometimes' }) })
    markPlayed(s, at('2026-11-09T09:00:00'))
    expect(JSON.parse(s.data[STARTUP_STORAGE_KEY])).toEqual({ lastPlayedDay: '2026-11-09' })
  })

  it('调试默认 always:播完后下次启动仍然要播(默认不会被存档固化成 daily)', () => {
    const s = memoryStorage()
    const now = at('2026-11-09T09:00:00')
    expect(shouldPlay(readPrefs(s, 'always'), now)).toBe(true)
    markPlayed(s, now)
    expect(shouldPlay(readPrefs(s, 'always'), now)).toBe(true)
    // 同一份存档按正式版默认读,当天不再播
    expect(shouldPlay(readPrefs(s), now)).toBe(false)
  })

  it('写入后 readPrefs + shouldPlay 当天返回 false(闭环)', () => {
    const s = memoryStorage()
    const now = at('2026-11-09T09:00:00')
    expect(shouldPlay(readPrefs(s), now)).toBe(true)
    markPlayed(s, now)
    expect(shouldPlay(readPrefs(s), now)).toBe(false)
  })

  it('storage 写入抛错(配额 / 隐私模式)不抛出', () => {
    const boom: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(() => markPlayed(boom, at('2026-11-09T09:00:00'))).not.toThrow()
    expect(() => markPlayed(undefined, at('2026-11-09T09:00:00'))).not.toThrow()
  })
})

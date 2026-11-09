import { describe, it, expect } from 'vitest'
import {
  IDENTITY_STORAGE_KEY,
  FALLBACK_IDENTITY,
  pickIdentityName,
  readCachedIdentity,
  writeCachedIdentity,
} from '../startupIdentity'
import type { StorageLike } from '../startupGate'

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

describe('pickIdentityName', () => {
  it('优先显示名,其次登录名', () => {
    expect(pickIdentityName({ displayName: '汤显鑫', username: 'tangxx' })).toBe('汤显鑫')
    expect(pickIdentityName({ displayName: '  ', username: 'tangxx' })).toBe('tangxx')
    expect(pickIdentityName({ displayName: null, username: 'tangxx' })).toBe('tangxx')
  })

  it('两者都没有 → null(由调用方决定回落)', () => {
    expect(pickIdentityName({ displayName: null, username: null })).toBeNull()
    expect(pickIdentityName({})).toBeNull()
    expect(pickIdentityName(null)).toBeNull()
    expect(pickIdentityName(undefined)).toBeNull()
  })

  it('折成一行、去掉控制字符、截到 48 字(与引擎的上限一致)', () => {
    expect(pickIdentityName({ displayName: 'A\nB\tC' })).toBe('A B C')
    expect(pickIdentityName({ displayName: 'x'.repeat(100) })).toHaveLength(48)
    expect(pickIdentityName({ displayName: '\u0000\u0007ok' })).toBe('ok')
  })

  it('连续空白折成一个空格(含全角空格、不换行空格)', () => {
    expect(pickIdentityName({ displayName: 'Ada   Lovelace' })).toBe('Ada Lovelace')
    expect(pickIdentityName({ displayName: 'Ada\u3000\u3000Lovelace' })).toBe('Ada Lovelace')
    expect(pickIdentityName({ displayName: 'Ada\u00a0\u00a0 Lovelace' })).toBe('Ada Lovelace')
    expect(pickIdentityName({ displayName: '汤  显  鑫' })).toBe('汤 显 鑫')
  })

  it('非字符串一律忽略', () => {
    expect(pickIdentityName({ displayName: 42 as unknown as string, username: 'u' })).toBe('u')
  })
})

describe('identity cache', () => {
  it('写入后能读回', () => {
    const s = memoryStorage()
    writeCachedIdentity(s, '汤显鑫')
    expect(readCachedIdentity(s)).toBe('汤显鑫')
  })

  it('没有缓存 → null', () => {
    expect(readCachedIdentity(memoryStorage())).toBeNull()
    expect(readCachedIdentity(undefined)).toBeNull()
  })

  it('缓存里是脏数据(空串 / 超长 / 控制字符)时清洗,而不是原样信任', () => {
    expect(readCachedIdentity(memoryStorage({ [IDENTITY_STORAGE_KEY]: '' }))).toBeNull()
    expect(readCachedIdentity(memoryStorage({ [IDENTITY_STORAGE_KEY]: '   ' }))).toBeNull()
    expect(readCachedIdentity(memoryStorage({ [IDENTITY_STORAGE_KEY]: 'a\nb' }))).toBe('a b')
    expect(readCachedIdentity(memoryStorage({ [IDENTITY_STORAGE_KEY]: 'y'.repeat(80) }))).toHaveLength(48)
  })

  it('空名字不覆盖已有缓存(未登录 / 登出时别把上次的名字抹掉)', () => {
    const s = memoryStorage()
    writeCachedIdentity(s, '汤显鑫')
    writeCachedIdentity(s, null)
    writeCachedIdentity(s, '   ')
    expect(readCachedIdentity(s)).toBe('汤显鑫')
  })

  it('storage 抛错不抛出', () => {
    const boom: StorageLike = {
      getItem: () => {
        throw new Error('x')
      },
      setItem: () => {
        throw new Error('x')
      },
    }
    expect(readCachedIdentity(boom)).toBeNull()
    expect(() => writeCachedIdentity(boom, 'a')).not.toThrow()
  })

  it('兜底名字是非空字符串', () => {
    expect(FALLBACK_IDENTITY.length).toBeGreaterThan(0)
  })
})

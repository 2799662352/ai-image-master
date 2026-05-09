import { describe, it, expect } from 'vitest'
import { stripNullDeep } from '../mcpConfigSanitizer'

describe('stripNullDeep', () => {
  it('drops null fields from an object', () => {
    expect(stripNullDeep({ a: 1, b: null, c: 'x' })).toEqual({ a: 1, c: 'x' })
  })

  it('drops undefined fields too', () => {
    expect(stripNullDeep({ a: 1, b: undefined as unknown as number })).toEqual({ a: 1 })
  })

  it('drops null inside nested objects', () => {
    expect(
      stripNullDeep({
        github: { command: 'docker', tool_timeout_sec: null, env: { TOKEN: 'x', UNUSED: null } },
      }),
    ).toEqual({
      github: { command: 'docker', env: { TOKEN: 'x' } },
    })
  })

  it('preserves booleans, zeros, and empty strings (TOML accepts those)', () => {
    expect(stripNullDeep({ enabled: false, count: 0, name: '' })).toEqual({
      enabled: false,
      count: 0,
      name: '',
    })
  })

  it('filters null elements from arrays but keeps the rest', () => {
    expect(stripNullDeep({ args: ['run', null, '-i', undefined, '--rm'] as unknown[] })).toEqual({
      args: ['run', '-i', '--rm'],
    })
  })

  it('returns primitives unchanged', () => {
    expect(stripNullDeep('hello')).toBe('hello')
    expect(stripNullDeep(42)).toBe(42)
    expect(stripNullDeep(true)).toBe(true)
  })

  it('returns null for top-level null (caller decides what to do)', () => {
    expect(stripNullDeep(null)).toBe(null)
  })
})

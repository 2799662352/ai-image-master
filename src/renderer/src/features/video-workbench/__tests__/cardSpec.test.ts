import { describe, expect, it } from 'vitest'
import { createId } from '../cardSpec'

describe('createId · 短 id', () => {
  it('10 位 base36:比 UUID(36 位)短 26 字符,一次 status 回 20 张卡就省半千 token', () => {
    const id = createId()
    expect(id).toMatch(/^[0-9a-z]{10}$/)
  })

  it('一万次不撞', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 10_000; i += 1) seen.add(createId())
    expect(seen.size).toBe(10_000)
  })
})

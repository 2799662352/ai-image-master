import { describe, it, expect } from 'vitest'

describe('Storyboard regex fallback patterns', () => {
  it('scene regex should match complete nested JSON with greedy quantifier', () => {
    const rawText = '分析结果: {"d": "A→B→C", "cap": "test", "env": "室内|暖光", "bgm": "layer1", "timeline": [{"id": "S1", "t": "0-3s", "dur": "3s", "tempo": "slow", "trans": "cut"}]}'
    const match = rawText.match(/\{[\s\S]*"d"\s*:[\s\S]*\}/)
    expect(match).not.toBeNull()
    const parsed = JSON.parse(match![0])
    expect(parsed.d).toBe('A→B→C')
    expect(parsed.timeline).toHaveLength(1)
    expect(parsed.timeline[0].id).toBe('S1')
  })

  it('lazy scene regex truncates nested JSON (demonstrates the bug)', () => {
    const rawText = '分析结果: {"d": "A→B→C", "cap": "test", "env": "室内", "bgm": "layer1", "timeline": [{"id": "S1", "t": "0-3s", "dur": "3s", "tempo": "slow", "trans": "cut"}]}'
    const match = rawText.match(/\{[\s\S]*?"d"\s*:[\s\S]*?\}/)
    expect(() => {
      const parsed = JSON.parse(match![0])
      expect(parsed.timeline).toBeDefined()
    }).toThrow()
  })

  it('objs regex should match complete array JSON with greedy quantifier', () => {
    const rawText = '提取结果: {"objs": [{"n": "Alice", "f": "blonde", "t": "hair anchor"}, {"n": "Bob", "f": "dark", "t": "scar anchor"}]}'
    const match = rawText.match(/\{[\s\S]*"objs"\s*:\s*\[[\s\S]*\][\s\S]*\}/)
    expect(match).not.toBeNull()
    const parsed = JSON.parse(match![0])
    expect(parsed.objs).toHaveLength(2)
    expect(parsed.objs[1].n).toBe('Bob')
  })

  it('seq regex should match complete shot array with greedy quantifier', () => {
    const rawText = '{"seq": [{"id": "S1", "desc": "test1"}, {"id": "S2", "desc": "test2"}], "cont": "anchor", "notes": "ok"}'
    const match = rawText.match(/\{[\s\S]*"seq"\s*:\s*\[[\s\S]*\][\s\S]*\}/)
    expect(match).not.toBeNull()
    const parsed = JSON.parse(match![0])
    expect(parsed.seq).toHaveLength(2)
    expect(parsed.cont).toBe('anchor')
  })
})

describe('unwrapScene helper', () => {
  function unwrapScene(data: any): any {
    if (data?.scene && typeof data.scene === 'object' && typeof data.scene.d === 'string') return data.scene
    return data
  }

  it('returns scene data when nested inside scene key', () => {
    const wrapped = { scene: { d: 'A→B→C', cap: 'test', env: 'outdoor' }, objs: [{ n: 'Alice' }] }
    const result = unwrapScene(wrapped)
    expect(result.d).toBe('A→B→C')
    expect(result.cap).toBe('test')
  })

  it('returns data as-is when already flat', () => {
    const flat = { d: 'A→B→C', cap: 'test', env: 'outdoor' }
    const result = unwrapScene(flat)
    expect(result.d).toBe('A→B→C')
  })

  it('returns data as-is when scene key has no d field', () => {
    const weird = { scene: { something: 'else' }, d: 'root' }
    const result = unwrapScene(weird)
    expect(result.d).toBe('root')
  })

  it('returns null/undefined as-is', () => {
    expect(unwrapScene(null)).toBeNull()
    expect(unwrapScene(undefined)).toBeUndefined()
  })
})

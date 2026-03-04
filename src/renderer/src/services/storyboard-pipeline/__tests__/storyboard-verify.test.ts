import { describe, expect, it } from 'vitest'
import { storyboardCodeVerify } from '../storyboard-verify'

describe('storyboardCodeVerify', () => {
  const makeState = (overrides: Record<string, unknown> = {}) => ({
    scene: { d: 'A→B→C', cap: 'test', env: 'outdoor', bgm: 'layer1', timeline: [{ id: 'S1', t: '0-3s', dur: '3s', tempo: 'slow', trans: 'cut' }] },
    objs: [{ n: 'Alice', f: 'blonde', s: 'fg|L1/3|Z1', p: 'artic', t: 'blonde hair', tc: '', act: 'walk', fx: null, motive: 'explore', a: 'wide', m: 'head:pan-R10|L' }],
    seq: [{ id: 'S1', desc: 'Alice walks forward' }],
    cont: 'S1-S2: blonde hair anchor',
    notes: 'OK',
    ...overrides,
  })

  it('should return score 10 for valid state', () => {
    const result = storyboardCodeVerify(makeState() as any)
    expect(result.score).toBe(10)
    expect(result.ok).toBe(true)
  })

  it('should detect missing scene', () => {
    const result = storyboardCodeVerify(makeState({ scene: null }) as any)
    expect(result.score).toBeLessThan(10)
    expect(result.issues.some(i => i.includes('scene'))).toBe(true)
  })

  it('should detect empty seq', () => {
    const result = storyboardCodeVerify(makeState({ seq: [] }) as any)
    expect(result.score).toBeLessThan(10)
    expect(result.issues.some(i => i.includes('shot'))).toBe(true)
  })

  it('should detect empty objs', () => {
    const result = storyboardCodeVerify(makeState({ objs: [] }) as any)
    expect(result.score).toBeLessThan(10)
  })

  it('should detect missing continuity', () => {
    const result = storyboardCodeVerify(makeState({ cont: '' }) as any)
    expect(result.issues.some(i => i.includes('continuity') || i.includes('cont'))).toBe(true)
  })

  it('should handle null gracefully', () => {
    const result = storyboardCodeVerify({ scene: null, objs: [], seq: [], cont: '', notes: '' } as any)
    expect(result.ok).toBe(false)
  })
})

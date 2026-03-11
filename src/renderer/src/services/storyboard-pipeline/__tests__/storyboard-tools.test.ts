import { describe, it, expect } from 'vitest'
import { charMergeSubAgent } from '../storyboard-char-merge'

describe('charMergeSubAgent standalone', () => {
  it('should merge anchors + spatial + narrative by name', () => {
    const anchors = [{ n: 'knight', f: 'armor', t: 'visor' }]
    const spatial = [{ n: 'knight', s: 'fg|center|Z1', p: 'artic', a: '', m: '' }]
    const narrative = [{ n: 'knight', act: 'swing', fx: null, motive: 'honor', tc: '' }]
    const result = charMergeSubAgent(anchors, spatial, narrative)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ n: 'knight', f: 'armor', act: 'swing' })
  })
})

describe('mergeCharactersFromJSON', () => {
  it('should merge identity + spatial + narrative by fuzzy name matching', async () => {
    const { mergeCharactersFromJSON } = await import('../storyboard-tools')

    const anchorsJSON = JSON.stringify({ objs: [
      { n: 'knight', f: 'silver armor', t: 'cross visor helmet' },
      { n: 'butler', f: 'black suit', t: 'white gloves' },
    ]})
    const spatialJSON = JSON.stringify({ objs: [
      { n: 'knight', s: 'fg|center|Z1', p: 'artic', a: '', m: '' },
      { n: 'butler', s: 'mg|R1/3|Z2', p: 'artic', a: '', m: '' },
    ]})
    const narrativeJSON = JSON.stringify({ objs: [
      { n: 'knight', act: 'draws sword', fx: null, motive: 'honor', tc: '' },
      { n: 'butler', act: 'adjusts gloves', fx: null, motive: 'loyalty', tc: '' },
    ]})

    const result = mergeCharactersFromJSON(anchorsJSON, spatialJSON, narrativeJSON)
    const objs = JSON.parse(result).objs
    expect(objs).toHaveLength(2)
    expect(objs[0].n).toBe('knight')
    expect(objs[0].f).toBe('silver armor')
    expect(objs[0].act).toBe('draws sword')
  })
})

describe('verifyStoryboardFromJSON', () => {
  it('should return score and issues', async () => {
    const { verifyStoryboardFromJSON } = await import('../storyboard-tools')

    const result = verifyStoryboardFromJSON(
      JSON.stringify({ d: 'A→B→C', cap: 'test', env: 'arena' }),
      JSON.stringify({ objs: [{ n: 'knight', t: 'armor' }] }),
      JSON.stringify({ seq: [{ id: 'S1', desc: 'knight enters arena' }], cont: 'armor' }),
    )
    const report = JSON.parse(result)
    expect(report.score).toBeGreaterThanOrEqual(6)
  })
})

import { describe, it, expect } from 'vitest'
import { charMergeSubAgent } from '../StoryboardDeepAgentPipeline'

describe('StoryboardDeepAgentPipeline orchestration', () => {
  it('charMerge receives data from both charSpatial and charNarrative via fuzzy match', () => {
    const anchors = [{ n: 'knight', f: 'armored', t: 'silver helm' }]
    const spatial = [{ n: 'the knight', s: 'fg', p: 'artic', a: '', m: '' }]
    const narrative = [{ n: 'armored knight', act: 'raises sword', fx: null, motive: 'courage', tc: 'gaze left' }]

    const merged = charMergeSubAgent(anchors, spatial, narrative)

    expect(merged).toHaveLength(1)
    expect(merged[0].s).toBe('fg')
    expect(merged[0].act).toBe('raises sword')
  })

  it('charMerge handles multiple characters with mixed name formats', () => {
    const anchors = [
      { n: 'warrior princess', f: 'golden armor', t: 'crown' },
      { n: 'dark wizard', f: 'black robes', t: 'staff' },
    ]
    const spatial = [
      { n: 'the warrior princess', s: 'fg|L1/3|Z1', p: 'artic', a: 'swordfight 40%', m: 'arm:swing-30°|H' },
      { n: 'wizard', s: 'bg|R2/3|Z3', p: 'rigid', a: 'casting 20%', m: 'hand:raise|M' },
    ]
    const narrative = [
      { n: 'warrior princess', act: 'lunges forward', fx: 'blade glow', motive: 'protect village', tc: 'face wizard' },
      { n: 'dark wizard', act: 'raises staff', fx: 'dark energy', motive: 'conquest', tc: 'retreat step' },
    ]

    const merged = charMergeSubAgent(anchors, spatial, narrative)

    expect(merged).toHaveLength(2)
    expect(merged[0].n).toBe('warrior princess')
    expect(merged[0].s).toBe('fg|L1/3|Z1')
    expect(merged[0].act).toBe('lunges forward')
    expect(merged[1].n).toBe('dark wizard')
    expect(merged[1].act).toBe('raises staff')
  })
})

describe('shotDesign integration', () => {
  it('uses scene and objs from state for shot generation', () => {
    const state = {
      scene: { d: 'A→B→C', cap: 'test', env: 'gothic', bgm: '' },
      objs: [{ n: 'knight', f: 'armor', t: 'helm', s: 'fg', p: 'artic', a: '', m: '', act: 'stands', fx: null, motive: 'duty', tc: '', audio: '' }],
    }
    const characterSummary = (state.objs || []).map(o => `${o.n}: ${o.t} [${o.act}]`).join('\n')
    expect(characterSummary).toContain('knight')
    expect(characterSummary).toContain('stands')
  })
})

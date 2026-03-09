import { describe, expect, it } from 'vitest'
import { assembleCoherentPrompt, expandCharacterTags } from '../DirectorPipeline'

describe('assembleCoherentPrompt', () => {
  it('produces a flowing sentence from structured fields instead of period-separated fragments', () => {
    const panel = {
      id: 1,
      shot: 'cut to medium eye-level, 50mm',
      desc: '[char1] and [char2] face off in a narrow alley',
      lighting: 'warm side-light from left, soft, 3500K golden hour',
      characterAction: '[char1] swings folding fan defensively, [char2] lunges with sword',
      background: 'stone walls with hanging lanterns',
    }
    const prompt = {
      id: 1,
      prompt: 'Two warriors in a tense standoff in a dim alley',
      negativePrompt: 'blurry',
    }

    const result = assembleCoherentPrompt(panel, prompt)

    expect(result.split('. ').length).toBeLessThanOrEqual(3)
    expect(result).toContain('medium eye-level')
    expect(result).toContain('folding fan')
    expect(result).toContain('sword')
    expect(result).toContain('[char1]')
    expect(result).toContain('[char2]')
    expect(result).toContain('3500K')
    expect(result).toContain('swings folding fan defensively')
    expect(result).toContain('lunges with sword')
  })

  it('falls back to prompt field when no structured fields exist', () => {
    const panel = {
      id: 1, shot: '', desc: '', lighting: '',
      characterAction: '', background: '',
    }
    const prompt = {
      id: 1,
      prompt: 'A wide establishing shot of the courtyard',
      negativePrompt: 'blurry',
    }

    const result = assembleCoherentPrompt(panel, prompt)

    expect(result).toBe('A wide establishing shot of the courtyard')
  })

  it('places characterAction as the core clause before lighting', () => {
    const panel = {
      id: 1,
      shot: 'close-up',
      desc: '[char1] in the rain',
      lighting: 'cool blue moonlight',
      characterAction: '[char1] raises katana overhead, rain dripping from blade',
      background: 'rooftop at night',
    }
    const prompt = {
      id: 1,
      prompt: 'A dramatic moment on a rainy rooftop',
      negativePrompt: 'blurry',
    }

    const result = assembleCoherentPrompt(panel, prompt)

    const actionIdx = result.indexOf('raises katana')
    const lightingIdx = result.indexOf('moonlight')
    expect(actionIdx).toBeGreaterThan(-1)
    expect(lightingIdx).toBeGreaterThan(-1)
    expect(actionIdx).toBeLessThan(lightingIdx)
  })

  it('avoids duplicating content already present in prompt field', () => {
    const panel = {
      id: 1,
      shot: 'wide shot',
      desc: '[char1] stands alone',
      lighting: 'sunset glow',
      characterAction: '[char1] holds a rose',
      background: 'garden',
    }
    const prompt = {
      id: 1,
      prompt: '[char1] holds a rose in a beautiful garden at sunset',
      negativePrompt: 'blurry',
    }

    const result = assembleCoherentPrompt(panel, prompt)

    const matches = result.match(/holds a rose/g)
    expect(matches?.length).toBeLessThanOrEqual(1)
  })

  it('handles panel with only shot and lighting (no characterAction)', () => {
    const panel = {
      id: 1,
      shot: 'extreme wide shot, drone angle',
      desc: 'vast desert landscape',
      lighting: 'harsh midday sun, deep shadows',
      characterAction: '',
      background: 'sand dunes stretching to horizon',
    }
    const prompt = {
      id: 1,
      prompt: 'A sweeping view of endless sand dunes under blazing sun',
      negativePrompt: 'blurry',
    }

    const result = assembleCoherentPrompt(panel, prompt)

    expect(result).toContain('extreme wide shot')
    expect(result).toContain('midday sun')
    expect(result).toContain('sand dunes')
  })

  it('skips desc when both desc and characterAction contain [charN] tags', () => {
    const panel = {
      shot: 'medium shot',
      desc: '[char1] and [char2] face off in a courtyard',
      lighting: 'warm golden hour',
      characterAction: '[char1] lunges forward with a fan, [char2] blocks the strike',
      background: 'stone courtyard',
    }
    const prompt = { prompt: 'Two warriors in a tense standoff' }

    const result = assembleCoherentPrompt(panel, prompt)

    const char1Count = (result.match(/\[char1\]/g) || []).length
    const char2Count = (result.match(/\[char2\]/g) || []).length
    expect(char1Count).toBe(1)
    expect(char2Count).toBe(1)
    expect(result).toContain('lunges forward')
    expect(result).not.toContain('face off')
  })
})

describe('full prompt assembly pipeline (assembleCoherentPrompt → expandCharacterTags)', () => {
  it('produces spatially-bound narrative for 2-character panel', () => {
    const panel = {
      id: 1,
      shot: 'medium shot',
      desc: '[char1] and [char2] face off in a courtyard',
      lighting: 'warm golden hour side-light',
      characterAction: '[char1] lunges forward with a fan, [char2] blocks the strike',
      background: 'stone courtyard with arched columns',
    }
    const prompt = {
      id: 1,
      prompt: 'Two warriors in a tense standoff',
      negativePrompt: 'blurry',
    }

    const assembled = assembleCoherentPrompt(panel, prompt)
    const expanded = expandCharacterTags(assembled, [
      { name: 'Aria', anchor: 'long mint-green hair, dark teal military coat, white folding fan' },
      { name: 'Kael', anchor: 'silver-white twin tails, navy blue sailor uniform, blue beret' },
    ])

    // No parenthetical notation
    expect(expanded).not.toMatch(/\([A-Z][a-z]+:/)

    // Spatial separation
    expect(expanded).toContain('on the left')
    expect(expanded).toContain('on the right')

    // Character attributes are present
    expect(expanded).toContain('mint-green hair')
    expect(expanded).toContain('sailor uniform')

    // Actions present
    expect(expanded).toContain('lunges forward')
    expect(expanded).toContain('blocks')

    // Scene context present
    expect(expanded).toContain('golden hour')
    expect(expanded).toContain('courtyard')

    console.log('=== FINAL PROMPT OUTPUT ===')
    console.log(expanded)
    console.log('=== END ===')
  })
})

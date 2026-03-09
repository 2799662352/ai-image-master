import { describe, expect, it } from 'vitest'
import { assembleCoherentPrompt, expandCharacterTags, buildNaturalDescriptor, buildReferenceImageFidelityMandate, buildCharacterIdentityLock, sortCharacters, buildAnchorFromFields } from '../DirectorPipeline'

describe('buildNaturalDescriptor', () => {
  it('produces natural language with face + outfit + markers', () => {
    const result = buildNaturalDescriptor({
      face: 'long mint-green hair, green eyes',
      outfit: 'dark teal military coat',
      markers: 'white folding fan',
    })
    expect(result).toContain('a figure with long mint-green hair')
    expect(result).toContain('wearing dark teal military coat')
    expect(result).toContain('carrying white folding fan')
    expect(result).not.toContain('(')
    expect(result).not.toContain(')')
  })

  it('uses face and outfit fields correctly', () => {
    const result = buildNaturalDescriptor({
      face: 'round face, green eyes, long mint-green hair',
      outfit: 'dark teal military coat with gold buttons',
      markers: 'white folding fan',
    })
    expect(result).toContain('a figure with round face')
    expect(result).toContain('wearing dark teal military coat')
    expect(result).toContain('carrying white folding fan')
    expect(result).not.toContain('(')
  })

  it('handles face-only input without outfit', () => {
    const result = buildNaturalDescriptor({ face: 'red hat, blue eyes' })
    expect(result).toContain('a figure with red hat')
    expect(result).not.toContain('wearing')
  })

  it('returns "a figure" for empty input', () => {
    const result = buildNaturalDescriptor({})
    expect(result).toBe('a figure')
  })

  it('handles face + outfit without markers', () => {
    const result = buildNaturalDescriptor({ face: 'silver hair', outfit: 'blue cape' })
    expect(result).toBe('a figure with silver hair, wearing blue cape')
  })
})

describe('assembleCoherentPrompt', () => {
  it('produces structured sections: shot, characters, scene context', () => {
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

  it('places characterAction before lighting (scene context)', () => {
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

  it('separates scene context from character action with period + newline', () => {
    const panel = {
      shot: 'medium shot',
      desc: '[char1] and [char2] clash',
      lighting: 'warm golden hour side-light',
      characterAction: '[char1] lunges with fan, [char2] blocks defensively',
      background: 'stone courtyard with arched columns',
    }
    const prompt = { prompt: 'Two warriors face off' }

    const result = assembleCoherentPrompt(panel, prompt)

    const bgIdx = result.indexOf('stone courtyard')
    const actionIdx = result.indexOf('lunges with fan')
    expect(bgIdx).toBeGreaterThan(actionIdx)
    expect(result).toContain('.\n')
  })
})

describe('full prompt assembly pipeline (assembleCoherentPrompt → expandCharacterTags)', () => {
  it('produces natural-language character descriptions with foreground spatial anchors', () => {
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
      { name: 'Aria', face: 'long mint-green hair', outfit: 'dark teal military coat', markers: 'white folding fan' },
      { name: 'Kael', face: 'silver-white twin tails', outfit: 'navy blue sailor uniform, blue beret' },
    ])

    // No parenthetical notation
    expect(expanded).not.toMatch(/\([A-Z][a-z]+:/)
    expect(expanded).not.toMatch(/\(long mint/)
    expect(expanded).not.toMatch(/\(silver-white/)

    // Natural language descriptors
    expect(expanded).toContain('a figure with long mint-green hair')
    expect(expanded).toContain('wearing')
    expect(expanded).toContain('a figure with silver-white twin tails')

    // Foreground spatial separation
    expect(expanded).toContain('in the foreground left')
    expect(expanded).toContain('in the foreground right')

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

  it('uses structured fields for richer output when available', () => {
    const assembled = '[char1] runs through the gate.'
    const expanded = expandCharacterTags(assembled, [
      {
        name: 'Aria',
        face: 'round face, green eyes, long mint-green hair',
        outfit: 'dark teal military coat with gold buttons',
        markers: 'white folding fan',
      },
    ])

    expect(expanded).toContain('a figure with round face')
    expect(expanded).toContain('wearing dark teal military coat')
    expect(expanded).toContain('carrying white folding fan')
    expect(expanded).toContain('runs through the gate')
    expect(expanded).not.toContain('(')
  })
})

describe('schema-C downstream compatibility', () => {
  const chars = [
    { name: 'Aria', face: 'green eyes, mint-green hair', outfit: 'dark teal coat', markers: 'white fan' },
    { name: 'Kael', face: 'sharp eyes, silver twin tails', outfit: 'navy sailor uniform' },
  ]

  it('sortCharacters works without anchor field', () => {
    const sorted = sortCharacters(chars)
    expect(sorted).toHaveLength(2)
    expect(sorted[0].name).toBe('Aria')
    expect(sorted[1].name).toBe('Kael')
  })

  it('buildCharacterIdentityLock works with face+outfit (no anchor)', () => {
    const lock = buildCharacterIdentityLock(chars)
    expect(lock).toContain('mint-green hair')
    expect(lock).toContain('navy sailor uniform')
    expect(lock).toContain('white fan')
    expect(lock).toContain('Character Identity Lock')
  })

  it('buildAnchorFromFields joins face+outfit+markers', () => {
    expect(buildAnchorFromFields({ face: 'green eyes', outfit: 'teal coat', markers: 'fan' }))
      .toBe('green eyes. teal coat. fan')
  })

  it('buildAnchorFromFields handles missing markers', () => {
    expect(buildAnchorFromFields({ face: 'green eyes', outfit: 'teal coat' }))
      .toBe('green eyes. teal coat')
  })

  it('buildAnchorFromFields returns fallback for empty input', () => {
    expect(buildAnchorFromFields({})).toBe('(no anchor)')
  })
})

describe('buildReferenceImageFidelityMandate', () => {
  it('returns analysis-tier mandate for extraction passes', () => {
    const result = buildReferenceImageFidelityMandate('analysis')
    expect(result).toContain('REFERENCE IMAGE FIDELITY')
    expect(result).toContain('SINGLE SOURCE OF TRUTH')
    expect(result).toContain('DO NOT hallucinate')
  })

  it('returns design-tier mandate for design passes', () => {
    const result = buildReferenceImageFidelityMandate('design')
    expect(result).toContain('REFERENCE IMAGE FIDELITY')
    expect(result).toContain('MUST reproduce')
    expect(result).toContain('character appearance')
  })

  it('returns verify-tier mandate for verification passes', () => {
    const result = buildReferenceImageFidelityMandate('verify')
    expect(result).toContain('REFERENCE IMAGE FIDELITY')
    expect(result).toContain('ground truth')
    expect(result).toContain('deduction')
  })
})

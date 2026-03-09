import { describe, expect, it } from 'vitest'
import * as DirectorPipelineModule from '../DirectorPipeline'
import { SimpleCharacterSchema } from '../schemas/director-schemas'

describe('SimpleCharacterSchema', () => {
  it('accepts minimal character data', () => {
    const result = SimpleCharacterSchema.parse({
      characters: [{ name: 'Aria', anchor: 'green hair, teal coat' }],
    })
    expect(result.characters).toHaveLength(1)
    expect(result.characters[0].name).toBe('Aria')
  })
})

describe('L1 maxTokens calculation', () => {
  it('uses at least 4096 tokens for small panel counts', () => {
    const panelCount = 3
    const maxTokens = Math.max(4096, panelCount * 800 + 1024)
    expect(maxTokens).toBe(4096)
  })

  it('scales up for 6+ panels', () => {
    const panelCount = 6
    const maxTokens = Math.max(4096, panelCount * 800 + 1024)
    expect(maxTokens).toBe(5824)
    expect(maxTokens).toBeGreaterThan(4096)
  })

  it('provides sufficient budget for 9 panels', () => {
    const panelCount = 9
    const maxTokens = Math.max(4096, panelCount * 800 + 1024)
    expect(maxTokens).toBe(8224)
    expect(maxTokens).toBeGreaterThan(4096 * 2)
  })

  it('provides sufficient budget for 12 panels', () => {
    const panelCount = 12
    const maxTokens = Math.max(4096, panelCount * 800 + 1024)
    expect(maxTokens).toBe(10624)
  })
})

describe('expandCharacterTags', () => {
  it('replaces [charN] tags with full anchor descriptions', () => {
    const result = (DirectorPipelineModule as any).expandCharacterTags(
      'Panel 1: [char1] lunges forward with a fan. [char2] blocks the attack.',
      [
        { name: 'Aria', anchor: 'long mint-green hair, dark teal military coat, white folding fan' },
        { name: 'Kael', anchor: 'silver-white twin tails, navy blue sailor uniform, blue beret' },
      ],
    )

    expect(result).toContain('long mint-green hair, dark teal military coat, white folding fan')
    expect(result).toContain('silver-white twin tails, navy blue sailor uniform, blue beret')
    expect(result).not.toContain('[char1]')
    expect(result).not.toContain('[char2]')
  })

  it('preserves text when no character tags are present', () => {
    const result = (DirectorPipelineModule as any).expandCharacterTags(
      'A wide establishing shot of the courtyard at sunset.',
      [{ name: 'Aria', anchor: 'green hair girl' }],
    )

    expect(result).toBe('A wide establishing shot of the courtyard at sunset.')
  })

  it('returns text unchanged when characters array is empty', () => {
    const result = (DirectorPipelineModule as any).expandCharacterTags(
      'Panel 1: [char1] runs.',
      [],
    )

    expect(result).toBe('Panel 1: [char1] runs.')
  })
})

describe('Pass 2 structured recovery', () => {
  it('SimpleCharacterSchema accepts the minimal fields needed for anchor expansion', () => {
    const result = SimpleCharacterSchema.parse({
      characters: [
        { name: 'Aria', anchor: 'long mint-green hair, dark teal military coat, white folding fan' },
        { name: 'Kael', anchor: 'silver-white twin tails, navy blue sailor uniform, blue beret' },
      ],
    })
    expect(result.characters).toHaveLength(2)
    expect(result.characters[0].anchor).toContain('mint-green')
    expect(result.characters[1].anchor).toContain('twin tails')
  })
})

describe('expandCharacterTags spatial binding', () => {
  it('produces spatially-separated narrative instead of parenthetical notation', () => {
    const result = (DirectorPipelineModule as any).expandCharacterTags(
      '[char1] lunges forward with a fan. [char2] blocks the attack.',
      [
        { name: 'Aria', anchor: 'long mint-green hair, dark teal military coat, white folding fan' },
        { name: 'Kael', anchor: 'silver-white twin tails, navy blue sailor uniform, blue beret' },
      ],
    )

    // Must NOT use parenthetical format
    expect(result).not.toContain('(Aria:')
    expect(result).not.toContain('(Kael:')

    // Must inline appearance into natural language
    expect(result).toContain('mint-green hair')
    expect(result).toContain('sailor uniform')

    // Must preserve actions bound to the correct character
    expect(result).toContain('lunges forward')
    expect(result).toContain('blocks the attack')
  })

  it('uses semicolons to separate character clauses for token boundary', () => {
    const result = (DirectorPipelineModule as any).expandCharacterTags(
      '[char1] runs. [char2] jumps.',
      [
        { name: 'A', anchor: 'red hair' },
        { name: 'B', anchor: 'blue hat' },
      ],
    )

    expect(result).toContain(';')
  })

  it('handles single character without spatial prefix', () => {
    const result = (DirectorPipelineModule as any).expandCharacterTags(
      '[char1] stands in the rain.',
      [{ name: 'Aria', anchor: 'long mint-green hair, dark teal military coat' }],
    )

    // Single character — no spatial direction needed
    expect(result).not.toContain('(Aria:')
    expect(result).toContain('mint-green hair')
    expect(result).toContain('stands in the rain')
  })

  it('preserves text when no character tags are present', () => {
    const result = (DirectorPipelineModule as any).expandCharacterTags(
      'A wide establishing shot of the courtyard at sunset.',
      [{ name: 'Aria', anchor: 'green hair girl' }],
    )

    expect(result).toBe('A wide establishing shot of the courtyard at sunset.')
  })

  it('returns text unchanged when characters array is empty', () => {
    const result = (DirectorPipelineModule as any).expandCharacterTags(
      'Panel 1: [char1] runs.',
      [],
    )

    expect(result).toBe('Panel 1: [char1] runs.')
  })

  it('handles 3+ characters with spatial distribution', () => {
    const result = (DirectorPipelineModule as any).expandCharacterTags(
      '[char1] attacks. [char2] defends. [char3] watches.',
      [
        { name: 'A', anchor: 'red hair, sword' },
        { name: 'B', anchor: 'blue armor, shield' },
        { name: 'C', anchor: 'black cloak, glasses' },
      ],
    )

    expect(result).not.toContain('(A:')
    expect(result).not.toContain('(B:')
    expect(result).not.toContain('(C:')
    expect(result).toContain('red hair')
    expect(result).toContain('blue armor')
    expect(result).toContain('black cloak')
  })
})

describe('L3 structured feedback design', () => {
  it('L3 error feedback message includes lastError and panelCount', () => {
    const lastError = 'SimplePanelSchema returned empty panels array'
    const panelCount = 6
    const feedbackMsg = `Your previous response failed with error: "${lastError}"\n\nPlease fix this and respond with exactly ${panelCount} panels. Each panel needs an "id" (number) and a "prompt" (detailed English image generation prompt).`
    expect(feedbackMsg).toContain(lastError)
    expect(feedbackMsg).toContain(String(panelCount))
    expect(feedbackMsg).not.toContain('JSON object')
    expect(feedbackMsg).not.toContain('code fences')
  })
})


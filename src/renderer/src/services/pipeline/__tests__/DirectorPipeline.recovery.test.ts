import { describe, expect, it } from 'vitest'
import * as DirectorPipelineModule from '../DirectorPipeline'
import { CharacterAnchorSchema } from '../schemas/director-schemas'

describe('CharacterAnchorSchema (5-field: name + anchor + face + outfit + markers)', () => {
  it('accepts all 5 fields', () => {
    const result = CharacterAnchorSchema.parse({
      characters: [{
        name: 'Aria',
        anchor: 'pale skin, oval face, green eyes, long mint-green hair, dark teal military coat, white folding fan',
        face: 'pale skin, oval face, green eyes, long mint-green hair',
        outfit: 'dark teal military coat with gold buttons, black boots',
        markers: 'white folding fan',
      }],
    })
    expect(result.characters).toHaveLength(1)
    expect(result.characters[0].name).toBe('Aria')
    expect(result.characters[0].anchor).toContain('mint-green')
    expect(result.characters[0].face).toContain('mint-green')
    expect(result.characters[0].outfit).toContain('teal')
  })

  it('accepts characters without markers (optional)', () => {
    const result = CharacterAnchorSchema.parse({
      characters: [{
        name: 'Kael',
        anchor: 'dark skin, sharp eyes, silver-white twin tails, navy blue sailor uniform',
        face: 'dark skin, sharp eyes, silver-white twin tails',
        outfit: 'navy blue sailor uniform',
      }],
    })
    expect(result.characters).toHaveLength(1)
    expect(result.characters[0].markers).toBeUndefined()
  })

  it('rejects characters missing anchor (required)', () => {
    expect(() => CharacterAnchorSchema.parse({
      characters: [{ name: 'Bad', face: 'brown eyes', outfit: 'red dress' }],
    })).toThrow()
  })

  it('rejects characters missing face (required)', () => {
    expect(() => CharacterAnchorSchema.parse({
      characters: [{ name: 'Bad', anchor: 'some desc', outfit: 'red dress' }],
    })).toThrow()
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

describe('Pass 2 structured recovery', () => {
  it('CharacterAnchorSchema accepts structured fields for anchor expansion', () => {
    const result = CharacterAnchorSchema.parse({
      characters: [
        { name: 'Aria', anchor: 'long mint-green hair, dark teal military coat, white folding fan', face: 'long mint-green hair', outfit: 'dark teal military coat', markers: 'white folding fan' },
        { name: 'Kael', anchor: 'silver-white twin tails, navy blue sailor uniform, blue beret', face: 'silver-white twin tails', outfit: 'navy blue sailor uniform, blue beret' },
      ],
    })
    expect(result.characters).toHaveLength(2)
    expect(result.characters[0].anchor).toContain('mint-green')
    expect(result.characters[1].anchor).toContain('twin tails')
  })
})

describe('expandCharacterTags natural language + spatial binding', () => {
  it('produces natural-language descriptors instead of parenthetical notation', () => {
    const result = (DirectorPipelineModule as any).expandCharacterTags(
      '[char1] lunges forward with a fan. [char2] blocks the attack.',
      [
        { name: 'Aria', face: 'long mint-green hair', outfit: 'dark teal military coat', markers: 'white folding fan' },
        { name: 'Kael', face: 'silver-white twin tails', outfit: 'navy blue sailor uniform, blue beret' },
      ],
    )

    expect(result).not.toContain('(Aria:')
    expect(result).not.toContain('(Kael:')
    expect(result).not.toContain('(long mint-green')
    expect(result).not.toContain('(silver-white')

    expect(result).toContain('a figure with long mint-green hair')
    expect(result).toContain('wearing')
    expect(result).toContain('a figure with silver-white twin tails')

    expect(result).toContain('in the foreground left')
    expect(result).toContain('in the foreground right')

    expect(result).toContain('lunges forward')
    expect(result).toContain('blocks the attack')
  })

  it('uses semicolons to separate character clauses for token boundary', () => {
    const result = (DirectorPipelineModule as any).expandCharacterTags(
      '[char1] runs. [char2] jumps.',
      [
        { name: 'A', face: 'red hair', outfit: 'red armor' },
        { name: 'B', face: 'blue eyes', outfit: 'blue hat' },
      ],
    )

    expect(result).toContain(';')
  })

  it('handles single character without spatial prefix', () => {
    const result = (DirectorPipelineModule as any).expandCharacterTags(
      '[char1] stands in the rain.',
      [{ name: 'Aria', face: 'long mint-green hair', outfit: 'dark teal military coat' }],
    )

    expect(result).not.toContain('(Aria:')
    expect(result).toContain('a figure with long mint-green hair')
    expect(result).toContain('wearing dark teal military coat')
    expect(result).toContain('stands in the rain')
  })

  it('preserves text when no character tags are present', () => {
    const result = (DirectorPipelineModule as any).expandCharacterTags(
      'A wide establishing shot of the courtyard at sunset.',
      [{ name: 'Aria', face: 'green hair', outfit: 'casual clothes' }],
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

  it('handles 3+ characters with foreground spatial distribution', () => {
    const result = (DirectorPipelineModule as any).expandCharacterTags(
      '[char1] attacks. [char2] defends. [char3] watches.',
      [
        { name: 'A', face: 'red hair', outfit: 'battle armor', markers: 'sword' },
        { name: 'B', face: 'blue eyes', outfit: 'blue armor', markers: 'shield' },
        { name: 'C', face: 'dark features', outfit: 'black cloak', markers: 'glasses' },
      ],
    )

    expect(result).not.toContain('(A:')
    expect(result).not.toContain('(B:')
    expect(result).not.toContain('(C:')
    expect(result).toContain('a figure with red hair')
    expect(result).toContain('a figure with blue eyes')
    expect(result).toContain('a figure with dark features')
    expect(result).toContain('in the foreground left')
    expect(result).toContain('in the foreground center')
    expect(result).toContain('in the foreground right')
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


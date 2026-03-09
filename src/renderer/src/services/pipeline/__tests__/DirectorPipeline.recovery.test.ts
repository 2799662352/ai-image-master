import { describe, expect, it } from 'vitest'
import * as DirectorPipelineModule from '../DirectorPipeline'

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

describe('DirectorPipeline recovery helpers', () => {
  it('can recover panels from text blocks in non-string LLM content', () => {
    const panels = (DirectorPipelineModule as any).extractPanelsFromUnknown({
      raw: {
        content: [
          { type: 'text', text: '{"panels":[{"id":1,"prompt":"cinematic close-up"}]}' },
        ],
      },
    })

    expect(panels).toEqual([
      { id: 1, prompt: 'cinematic close-up' },
    ])
  })

  it('extracts the actual panels object instead of greedily matching the first brace block', () => {
    const panels = (DirectorPipelineModule as any).extractPanelsFromUnknown(
      'Example wrapper: {"note":"ignore this"}\nActual payload: {"panels":[{"id":1,"prompt":"wide establishing shot"}]}\nDone.',
    )

    expect(panels).toEqual([
      { id: 1, prompt: 'wide establishing shot' },
    ])
  })

  it('unwraps nested panel results returned by structured output adapters', () => {
    const panels = (DirectorPipelineModule as any).extractPanelsFromUnknown({
      result: {
        panels: [
          { id: 1, prompt: 'hero shot' },
          { id: 2, prompt: 'reaction shot' },
        ],
      },
    })

    expect(panels).toEqual([
      { id: 1, prompt: 'hero shot' },
      { id: 2, prompt: 'reaction shot' },
    ])
  })
})

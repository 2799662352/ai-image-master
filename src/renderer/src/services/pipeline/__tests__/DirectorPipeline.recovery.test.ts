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

describe('extractIndividualPanels', () => {
  const extractIndividualPanels = DirectorPipelineModule.extractIndividualPanels

  it('extracts complete panel objects from truncated JSON', () => {
    const truncatedJson = `{"panels":[{"id":1,"shot":"wide shot","desc":"scene","lighting":"warm","characterAction":"[char1] walks","background":"city","prompt":"A wide shot of a city","negativePrompt":"blurry"},{"id":2,"shot":"close-up","desc":"face","lighting":"soft","characterAction":"[char1] smiles","background":"park","prompt":"A close-up in a park","negativePrompt":"noise"},{"id":3,"shot":"medium","desc":"duo`
    const panels = extractIndividualPanels(truncatedJson)
    expect(panels.length).toBe(2)
    expect(panels[0].id).toBe(1)
    expect(panels[1].id).toBe(2)
  })

  it('returns empty array for content with no valid panels', () => {
    expect(extractIndividualPanels('random text without panels')).toEqual([])
    expect(extractIndividualPanels('')).toEqual([])
  })

  it('extracts panels with just id and prompt fields', () => {
    const text = `[{"id":1,"prompt":"dramatic scene"},{"id":2,"prompt":"action shot"},{"id":3,"prom`
    const panels = extractIndividualPanels(text)
    expect(panels.length).toBe(2)
    expect(panels[0]).toEqual({ id: 1, prompt: 'dramatic scene' })
    expect(panels[1]).toEqual({ id: 2, prompt: 'action shot' })
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

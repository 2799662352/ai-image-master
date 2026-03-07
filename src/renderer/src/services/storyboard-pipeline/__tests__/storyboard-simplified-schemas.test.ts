import { describe, it, expect } from 'vitest'
import { z } from 'zod'

describe('Simplified storyboard schemas', () => {
  const SimpleSceneSchema = z.object({
    d: z.string().describe('Narrative arc: A→B→C'),
    cap: z.string().describe('Structured caption'),
    env: z.string().describe('Environment description'),
  })

  const SimpleObjArraySchema = z.object({
    objs: z.array(z.object({
      n: z.string().describe('Character/object name'),
      f: z.string().describe('Appearance features'),
      t: z.string().describe('Cross-shot consistency anchor'),
      act: z.string().describe('Action'),
    })),
  })

  it('SimpleSceneSchema parses minimal scene data', () => {
    const data = { d: 'A→B→C', cap: 'hero-runs-forest', env: 'outdoor|golden hour' }
    const result = SimpleSceneSchema.parse(data)
    expect(result.d).toBe('A→B→C')
  })

  it('SimpleObjArraySchema parses minimal character data', () => {
    const data = {
      objs: [
        { n: 'Alice', f: 'blonde hair, red dress', t: 'blonde hair anchor', act: 'walking' },
      ],
    }
    const result = SimpleObjArraySchema.parse(data)
    expect(result.objs).toHaveLength(1)
    expect(result.objs[0].n).toBe('Alice')
  })

  it('SimpleSceneSchema rejects missing required fields', () => {
    expect(() => SimpleSceneSchema.parse({ d: 'arc' })).toThrow()
  })
})

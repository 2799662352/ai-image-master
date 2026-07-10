import { describe, expect, it } from 'vitest'
import { AGENT_MODELS, resolveModelSelection } from '../models'

describe('Codex model catalog', () => {
  it('includes the GPT-5.6 model names shipped by Codex 0.144', () => {
    const ids = AGENT_MODELS.map((model) => model.id)

    expect(ids).toEqual(expect.arrayContaining([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]))
  })

  it('hides legacy model families below GPT-5.4 from the chat picker', () => {
    const ids = AGENT_MODELS.map((model) => model.id)

    expect(ids.some((id) => /^gpt-5\.[0-3](?:-|$)/.test(id))).toBe(false)
    expect(ids).not.toContain('gpt-5.2')
  })

  it('maps local effort variants to a canonical model plus native effort', () => {
    expect(resolveModelSelection('gpt-5.5-xhigh')).toEqual({
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
    })
    expect(resolveModelSelection('gpt-5.4-low')).toEqual({
      model: 'gpt-5.4',
      reasoningEffort: 'low',
    })
  })

  it('passes unknown provider-specific model slugs through unchanged', () => {
    expect(resolveModelSelection('provider-custom-model')).toEqual({
      model: 'provider-custom-model',
    })
  })
})

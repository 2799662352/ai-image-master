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

  it('uses one unique row per real model slug', () => {
    const ids = AGENT_MODELS.map((model) => model.id)

    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toEqual(expect.arrayContaining([
      'gpt-5.4-low',
      'gpt-5.4-medium',
      'gpt-5.4-high',
      'gpt-5.4-xhigh',
      'gpt-5.5-xhigh',
    ]))
  })

  it('omits the reasoningEffort property for Auto', () => {
    const selection = resolveModelSelection('gpt-5.6-sol', 'auto')

    expect(selection).toEqual({ model: 'gpt-5.6-sol' })
    expect(Object.prototype.hasOwnProperty.call(selection, 'reasoningEffort')).toBe(false)
  })

  it('keeps a concrete Max effort separate from the model slug', () => {
    expect(resolveModelSelection('gpt-5.6-sol', 'max')).toEqual({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'max',
    })
  })

  it('passes unknown provider-specific model slugs through unchanged', () => {
    expect(resolveModelSelection('provider-custom-model', 'auto')).toEqual({
      model: 'provider-custom-model',
    })
  })
})

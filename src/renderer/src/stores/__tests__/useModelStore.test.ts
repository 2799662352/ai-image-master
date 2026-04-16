import { describe, it, expect, beforeEach } from 'vitest'
import { useModelStore } from '../useModelStore'

describe('useModelStore', () => {
  beforeEach(() => {
    useModelStore.setState({ currentModelKey: '', models: {} })
  })

  it('sets models', () => {
    useModelStore.getState().setModels({
      'gpt-4': { name: 'GPT-4', capabilities: {} },
    })
    expect(Object.keys(useModelStore.getState().models)).toHaveLength(1)
  })

  it('switches to a valid model', () => {
    useModelStore.getState().setModels({
      'gpt-4': { name: 'GPT-4', capabilities: {} },
    })
    useModelStore.getState().switchModel('gpt-4')
    expect(useModelStore.getState().currentModelKey).toBe('gpt-4')
  })

  it('rejects invalid model key', () => {
    useModelStore.getState().setModels({
      'gpt-4': { name: 'GPT-4', capabilities: {} },
    })
    useModelStore.getState().switchModel('nonexistent')
    expect(useModelStore.getState().currentModelKey).toBe('')
  })
})

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

  it('normalizes legacy gemini preview model keys when switching', () => {
    useModelStore.getState().setModels({
      'gemini-3.1-flash-image': { name: 'Nano Banana 2', capabilities: {} },
    })
    useModelStore.getState().switchModel('gemini-3.1-flash-image-preview')
    expect(useModelStore.getState().currentModelKey).toBe('gemini-3.1-flash-image')
  })

  it('rejects invalid model key', () => {
    useModelStore.getState().setModels({
      'gpt-4': { name: 'GPT-4', capabilities: {} },
    })
    useModelStore.getState().switchModel('nonexistent')
    expect(useModelStore.getState().currentModelKey).toBe('')
  })
})

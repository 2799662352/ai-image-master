import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useModelStore } from '../useModelStore'

describe('useModelStore', () => {
  beforeEach(() => {
    useModelStore.setState({ currentModelKey: '', models: {} })
  })
  afterEach(() => {
    delete (window as unknown as { aiImageAPI?: unknown }).aiImageAPI
    vi.restoreAllMocks()
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
      'gemini-3-pro-image': { name: 'Nano Banana Pro', capabilities: {} },
    })
    useModelStore.getState().switchModel('gemini-3.1-flash-image-preview')
    expect(useModelStore.getState().currentModelKey).toBe('gemini-3.1-flash-image')
    useModelStore.getState().switchModel('gemini-3-pro-image-preview')
    expect(useModelStore.getState().currentModelKey).toBe('gemini-3-pro-image')
  })

  it('rejects invalid model key', () => {
    useModelStore.getState().setModels({
      'gpt-4': { name: 'GPT-4', capabilities: {} },
    })
    useModelStore.getState().switchModel('nonexistent')
    expect(useModelStore.getState().currentModelKey).toBe('')
  })

  // Split-brain regression: a valid switch must also push to the ApiService
  // singleton (currentModel + localStorage persistence) so the actual request
  // and getCurrentModel()-based consumers (BatchPage modelConfig, downloads)
  // never lag a model behind the React store.
  it('propagates a valid switch to the ApiService singleton', () => {
    const setModel = vi.fn().mockReturnValue(true)
    ;(window as unknown as { aiImageAPI?: { setModel: (k: string) => boolean } }).aiImageAPI = { setModel }
    useModelStore.getState().setModels({
      'gpt-image-2': { name: 'GPT Image 2', capabilities: {} },
    })
    useModelStore.getState().switchModel('gpt-image-2')
    expect(useModelStore.getState().currentModelKey).toBe('gpt-image-2')
    expect(setModel).toHaveBeenCalledWith('gpt-image-2')
  })

  it('does not push an invalid model key to the ApiService singleton', () => {
    const setModel = vi.fn().mockReturnValue(false)
    ;(window as unknown as { aiImageAPI?: { setModel: (k: string) => boolean } }).aiImageAPI = { setModel }
    useModelStore.getState().setModels({ 'gpt-4': { name: 'GPT-4', capabilities: {} } })
    useModelStore.getState().switchModel('nonexistent')
    expect(useModelStore.getState().currentModelKey).toBe('')
    expect(setModel).not.toHaveBeenCalled()
  })
})

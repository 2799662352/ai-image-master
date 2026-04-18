import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useTemplatesStore, initialState } from '../useTemplatesStore'
import type { TemplateActions, Template } from '../../hooks/useTemplates'

function createMockTemplateActions(
  overrides: Partial<TemplateActions> = {}
): TemplateActions {
  return {
    getAll: vi.fn().mockReturnValue([]),
    ...overrides,
  }
}

const sampleTemplates: Template[] = [
  { id: 't1', name: 'Portrait', prompt: 'portrait photo', category: 'photo' },
  { id: 't2', name: 'Landscape', prompt: 'landscape photo', category: 'photo' },
  { id: 't3', name: 'Logo', prompt: 'modern logo', category: 'design', tags: ['branding'] },
]

describe('useTemplatesStore', () => {
  beforeEach(() => {
    useTemplatesStore.setState({ ...initialState })
  })

  it('has correct initial state', () => {
    const state = useTemplatesStore.getState()
    expect(state.templates).toEqual([])
    expect(state.searchQuery).toBe('')
    expect(state.activeCategory).toBe('all')
  })

  it('loadTemplates populates templates from actions', () => {
    const actions = createMockTemplateActions({
      getAll: vi.fn().mockReturnValue(sampleTemplates),
    })

    useTemplatesStore.getState().loadTemplates(actions)

    expect(useTemplatesStore.getState().templates).toEqual(sampleTemplates)
    expect(actions.getAll).toHaveBeenCalledOnce()
  })

  it('setSearchQuery updates searchQuery', () => {
    useTemplatesStore.getState().setSearchQuery('portrait')
    expect(useTemplatesStore.getState().searchQuery).toBe('portrait')
  })

  it('setActiveCategory updates activeCategory', () => {
    useTemplatesStore.getState().setActiveCategory('design')
    expect(useTemplatesStore.getState().activeCategory).toBe('design')
  })
})

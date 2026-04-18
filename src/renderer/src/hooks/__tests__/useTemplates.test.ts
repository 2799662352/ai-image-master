import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useTemplates } from '../useTemplates'
import type { Template } from '../useTemplates'

const STORAGE_KEY = 'prompt_templates'

describe('useTemplates', () => {
  let mockStorage: Record<string, string>

  beforeEach(() => {
    mockStorage = {}
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => mockStorage[key] ?? null)
  })

  it('getAll returns empty array when no data', () => {
    const templates = useTemplates()
    expect(templates.getAll()).toEqual([])
  })

  it('getAll returns parsed templates from localStorage', () => {
    const data: Template[] = [
      { id: '1', name: 'Landscape', prompt: 'beautiful landscape', category: 'nature', tags: ['scenic'] },
      { id: '2', name: 'Portrait', prompt: 'professional portrait', category: 'people' },
    ]
    mockStorage[STORAGE_KEY] = JSON.stringify(data)

    const templates = useTemplates()
    expect(templates.getAll()).toEqual(data)
  })

  it('getAll returns empty array on malformed JSON', () => {
    mockStorage[STORAGE_KEY] = '{broken'
    const templates = useTemplates()
    expect(templates.getAll()).toEqual([])
  })

  it('getAll returns empty array when value is not an array', () => {
    mockStorage[STORAGE_KEY] = JSON.stringify({ not: 'array' })
    const templates = useTemplates()
    expect(templates.getAll()).toEqual([])
  })
})

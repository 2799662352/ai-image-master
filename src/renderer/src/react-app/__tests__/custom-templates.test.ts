import { describe, expect, it, beforeEach, vi } from 'vitest'

const store: Record<string, string> = {}
const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value }),
  removeItem: vi.fn((key: string) => { delete store[key] }),
}
Object.defineProperty(globalThis, 'window', {
  value: { localStorage: localStorageMock },
  writable: true,
})

import {
  addCustomTemplate,
  getCustomTemplates,
  deleteCustomTemplate,
  getAllTemplates,
  BUILTIN_TEMPLATES,
  TEMPLATE_MAP,
} from '../constants/templates'

describe('Custom Templates', () => {
  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key]
    vi.clearAllMocks()
  })

  it('should add a custom template and return its key', () => {
    const key = addCustomTemplate({
      displayName: 'My Style',
      desc: 'test',
      icon: '✏️',
      prefix: 'my prefix, ',
      suffix: ', my suffix',
      negative: 'blurry',
      negativeEnabled: true,
    })
    expect(key).toMatch(/^custom-/)
    expect(TEMPLATE_MAP[key]).toBeDefined()
    expect(TEMPLATE_MAP[key].displayName).toBe('My Style')
  })

  it('should persist custom templates to localStorage', () => {
    addCustomTemplate({
      displayName: 'Saved',
      desc: '',
      icon: '✏️',
      prefix: 'p',
      suffix: 's',
      negative: 'n',
      negativeEnabled: false,
    })
    expect(localStorageMock.setItem).toHaveBeenCalled()
    const saved = getCustomTemplates()
    expect(saved.length).toBe(1)
    expect(saved[0].displayName).toBe('Saved')
  })

  it('should delete a custom template', () => {
    const key = addCustomTemplate({
      displayName: 'ToDelete',
      desc: '',
      icon: '✏️',
      prefix: '',
      suffix: '',
      negative: '',
      negativeEnabled: false,
    })
    expect(TEMPLATE_MAP[key]).toBeDefined()
    deleteCustomTemplate(key)
    expect(TEMPLATE_MAP[key]).toBeUndefined()
    expect(getCustomTemplates().length).toBe(0)
  })

  it('should not delete builtin templates', () => {
    deleteCustomTemplate('cinematic')
    expect(TEMPLATE_MAP['cinematic']).toBeDefined()
  })

  it('getAllTemplates should return builtin + custom', () => {
    addCustomTemplate({
      displayName: 'Extra',
      desc: '',
      icon: '✏️',
      prefix: '',
      suffix: '',
      negative: '',
      negativeEnabled: false,
    })
    const all = getAllTemplates()
    expect(all.length).toBe(BUILTIN_TEMPLATES.length + 1)
  })
})

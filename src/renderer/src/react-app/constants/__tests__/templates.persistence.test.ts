import { beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'director.template-overrides.v1'

describe('templates persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('初始化时会应用 localStorage 覆盖', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      anime: {
        prefix: 'custom-prefix',
        suffix: 'custom-suffix',
        negative: 'custom-negative',
        negativeEnabled: true,
      },
    }))

    const { TEMPLATE_MAP } = await import('../templates')
    expect(TEMPLATE_MAP.anime.prefix).toBe('custom-prefix')
    expect(TEMPLATE_MAP.anime.suffix).toBe('custom-suffix')
    expect(TEMPLATE_MAP.anime.negative).toBe('custom-negative')
    expect(TEMPLATE_MAP.anime.negativeEnabled).toBe(true)
  })

  it('保存和恢复默认会同步到本地存储', async () => {
    const { TEMPLATE_MAP, BUILTIN_TEMPLATES, persistTemplateOverride, resetTemplateOverride } = await import('../templates')

    persistTemplateOverride('movie', {
      prefix: 'p1',
      suffix: 's1',
      negative: 'n1',
      negativeEnabled: true,
    })

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    expect(saved.movie.prefix).toBe('p1')
    expect(TEMPLATE_MAP.movie.prefix).toBe('p1')

    resetTemplateOverride('movie')

    const cleared = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    expect(cleared.movie).toBeUndefined()

    const builtinMovie = BUILTIN_TEMPLATES.find((t) => t.key === 'movie')
    expect(TEMPLATE_MAP.movie.prefix).toBe(builtinMovie?.prefix)
  })
})


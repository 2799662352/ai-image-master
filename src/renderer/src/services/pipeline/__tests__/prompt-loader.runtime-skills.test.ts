import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('prompt-loader runtime skills', () => {
  let loadSkillsMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    loadSkillsMock = vi.fn()
    vi.stubGlobal('window', {
      electronAPI: {
        isElectron: true,
        loadSkills: loadSkillsMock,
      },
    } as any)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('用户同 id skills 会覆盖内置 rules', async () => {
    loadSkillsMock.mockResolvedValue({
      'director-cinematic-composition': [
        '---',
        'name: cinematic-composition',
        'description: user override',
        'appliesTo: [analyzeScene]',
        'priority: 1',
        '---',
        'user override rules',
      ].join('\n'),
    })

    const { initDirectorSkills, getDirectorSkillsFromConfig } = await import('../prompt-loader')
    await initDirectorSkills()

    const skill = getDirectorSkillsFromConfig().find(s => s.id === 'cinematic-composition')
    expect(skill).toBeDefined()
    expect(typeof skill?.rules).toBe('string')
    expect(skill?.rules).toContain('user override rules')
  })

  it('坏格式 skills 会被跳过', async () => {
    loadSkillsMock.mockResolvedValue({
      'invalid-skill': 'this is not valid frontmatter markdown',
    })

    const { initDirectorSkills, getDirectorSkillsFromConfig } = await import('../prompt-loader')
    await initDirectorSkills()

    const skills = getDirectorSkillsFromConfig()
    expect(skills.some(s => s.id === 'invalid-skill')).toBe(false)
  })

  it('reload 后会刷新缓存内容', async () => {
    loadSkillsMock
      .mockResolvedValueOnce({
        'director-cinematic-composition': [
          '---',
          'name: cinematic-composition',
          'description: v1',
          'appliesTo: [analyzeScene]',
          'priority: 1',
          '---',
          'rules-v1',
        ].join('\n'),
      })
      .mockResolvedValueOnce({
        'director-cinematic-composition': [
          '---',
          'name: cinematic-composition',
          'description: v2',
          'appliesTo: [analyzeScene]',
          'priority: 1',
          '---',
          'rules-v2',
        ].join('\n'),
      })

    const { initDirectorSkills, reloadDirectorSkills, getDirectorSkillsFromConfig } = await import('../prompt-loader')

    await initDirectorSkills()
    const before = getDirectorSkillsFromConfig().find(s => s.id === 'cinematic-composition')
    expect(before?.rules).toContain('rules-v1')

    await reloadDirectorSkills()
    const after = getDirectorSkillsFromConfig().find(s => s.id === 'cinematic-composition')
    expect(after?.rules).toContain('rules-v2')
  })

  it('loadSkills 抛错时会回退到内置 skills', async () => {
    loadSkillsMock.mockRejectedValue(new Error('load failed'))

    const { initDirectorSkills, getDirectorSkillsFromConfig } = await import('../prompt-loader')
    await initDirectorSkills()

    const skills = getDirectorSkillsFromConfig()
    expect(skills.length).toBeGreaterThan(0)
  })

  it('electronAPI 缺失时只使用内置 skills', async () => {
    vi.unstubAllGlobals()
    vi.stubGlobal('window', {} as any)

    const { initDirectorSkills, getDirectorSkillsFromConfig } = await import('../prompt-loader')
    await initDirectorSkills()

    const skills = getDirectorSkillsFromConfig()
    expect(skills.length).toBeGreaterThan(0)
  })
})

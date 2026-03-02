import { beforeEach, describe, expect, it, vi } from 'vitest'

type LoaderModule = typeof import('../prompt-loader')

async function importLoader(): Promise<LoaderModule> {
  vi.resetModules()
  return import('../prompt-loader')
}

describe('runtime skills regression matrix', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('A: 仅内置 skills 时行为正常', async () => {
    vi.stubGlobal('window', {} as any)
    const loader = await importLoader()
    await loader.initDirectorSkills()

    const skills = loader.getDirectorSkillsFromConfig()
    expect(skills.length).toBeGreaterThan(0)
    expect(skills.some((s) => s.id === 'cinematic-composition')).toBe(true)
  })

  it('B: 用户新增 skill 在 reload 后可识别', async () => {
    const loadSkills = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        'director-user-new-skill': [
          '---',
          'name: user-new-skill',
          'description: custom user skill',
          'appliesTo: [analyzeScene]',
          'priority: 5',
          '---',
          'user custom rules',
        ].join('\n'),
      })
    vi.stubGlobal('window', { electronAPI: { loadSkills } } as any)

    const loader = await importLoader()
    await loader.initDirectorSkills()
    expect(loader.getDirectorSkillsFromConfig().some((s) => s.id === 'user-new-skill')).toBe(false)

    await loader.reloadDirectorSkills()
    expect(loader.getDirectorSkillsFromConfig().some((s) => s.id === 'user-new-skill')).toBe(true)
  })

  it('C: 同 id 时用户 skill 覆盖内置', async () => {
    const loadSkills = vi.fn().mockResolvedValue({
      'director-cinematic-composition': [
        '---',
        'name: cinematic-composition',
        'description: override',
        'appliesTo: [designAndAssemble]',
        'priority: 1',
        '---',
        'override-rules-from-user',
      ].join('\n'),
    })
    vi.stubGlobal('window', { electronAPI: { loadSkills } } as any)

    const loader = await importLoader()
    await loader.initDirectorSkills()

    const overridden = loader.getDirectorSkillsFromConfig().find((s) => s.id === 'cinematic-composition')
    expect(typeof overridden?.rules).toBe('string')
    expect(overridden?.rules).toContain('override-rules-from-user')
  })

  it('D: 坏格式 skill 被跳过且不中断流程', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loadSkills = vi.fn().mockResolvedValue({
      invalid: 'not-a-valid-skill-markdown',
    })
    vi.stubGlobal('window', { electronAPI: { loadSkills } } as any)

    const loader = await importLoader()
    await expect(loader.initDirectorSkills()).resolves.toBeUndefined()
    expect(loader.getDirectorSkillsFromConfig().some((s) => s.id === 'invalid')).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})


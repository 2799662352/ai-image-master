import { describe, expect, it } from 'vitest'
import type { ElectronAPI } from '@/types'

type SkillApiMethods = Pick<ElectronAPI, 'loadSkills' | 'saveSkill' | 'openSkillsFolder'>

describe('ElectronAPI skill method types', () => {
  it('exposes loadSkills and saveSkill method signatures', async () => {
    const api = {
      loadSkills: async () => ({ foo: '---\nname: foo\n---\nrules' }),
      saveSkill: async () => ({ success: true }),
      openSkillsFolder: async () => ({ success: true, path: 'C:/skills' }),
    } satisfies SkillApiMethods

    await expect(api.loadSkills()).resolves.toMatchObject({ foo: expect.any(String) })
    await expect(api.saveSkill('foo', 'content')).resolves.toMatchObject({ success: true })
    await expect(api.openSkillsFolder()).resolves.toMatchObject({ success: true, path: expect.any(String) })
  })
})


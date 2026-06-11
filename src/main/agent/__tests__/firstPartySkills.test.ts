import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CATIMATION_IMAGE_SKILL,
  installFirstPartySkills,
  type FirstPartySkill,
} from '../firstPartySkills'

const created: string[] = []

async function makeTempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'first-party-skills-'))
  created.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const skillV1: FirstPartySkill = {
  name: 'demo-skill',
  content: '---\nname: demo-skill\ndescription: v1 description.\n---\n\nbody v1\n',
}
const skillV2: FirstPartySkill = {
  name: 'demo-skill',
  content: '---\nname: demo-skill\ndescription: v2 description.\n---\n\nbody v2\n',
}

describe('installFirstPartySkills', () => {
  it('installs a missing skill into <officialRoot>/<name>/SKILL.md', async () => {
    const officialRoot = await makeTempRoot()
    const report = await installFirstPartySkills({ officialRoot, skills: [skillV1] })

    expect(report.installed).toEqual(['demo-skill'])
    expect(report.updated).toEqual([])
    expect(report.removed).toEqual([])
    expect(report.preserved).toEqual([])

    const written = await readFile(
      path.join(officialRoot, 'demo-skill', 'SKILL.md'),
      'utf8',
    )
    expect(written).toBe(skillV1.content)
  })

  it('is idempotent: re-running with the same content is a no-op', async () => {
    const officialRoot = await makeTempRoot()
    await installFirstPartySkills({ officialRoot, skills: [skillV1] })
    const report = await installFirstPartySkills({ officialRoot, skills: [skillV1] })

    expect(report.installed).toEqual([])
    expect(report.updated).toEqual([])
    expect(report.removed).toEqual([])
    expect(report.preserved).toEqual([])
  })

  it('updates an app-managed skill when the shipped content changes', async () => {
    const officialRoot = await makeTempRoot()
    await installFirstPartySkills({ officialRoot, skills: [skillV1] })

    const report = await installFirstPartySkills({ officialRoot, skills: [skillV2] })
    expect(report.updated).toEqual(['demo-skill'])
    expect(report.removed).toEqual([])
    expect(report.preserved).toEqual([])

    const written = await readFile(
      path.join(officialRoot, 'demo-skill', 'SKILL.md'),
      'utf8',
    )
    expect(written).toBe(skillV2.content)
  })

  it('preserves a user-edited skill (does not clobber manual changes)', async () => {
    const officialRoot = await makeTempRoot()
    await installFirstPartySkills({ officialRoot, skills: [skillV1] })

    const skillFile = path.join(officialRoot, 'demo-skill', 'SKILL.md')
    const userEdited = '---\nname: demo-skill\ndescription: my own.\n---\n\nhand edited\n'
    await writeFile(skillFile, userEdited, 'utf8')

    const report = await installFirstPartySkills({ officialRoot, skills: [skillV2] })
    expect(report.installed).toEqual([])
    expect(report.updated).toEqual([])
    expect(report.removed).toEqual([])
    expect(report.preserved).toEqual(['demo-skill'])

    const written = await readFile(skillFile, 'utf8')
    expect(written).toBe(userEdited)
  })

  it('does not expose the managed sidecar as a discoverable skill file', async () => {
    const officialRoot = await makeTempRoot()
    await installFirstPartySkills({ officialRoot, skills: [skillV1] })

    const entries = await readdir(path.join(officialRoot, 'demo-skill'))
    // Discovery only treats `SKILL.md` as a skill; the sidecar must be a dotfile
    // so it never registers as its own skill.
    expect(entries).toContain('SKILL.md')
    expect(entries.every((e) => e === 'SKILL.md' || e.startsWith('.'))).toBe(true)
  })

  it('coexists with an unrelated user skill in the same root', async () => {
    const officialRoot = await makeTempRoot()
    await mkdir(path.join(officialRoot, 'other-skill'), { recursive: true })
    await writeFile(
      path.join(officialRoot, 'other-skill', 'SKILL.md'),
      '---\nname: other-skill\ndescription: untouched.\n---\n',
      'utf8',
    )

    await installFirstPartySkills({ officialRoot, skills: [skillV1] })

    const other = await readFile(
      path.join(officialRoot, 'other-skill', 'SKILL.md'),
      'utf8',
    )
    expect(other).toContain('untouched.')
    const mine = await readFile(path.join(officialRoot, 'demo-skill', 'SKILL.md'), 'utf8')
    expect(mine).toBe(skillV1.content)
  })

  it('removes retired app-managed first-party skills', async () => {
    const officialRoot = await makeTempRoot()
    const retired = {
      name: 'catimation-subagents',
      content: '---\nname: catimation-subagents\ndescription: retired.\n---\n\nbody\n',
    }
    await installFirstPartySkills({ officialRoot, skills: [retired] })

    const report = await installFirstPartySkills({ officialRoot, skills: [skillV1] })

    expect(report.removed).toEqual(['catimation-subagents'])
    await expect(readFile(path.join(officialRoot, 'catimation-subagents', 'SKILL.md'), 'utf8')).rejects.toThrow()
  })

  it('preserves retired first-party skills if the user edited them', async () => {
    const officialRoot = await makeTempRoot()
    const retired = {
      name: 'catimation-subagents',
      content: '---\nname: catimation-subagents\ndescription: retired.\n---\n\nbody\n',
    }
    await installFirstPartySkills({ officialRoot, skills: [retired] })
    await writeFile(
      path.join(officialRoot, 'catimation-subagents', 'SKILL.md'),
      '---\nname: catimation-subagents\ndescription: user copy.\n---\n\nmanual\n',
      'utf8',
    )

    const report = await installFirstPartySkills({ officialRoot, skills: [skillV1] })

    expect(report.removed).toEqual([])
    expect(report.preserved).toContain('catimation-subagents')
    const written = await readFile(path.join(officialRoot, 'catimation-subagents', 'SKILL.md'), 'utf8')
    expect(written).toContain('manual')
  })

  describe('CATIMATION_IMAGE_SKILL (the shipped default)', () => {
    it('has a hyphen-case name and the required frontmatter', () => {
      expect(CATIMATION_IMAGE_SKILL.name).toMatch(/^[a-z0-9-]+$/)
      expect(CATIMATION_IMAGE_SKILL.name.length).toBeLessThanOrEqual(64)
      // Must not collide with the built-in skill we disable at launch.
      expect(CATIMATION_IMAGE_SKILL.name).not.toBe('imagegen')
      expect(CATIMATION_IMAGE_SKILL.content.startsWith('---\n')).toBe(true)
      expect(CATIMATION_IMAGE_SKILL.content).toMatch(/\nname:\s*catimation/)
      expect(CATIMATION_IMAGE_SKILL.content).toMatch(/\ndescription:\s*\S/)
    })

    it('points the agent at the generate_image tool with real params', () => {
      const c = CATIMATION_IMAGE_SKILL.content
      expect(c).toContain('generate_image')
      expect(c).toContain('resolution')
      expect(c).toContain('quality')
      expect(c).toContain('gpt-image-2-vip')
    })

    it('installs cleanly into a fresh root', async () => {
      const officialRoot = await makeTempRoot()
      const report = await installFirstPartySkills({ officialRoot })
      expect(report.installed).toContain(CATIMATION_IMAGE_SKILL.name)
      expect(report.installed).not.toContain('catimation-subagents')
      const written = await readFile(
        path.join(officialRoot, CATIMATION_IMAGE_SKILL.name, 'SKILL.md'),
        'utf8',
      )
      expect(written).toBe(CATIMATION_IMAGE_SKILL.content)
    })
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  listSkills, getSkillDetail, saveSkill, deleteSkill, resolveWorkspacePaths,
} from '../codexConfigStore'

let tmp: string
beforeEach(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'sk-')) })
afterEach(async () => { await rm(tmp, { recursive: true, force: true }) })

async function setup() {
  const home = path.join(tmp, 'h'); const cwd = path.join(tmp, 'p')
  await mkdir(home, { recursive: true }); await mkdir(cwd, { recursive: true })
  return resolveWorkspacePaths({ home, cwd, userData: tmp })
}

describe('skills CRUD', () => {
  it('saves a workspace skill and lists it', async () => {
    const paths = await setup()
    const r = await saveSkill(paths, {
      name: 'demo', scope: 'workspace',
      description: 'd', whenToUse: 'w', instructions: '## body',
    })
    expect(r.ok).toBe(true)
    const list = await listSkills(paths)
    expect(list.find((s) => s.name === 'demo')?.scope).toBe('workspace')
  })

  it('parses existing SKILL.md frontmatter on disk into the form model', async () => {
    const paths = await setup()
    const dir = path.join(paths.workspaceSkillsRoot, 'extant')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'SKILL.md'),
      `---\nname: extant\ndescription: from disk\n---\n## Body\n`,
      'utf8',
    )
    const detail = await getSkillDetail(paths, 'workspace:extant')
    expect(detail!.description).toBe('from disk')
    expect(detail!.instructions).toContain('## Body')
  })

  it('deletes a personal skill directory', async () => {
    const paths = await setup()
    await saveSkill(paths, {
      name: 'gone', scope: 'personal',
      description: '', whenToUse: '', instructions: '',
    })
    expect(await deleteSkill(paths, 'personal:gone')).toEqual({ ok: true })
    expect(await listSkills(paths)).toEqual([])
  })

  it('rejects skill names with path separators', async () => {
    const paths = await setup()
    expect((await saveSkill(paths, {
      name: 'a/b', scope: 'personal',
      description: '', whenToUse: '', instructions: '',
    })).ok).toBe(false)
  })
})

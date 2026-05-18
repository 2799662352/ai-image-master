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

async function setupBundled() {
  const home = path.join(tmp, 'h'); const cwd = path.join(tmp, 'p'); const res = path.join(tmp, 'r')
  await mkdir(home, { recursive: true })
  await mkdir(cwd, { recursive: true })
  await mkdir(path.join(res, '.agents', 'skills'), { recursive: true })
  return resolveWorkspacePaths({ home, cwd, userData: tmp, resourcesPath: res })
}

describe('skills CRUD', () => {
  it('saves a workspace skill and lists it as repo scope', async () => {
    const paths = await setup()
    const r = await saveSkill(paths, {
      name: 'demo', scope: 'workspace',
      description: 'd', whenToUse: 'w', instructions: '## body',
    })
    expect(r.ok).toBe(true)
    const list = await listSkills(paths)
    // CodexConfigScope.workspace maps to the Codex 'repo' listing scope.
    expect(list.find((s) => s.name === 'demo')?.scope).toBe('repo')
  })

  it('parses existing SKILL.md frontmatter on disk into the form model', async () => {
    const paths = await setup()
    const dir = path.join(paths.workspaceSkillsRoot, 'extant')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'SKILL.md'),
      `---\nname: extant\ndescription: from disk\n---\n## Body\n`,
      'utf8',
    )
    // Both legacy 'workspace:' and new 'repo:' IDs should resolve.
    const detail = await getSkillDetail(paths, 'repo:extant')
    expect(detail!.description).toBe('from disk')
    expect(detail!.instructions).toContain('## Body')
    const legacy = await getSkillDetail(paths, 'workspace:extant')
    expect(legacy!.description).toBe('from disk')
  })

  it('deletes a personal skill directory via legacy and Codex IDs', async () => {
    const paths = await setup()
    await saveSkill(paths, {
      name: 'gone', scope: 'personal',
      description: '', whenToUse: '', instructions: '',
    })
    // Use Codex official `user:` prefix.
    expect(await deleteSkill(paths, 'user:gone')).toEqual({ ok: true })
    expect(await listSkills(paths)).toEqual([])
  })

  it('rejects skill names with path separators', async () => {
    const paths = await setup()
    expect((await saveSkill(paths, {
      name: 'a/b', scope: 'personal',
      description: '', whenToUse: '', instructions: '',
    })).ok).toBe(false)
  })

  it('lists system skills as read-only and exposes their on-disk path', async () => {
    const paths = await setupBundled()
    const dir = path.join(paths.systemSkillsRoot!, 'deep-agents-core')
    await mkdir(dir, { recursive: true })
    await writeFile(
      path.join(dir, 'SKILL.md'),
      `---\nname: deep-agents-core\ndescription: system core agent\n---\n## body\n`,
      'utf8',
    )

    const list = await listSkills(paths)
    const sys = list.find((s) => s.id === 'system:deep-agents-core')
    expect(sys).toBeTruthy()
    expect(sys?.scope).toBe('system')
    expect(sys?.readOnly).toBe(true)
    expect(sys?.path.endsWith('SKILL.md')).toBe(true)
  })

  it('rejects save and delete for system scope', async () => {
    const paths = await setupBundled()
    const saveRes = await saveSkill(paths, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scope: 'system' as any,
      name: 'x',
      description: '',
      whenToUse: '',
      instructions: '',
    })
    expect(saveRes.ok).toBe(false)
    expect(saveRes.error).toMatch(/read-only/i)

    const delRes = await deleteSkill(paths, 'system:x')
    expect(delRes.ok).toBe(false)
    expect(delRes.error).toMatch(/read-only/i)
  })
})

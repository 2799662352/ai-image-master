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

// ---------------------------------------------------------------------------
// Legacy USER scope discovery
//
// AI-created and historically saved skills live in app-specific or codex-CLI
// legacy locations:
//   - userData/skills  (this app's legacy `save-skill` IPC writes here, and
//     the "打开 Skills 文件夹" button opens it)
//   - $HOME/.codex/skills  (Codex CLI legacy USER scope, still loaded by the
//     official CLI per openai/codex issue #14337; deprecated but supported)
//
// `listSkills` must surface those entries as `user` scope so the SkillsSection
// can render them.
// ---------------------------------------------------------------------------
describe('skills USER scope legacy discovery', () => {
  async function setupWithLegacy(legacyRoots: string[]) {
    const home = path.join(tmp, 'h')
    const cwd = path.join(tmp, 'p')
    await mkdir(home, { recursive: true })
    await mkdir(cwd, { recursive: true })
    return resolveWorkspacePaths({
      home,
      cwd,
      userData: tmp,
      legacyUserSkillsRoots: legacyRoots,
    })
  }

  async function writeSkill(root: string, name: string, body: string) {
    const dir = path.join(root, name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'SKILL.md'), body, 'utf8')
  }

  it('resolveWorkspacePaths accepts and exposes legacyUserSkillsRoots', async () => {
    const legacy = path.join(tmp, 'app-data', 'skills')
    const paths = await setupWithLegacy([legacy])
    expect(paths.legacyUserSkillsRoots).toEqual([legacy])
  })

  it('lists a skill from a legacy user skills root as user scope', async () => {
    const legacy = path.join(tmp, 'app-data', 'skills')
    const paths = await setupWithLegacy([legacy])
    await writeSkill(
      legacy,
      'trailer-plan-generator',
      `---\nname: trailer-plan-generator\ndescription: AI-created trailer skill\n---\n## Body\n`,
    )

    const list = await listSkills(paths)
    const entry = list.find((s) => s.name === 'trailer-plan-generator')
    expect(entry).toBeTruthy()
    expect(entry?.scope).toBe('user')
    expect(entry?.description).toBe('AI-created trailer skill')
    expect(entry?.path.endsWith(path.join('trailer-plan-generator', 'SKILL.md'))).toBe(true)
  })

  it('lists a skill that has SKILL.md but no frontmatter (uses directory name)', async () => {
    // AI-created skills frequently omit frontmatter. Detection must not require
    // it: the directory name should be used as the skill name.
    const legacy = path.join(tmp, 'app-data', 'skills')
    const paths = await setupWithLegacy([legacy])
    await writeSkill(legacy, 'no-frontmatter', `# Some Skill\n\nDo a thing.\n`)

    const list = await listSkills(paths)
    expect(list.find((s) => s.name === 'no-frontmatter')).toBeTruthy()
  })

  it('merges multiple legacy roots and dedupes by skill directory name (personal wins)', async () => {
    // Simulate the realistic Windows runtime: AI writes via app legacy IPC into
    // userData/skills, and a user also has a copy in ~/.codex/skills. We
    // expect a single entry per name, with the official personal root taking
    // precedence on collision.
    const codexLegacy = path.join(tmp, 'h', '.codex', 'skills')
    const appLegacy = path.join(tmp, 'app-data', 'skills')
    const paths = await setupWithLegacy([appLegacy, codexLegacy])

    await writeSkill(appLegacy, 'shared', `---\nname: shared\ndescription: from app legacy\n---\n`)
    await writeSkill(codexLegacy, 'shared', `---\nname: shared\ndescription: from codex legacy\n---\n`)
    // Personal (~/.agents/skills) should take precedence on duplicate.
    await writeSkill(
      paths.personalSkillsRoot,
      'shared',
      `---\nname: shared\ndescription: from personal\n---\n`,
    )
    await writeSkill(appLegacy, 'only-app', `---\nname: only-app\ndescription: app only\n---\n`)

    const list = await listSkills(paths)
    const shared = list.filter((s) => s.name === 'shared')
    expect(shared).toHaveLength(1)
    expect(shared[0]?.description).toBe('from personal')
    expect(list.find((s) => s.name === 'only-app')?.scope).toBe('user')
  })

  it('survives missing legacy roots without throwing', async () => {
    const paths = await setupWithLegacy([path.join(tmp, 'does-not-exist', 'skills')])
    await expect(listSkills(paths)).resolves.toEqual([])
  })
})

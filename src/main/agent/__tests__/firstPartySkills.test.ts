import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CATIMATION_IMAGE_SKILL,
  CATIMATION_BRAINSTORM_SKILL,
  CATIMATION_SUBAGENTS_SKILL,
  CATIMATION_UNDERSTAND_SKILL,
  CATIMATION_FFMPEG_WIN_SKILL,
  FIRST_PARTY_SKILLS,
  KNOWN_UNMARKED_FIRST_PARTY_SKILL_HASHES,
  installFirstPartySkills,
  type FirstPartySkill,
} from '../firstPartySkills'
// 单一真源生成器(仓库脚本,无 .d.ts,类型由 checkJs 推断)
import { renderGeneratedModule, GENERATED_RELATIVE_PATH } from '../../../../scripts/generate-first-party-skills.mjs'

function frontmatterDescription(content: string): string {
  const match = content.match(/\ndescription:\s*>-\n([\s\S]*?)\n---/)
  if (!match) return ''
  return match[1]
    .split('\n')
    .map((l) => l.trim())
    .join(' ')
    .trim()
}

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

  it('adopts a markerless copy when it exactly matches the shipped content', async () => {
    const officialRoot = await makeTempRoot()
    const skillDir = path.join(officialRoot, skillV1.name)
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      skillV1.content.replace(/\n/g, '\r\n'),
      'utf8',
    )

    const report = await installFirstPartySkills({ officialRoot, skills: [skillV1] })

    expect(report.updated).toEqual(['demo-skill'])
    expect(report.preserved).toEqual([])
    expect(await readFile(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe(skillV1.content)
    expect(await readFile(path.join(skillDir, '.catimation-managed'), 'utf8')).toMatch(
      /^[a-f0-9]{64}\n$/,
    )
  })

  it('safely upgrades a recognized historical markerless copy', async () => {
    const officialRoot = await makeTempRoot()
    const skillDir = path.join(officialRoot, skillV1.name)
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, 'SKILL.md'), skillV1.content, 'utf8')
    const historicalHash = crypto
      .createHash('sha256')
      .update(skillV1.content, 'utf8')
      .digest('hex')

    const report = await installFirstPartySkills({
      officialRoot,
      skills: [skillV2],
      knownUnmarkedSkillHashes: new Map([
        ['demo-skill', new Set([historicalHash])],
      ]),
    })

    expect(report.updated).toEqual(['demo-skill'])
    expect(report.preserved).toEqual([])
    expect(await readFile(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe(skillV2.content)
  })

  it('recognizes the earliest published markerless ffmpeg-win copy', () => {
    expect(
      KNOWN_UNMARKED_FIRST_PARTY_SKILL_HASHES.get('ffmpeg-win')?.has(
        'c24cfd4c15b9c459ab31d3eb85d42b2d4fa8b36ae0eacfc316f738fbe6a477a0',
      ),
    ).toBe(true)
  })

  it('preserves an unknown markerless copy as user-owned', async () => {
    const officialRoot = await makeTempRoot()
    const skillDir = path.join(officialRoot, skillV1.name)
    const userCopy =
      '---\nname: demo-skill\ndescription: independently installed.\n---\n\ncustom\n'
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, 'SKILL.md'), userCopy, 'utf8')

    const report = await installFirstPartySkills({ officialRoot, skills: [skillV2] })

    expect(report.updated).toEqual([])
    expect(report.preserved).toEqual(['demo-skill'])
    expect(await readFile(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe(userCopy)
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

  // 样板用 `mediakit-cli` —— 它是 RETIRED_FIRST_PARTY_SKILL_NAMES 里现存的唯一一个。
  // 这两条曾经用 `catimation-subagents` 当样板,而它在 2026-08-03 被复活成正式首方
  // skill(看图不烧上下文的委派纪律),留在这儿会让「退休机制」测到一个没退休的名字。
  it('removes retired app-managed first-party skills', async () => {
    const officialRoot = await makeTempRoot()
    const retired = {
      name: 'mediakit-cli',
      content: '---\nname: mediakit-cli\ndescription: retired.\n---\n\nbody\n',
    }
    await installFirstPartySkills({ officialRoot, skills: [retired] })

    const report = await installFirstPartySkills({ officialRoot, skills: [skillV1] })

    expect(report.removed).toEqual(['mediakit-cli'])
    await expect(readFile(path.join(officialRoot, 'mediakit-cli', 'SKILL.md'), 'utf8')).rejects.toThrow()
  })

  it('preserves retired first-party skills if the user edited them', async () => {
    const officialRoot = await makeTempRoot()
    const retired = {
      name: 'mediakit-cli',
      content: '---\nname: mediakit-cli\ndescription: retired.\n---\n\nbody\n',
    }
    await installFirstPartySkills({ officialRoot, skills: [retired] })
    await writeFile(
      path.join(officialRoot, 'mediakit-cli', 'SKILL.md'),
      '---\nname: mediakit-cli\ndescription: user copy.\n---\n\nmanual\n',
      'utf8',
    )

    const report = await installFirstPartySkills({ officialRoot, skills: [skillV1] })

    expect(report.removed).toEqual([])
    expect(report.preserved).toContain('mediakit-cli')
    const written = await readFile(path.join(officialRoot, 'mediakit-cli', 'SKILL.md'), 'utf8')
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
      expect(report.installed).not.toContain('mediakit-cli')
      const written = await readFile(
        path.join(officialRoot, CATIMATION_IMAGE_SKILL.name, 'SKILL.md'),
        'utf8',
      )
      expect(written).toBe(CATIMATION_IMAGE_SKILL.content)
    })
  })

  describe('CATIMATION_SUBAGENTS_SKILL', () => {
    it('is shipped in FIRST_PARTY_SKILLS with valid frontmatter', () => {
      expect(FIRST_PARTY_SKILLS).toContain(CATIMATION_SUBAGENTS_SKILL)
      expect(CATIMATION_SUBAGENTS_SKILL.name).toBe('catimation-subagents')
      expect(CATIMATION_SUBAGENTS_SKILL.content.startsWith('---\n')).toBe(true)
      expect(CATIMATION_SUBAGENTS_SKILL.content).toMatch(/\nname:\s*catimation-subagents/)
    })

    // 它在 2026-07-10 的减法重构里被退休过,这次复活。断言的是「装得上」——
    // 至于名字有没有留在 RETIRED_FIRST_PARTY_SKILL_NAMES 里,安装器那边
    // `if (activeNames.has(name)) continue` 已经让活跃清单优先,同时出现在两处
    // 不会被删。所以这里不写「不在退休名单里」那种断言:它恒真,测不出东西。
    it('installs into a fresh root (revived from retirement)', async () => {
      const officialRoot = await makeTempRoot()
      const report = await installFirstPartySkills({ officialRoot })
      expect(report.installed).toContain('catimation-subagents')
      const written = await readFile(
        path.join(officialRoot, 'catimation-subagents', 'SKILL.md'),
        'utf8',
      )
      expect(written).toBe(CATIMATION_SUBAGENTS_SKILL.content)
    })

    it('keeps the always-injected description concise (progressive disclosure)', () => {
      const desc = frontmatterDescription(CATIMATION_SUBAGENTS_SKILL.content)
      expect(desc.length).toBeGreaterThan(0)
      expect(desc.length).toBeLessThanOrEqual(500)
    })

    // 三条内容不变量,对应它存在的理由。
    it('states the 5-image ceiling, the qwen MCP path, and the sidecar contract', () => {
      const c = CATIMATION_SUBAGENTS_SKILL.content
      // 主 agent 直接看图的硬上限。
      expect(c).toMatch(/view_image/)
      expect(c).toMatch(/上限是 5 张/)
      // 路 A:并发 MCP 理解,图不进主上下文。understand_document 才是看图那条路。
      expect(c).toContain('understand_document')
      // 旁挂落盘:两份文件,和图同目录。
      expect(c).toContain('.vision.json')
      expect(c).toContain('.vision.md')
    })
  })

  describe('CATIMATION_BRAINSTORM_SKILL', () => {
    it('is shipped in FIRST_PARTY_SKILLS with valid frontmatter', () => {
      expect(FIRST_PARTY_SKILLS).toContain(CATIMATION_BRAINSTORM_SKILL)
      expect(CATIMATION_BRAINSTORM_SKILL.name).toBe('catimation-brainstorm')
      expect(CATIMATION_BRAINSTORM_SKILL.content.startsWith('---\n')).toBe(true)
      expect(CATIMATION_BRAINSTORM_SKILL.content).toMatch(/\nname:\s*catimation-brainstorm/)
      expect(CATIMATION_BRAINSTORM_SKILL.content).toMatch(/\ndescription:\s*\S/)
    })

    it('keeps the always-injected description concise (progressive disclosure)', () => {
      const desc = frontmatterDescription(CATIMATION_BRAINSTORM_SKILL.content)
      expect(desc.length).toBeGreaterThan(0)
      expect(desc.length).toBeLessThanOrEqual(500)
    })

    it('drives the interactive ask_user tool, not a text survey', () => {
      const c = CATIMATION_BRAINSTORM_SKILL.content
      expect(c).toContain('ask_user')
      expect(c).toContain('single')
      expect(c).toContain('multi')
      expect(c).toContain('allowSkip')
    })

    it('installs cleanly alongside the other first-party skills', async () => {
      const officialRoot = await makeTempRoot()
      const report = await installFirstPartySkills({ officialRoot })
      expect(report.installed).toContain('catimation-brainstorm')
      const written = await readFile(
        path.join(officialRoot, 'catimation-brainstorm', 'SKILL.md'),
        'utf8',
      )
      expect(written).toBe(CATIMATION_BRAINSTORM_SKILL.content)
    })
  })

  describe('CATIMATION_UNDERSTAND_SKILL', () => {
    it('is shipped in FIRST_PARTY_SKILLS with valid frontmatter', () => {
      expect(FIRST_PARTY_SKILLS).toContain(CATIMATION_UNDERSTAND_SKILL)
      expect(CATIMATION_UNDERSTAND_SKILL.name).toBe('catimation-understand')
      expect(CATIMATION_UNDERSTAND_SKILL.name).toMatch(/^[a-z0-9-]+$/)
      expect(CATIMATION_UNDERSTAND_SKILL.content.startsWith('---\n')).toBe(true)
      expect(CATIMATION_UNDERSTAND_SKILL.content).toMatch(/\nname:\s*catimation-understand/)
      expect(CATIMATION_UNDERSTAND_SKILL.content).toMatch(/\ndescription:\s*\S/)
    })

    it('keeps the always-injected description concise (progressive disclosure)', () => {
      const desc = frontmatterDescription(CATIMATION_UNDERSTAND_SKILL.content)
      expect(desc.length).toBeGreaterThan(0)
      expect(desc.length).toBeLessThanOrEqual(500)
    })

    it('documents the three understand tools, the audio→MP4 fallback, and the qwen subagent', () => {
      const c = CATIMATION_UNDERSTAND_SKILL.content
      expect(c).toContain('understand_video')
      expect(c).toContain('understand_document')
      expect(c).toContain('web_research')
      // audio is not native → ffmpeg → MP4 → understand_video
      expect(c).toContain('ffmpeg')
      expect(c).toContain('MP4')
      // Path B: spawn a subagent pinned to the qwen provider/model
      expect(c).toContain('qwen3.7-max-dashscope')
      expect(c).toContain('modelProvider')
    })

    it('installs cleanly alongside the other first-party skills', async () => {
      const officialRoot = await makeTempRoot()
      const report = await installFirstPartySkills({ officialRoot })
      expect(report.installed).toContain('catimation-understand')
      const written = await readFile(
        path.join(officialRoot, 'catimation-understand', 'SKILL.md'),
        'utf8',
      )
      expect(written).toBe(CATIMATION_UNDERSTAND_SKILL.content)
    })
  })

  describe('CATIMATION_FFMPEG_WIN_SKILL', () => {
    it('is shipped in FIRST_PARTY_SKILLS with valid frontmatter', () => {
      expect(FIRST_PARTY_SKILLS).toContain(CATIMATION_FFMPEG_WIN_SKILL)
      expect(CATIMATION_FFMPEG_WIN_SKILL.name).toBe('ffmpeg-win')
      expect(CATIMATION_FFMPEG_WIN_SKILL.name).toMatch(/^[a-z0-9-]+$/)
      expect(CATIMATION_FFMPEG_WIN_SKILL.content.startsWith('---\n')).toBe(true)
      expect(CATIMATION_FFMPEG_WIN_SKILL.content).toMatch(/\nname:\s*ffmpeg-win/)
      expect(CATIMATION_FFMPEG_WIN_SKILL.content).toMatch(/\ndescription:\s*\S/)
    })

    it('documents both backends (local CLI preferred, Docker MCP fallback)', () => {
      const c = CATIMATION_FFMPEG_WIN_SKILL.content
      expect(c).toContain('Backend A')
      expect(c).toContain('Backend B')
      expect(c).toContain('ffprobe')
      // Step 0 backend probe so the agent picks local-first.
      expect(c).toMatch(/ffmpeg -version/)
    })

    it('carries the mcp-video-inspired 审片 (quality check + release checkpoint)', () => {
      const c = CATIMATION_FFMPEG_WIN_SKILL.content
      expect(c).toContain('release checkpoint')
      expect(c).toContain('loudnorm')
      expect(c).toContain('tile=3x3')
      expect(c).toContain('Preflight guardrails')
      expect(c).toContain('Do not auto-publish')
    })

    it('installs cleanly alongside the other first-party skills', async () => {
      const officialRoot = await makeTempRoot()
      const report = await installFirstPartySkills({ officialRoot })
      expect(report.installed).toContain('ffmpeg-win')
      const written = await readFile(
        path.join(officialRoot, 'ffmpeg-win', 'SKILL.md'),
        'utf8',
      )
      expect(written).toBe(CATIMATION_FFMPEG_WIN_SKILL.content)
    })
  })

  describe('single-source parity', () => {
    it('generated module matches its Markdown sources (run generate-first-party-skills.mjs if this fails)', async () => {
      const repoRoot = path.resolve(__dirname, '..', '..', '..', '..')
      const onDisk = await readFile(
        path.join(repoRoot, ...(GENERATED_RELATIVE_PATH as string).split('/')),
        'utf8',
      )
      const rendered = await renderGeneratedModule()
      expect(onDisk.replaceAll('\r\n', '\n')).toBe(rendered)
    })

    it('every shipped skill content ends with a newline and uses LF', () => {
      for (const skill of FIRST_PARTY_SKILLS) {
        expect(skill.content.includes('\r\n'), `${skill.name} contains CRLF`).toBe(false)
        expect(skill.content.endsWith('\n'), `${skill.name} missing trailing newline`).toBe(true)
      }
    })
  })
})

/**
 * Bundled resources (`references/…`) let a fat SKILL.md become a lean router:
 * Codex loads the body on every trigger but reads references only on demand.
 * The installer therefore has to ship them, refresh them, retire the ones we
 * stop shipping, and never clobber a file the user rewrote.
 */
describe('installFirstPartySkills — bundled resources', () => {
  const withRefs = (body: string, refs: Record<string, string>): FirstPartySkill => ({
    name: 'demo-skill',
    content: `---\nname: demo-skill\ndescription: ${body} description.\n---\n\n${body}\n`,
    files: refs,
  })

  const refPath = (root: string, rel: string) => path.join(root, 'demo-skill', ...rel.split('/'))
  const marker = (root: string) => readFile(path.join(root, 'demo-skill', '.catimation-managed'), 'utf8')

  it('writes bundled files next to SKILL.md on a fresh install', async () => {
    const officialRoot = await makeTempRoot()
    const skill = withRefs('v1', { 'references/models.md': '# models\n' })

    const report = await installFirstPartySkills({ officialRoot, skills: [skill] })

    expect(report.installed).toEqual(['demo-skill'])
    expect(await readFile(refPath(officialRoot, 'references/models.md'), 'utf8')).toBe('# models\n')
  })

  it('stays idempotent once the bundled files are on disk', async () => {
    const officialRoot = await makeTempRoot()
    const skill = withRefs('v1', { 'references/models.md': '# models\n' })
    await installFirstPartySkills({ officialRoot, skills: [skill] })

    const report = await installFirstPartySkills({ officialRoot, skills: [skill] })
    expect(report).toEqual({ installed: [], updated: [], removed: [], preserved: [] })
  })

  it('refreshes a bundled file whose shipped content changed, even when SKILL.md did not', async () => {
    const officialRoot = await makeTempRoot()
    await installFirstPartySkills({
      officialRoot,
      skills: [withRefs('v1', { 'references/models.md': '# old\n' })],
    })

    const report = await installFirstPartySkills({
      officialRoot,
      skills: [withRefs('v1', { 'references/models.md': '# new\n' })],
    })

    expect(report.updated).toEqual(['demo-skill'])
    expect(await readFile(refPath(officialRoot, 'references/models.md'), 'utf8')).toBe('# new\n')
  })

  it('deletes a bundled file we no longer ship, so no pointer dangles', async () => {
    const officialRoot = await makeTempRoot()
    await installFirstPartySkills({
      officialRoot,
      skills: [withRefs('v1', { 'references/gone.md': '# gone\n', 'references/kept.md': '# kept\n' })],
    })

    await installFirstPartySkills({
      officialRoot,
      skills: [withRefs('v2', { 'references/kept.md': '# kept\n' })],
    })

    await expect(readFile(refPath(officialRoot, 'references/gone.md'), 'utf8')).rejects.toThrow()
    expect(await readFile(refPath(officialRoot, 'references/kept.md'), 'utf8')).toBe('# kept\n')
  })

  it('never clobbers a bundled file the user rewrote, but still updates SKILL.md', async () => {
    const officialRoot = await makeTempRoot()
    await installFirstPartySkills({
      officialRoot,
      skills: [withRefs('v1', { 'references/models.md': '# shipped\n' })],
    })
    await writeFile(refPath(officialRoot, 'references/models.md'), '# mine\n', 'utf8')

    await installFirstPartySkills({
      officialRoot,
      skills: [withRefs('v2', { 'references/models.md': '# shipped v2\n' })],
    })

    expect(await readFile(refPath(officialRoot, 'references/models.md'), 'utf8')).toBe('# mine\n')
    expect(await readFile(path.join(officialRoot, 'demo-skill', 'SKILL.md'), 'utf8')).toContain('v2')
  })

  it('leaves a user-owned file alone when a later version happens to ship that same path', async () => {
    const officialRoot = await makeTempRoot()
    await installFirstPartySkills({ officialRoot, skills: [skillV1] })
    await mkdir(path.join(officialRoot, 'demo-skill', 'references'), { recursive: true })
    await writeFile(refPath(officialRoot, 'references/notes.md'), '# user notes\n', 'utf8')

    await installFirstPartySkills({
      officialRoot,
      skills: [withRefs('v2', { 'references/notes.md': '# shipped notes\n' })],
    })

    expect(await readFile(refPath(officialRoot, 'references/notes.md'), 'utf8')).toBe('# user notes\n')
  })

  it('keeps the marker single-line for skills that ship no bundled files', async () => {
    const officialRoot = await makeTempRoot()
    await installFirstPartySkills({ officialRoot, skills: [skillV1] })
    expect(await marker(officialRoot)).toMatch(/^[a-f0-9]{64}\n$/)
  })

  it('still recognizes a legacy single-line marker as app-managed when adding bundled files', async () => {
    const officialRoot = await makeTempRoot()
    // Installed by an older build: marker holds only the SKILL.md hash.
    await installFirstPartySkills({ officialRoot, skills: [skillV1] })
    expect(await marker(officialRoot)).toMatch(/^[a-f0-9]{64}\n$/)

    const report = await installFirstPartySkills({
      officialRoot,
      skills: [withRefs('v2', { 'references/models.md': '# models\n' })],
    })

    expect(report.updated).toEqual(['demo-skill'])
    expect(report.preserved).toEqual([])
    expect(await readFile(refPath(officialRoot, 'references/models.md'), 'utf8')).toBe('# models\n')
  })

  it('writes nothing when the user edited SKILL.md — bundled files included', async () => {
    const officialRoot = await makeTempRoot()
    await installFirstPartySkills({ officialRoot, skills: [skillV1] })
    await writeFile(path.join(officialRoot, 'demo-skill', 'SKILL.md'), 'hand written\n', 'utf8')

    const report = await installFirstPartySkills({
      officialRoot,
      skills: [withRefs('v2', { 'references/models.md': '# models\n' })],
    })

    expect(report.preserved).toEqual(['demo-skill'])
    await expect(readFile(refPath(officialRoot, 'references/models.md'), 'utf8')).rejects.toThrow()
  })

  it('rejects bundled paths that escape the skill directory', async () => {
    const officialRoot = await makeTempRoot()
    await expect(
      installFirstPartySkills({
        officialRoot,
        skills: [withRefs('v1', { '../escaped.md': 'nope\n' })],
      }),
    ).rejects.toThrow(/escape/i)
  })
})

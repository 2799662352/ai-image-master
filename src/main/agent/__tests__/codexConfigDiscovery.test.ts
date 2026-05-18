import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverCodexSkills, readMcpSummary } from '../codexConfigDiscovery'

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'codex-discovery-'))
}

describe('codexConfigDiscovery', () => {
  it('discovers mcp_servers entries and redacts secrets', async () => {
    const dir = await makeTempDir()
    const configPath = path.join(dir, 'config.toml')
    const githubToken = 'ghp' + '_supersecret'
    const headerToken = 'sk' + '-live-secret'
    const apiyiToken = 'apiyi' + '-secret'
    const urlToken = 'sk' + '-url-secret'
    await writeFile(configPath, `
[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github", "--token", "${githubToken}"]
env = { GITHUB_TOKEN = "${githubToken}", SAFE_VALUE = "also-hidden" }
headers = { Authorization = "Bearer ${headerToken}", "X-Api-Key" = "${apiyiToken}" }
enabled = true
required = false

[mcp_servers.remote]
url = "https://mcp-user:p%40ssw0rd@example.test/mcp?api_key=${urlToken}&mode=read"
transport = "sse"
disabled = true
required = true
`, 'utf8')

    const summary = await readMcpSummary(configPath)

    expect(summary.servers).toEqual([
      {
        name: 'github',
        transport: 'stdio',
        enabled: true,
        required: false,
        command: 'npx -y @modelcontextprotocol/server-github --token [REDACTED]',
      },
      {
        name: 'remote',
        transport: 'sse',
        enabled: false,
        required: true,
        url: 'https://REDACTED:REDACTED@example.test/mcp?api_key=[REDACTED]&mode=read',
      },
    ])
    expect(JSON.stringify(summary)).not.toContain(githubToken)
    expect(JSON.stringify(summary)).not.toContain(headerToken)
    expect(JSON.stringify(summary)).not.toContain(apiyiToken)
    expect(JSON.stringify(summary)).not.toContain(urlToken)
    expect(JSON.stringify(summary)).not.toContain('mcp-user')
    expect(JSON.stringify(summary)).not.toContain('p%40ssw0rd')
  })

  it('returns an empty summary when the config is missing', async () => {
    const summary = await readMcpSummary(path.join(await makeTempDir(), 'missing.toml'))

    expect(summary).toEqual({ servers: [], warnings: [] })
  })

  it('discovers workspace and home skills, with invalid frontmatter warnings', async () => {
    const cwd = await makeTempDir()
    const home = await makeTempDir()
    await mkdir(path.join(cwd, '.agents', 'skills', 'workspace-skill'), { recursive: true })
    await mkdir(path.join(home, '.agents', 'skills', 'home-skill'), { recursive: true })
    await writeFile(path.join(cwd, '.agents', 'skills', 'workspace-skill', 'SKILL.md'), `---
name: workspace-skill
description: Use from workspace.
---

# Workspace Skill
`, 'utf8')
    await writeFile(path.join(home, '.agents', 'skills', 'home-skill', 'SKILL.md'), `---
name: home-skill
description: "unterminated
---

# Home Skill
`, 'utf8')

    const summary = await discoverCodexSkills({ cwd, home })

    expect(summary.skills).toEqual([
      {
        name: 'workspace-skill',
        scope: 'repo',
        description: 'Use from workspace.',
        path: path.join(cwd, '.agents', 'skills', 'workspace-skill', 'SKILL.md'),
      },
      {
        name: 'home-skill',
        scope: 'user',
        description: '',
        path: path.join(home, '.agents', 'skills', 'home-skill', 'SKILL.md'),
      },
    ])
    expect(summary.warnings).toEqual([
      expect.stringContaining('Invalid frontmatter in home-skill'),
    ])
  })

  // ---------------------------------------------------------------------------
  // Legacy USER scope discovery — the `/` palette + `$skill` mention popup
  // call `discoverCodexSkills` directly (via `getSkillsSummary`), separate
  // from `listSkills` used by the SkillsSection panel. Both must surface
  // AI-created skills written to `<userData>/skills` and Codex CLI legacy
  // `$HOME/.codex/skills` (per openai/codex#14337), otherwise the in-chat
  // popup and the side panel disagree on what's available.
  // ---------------------------------------------------------------------------
  it('discovers skills from legacy USER scope roots and dedupes against home', async () => {
    const cwd = await makeTempDir()
    const home = await makeTempDir()
    const userData = await makeTempDir()
    const userSkillsDir = path.join(userData, 'skills')
    await mkdir(path.join(userSkillsDir, 'trailer-plan-generator'), { recursive: true })
    await writeFile(
      path.join(userSkillsDir, 'trailer-plan-generator', 'SKILL.md'),
      `---\nname: trailer-plan-generator\ndescription: AI-created trailer skill\n---\n`,
      'utf8',
    )

    // A second legacy root (codex CLI legacy ~/.codex/skills) with a unique skill.
    const codexLegacy = path.join(home, '.codex', 'skills')
    await mkdir(path.join(codexLegacy, 'codex-legacy-only'), { recursive: true })
    await writeFile(
      path.join(codexLegacy, 'codex-legacy-only', 'SKILL.md'),
      `---\nname: codex-legacy-only\ndescription: from codex legacy\n---\n`,
      'utf8',
    )

    // Same-name collision: a personal-scope skill in the official path. The
    // legacy entry must NOT shadow it; the merged list keeps a single entry
    // (the official one) plus the unique legacy ones.
    await mkdir(path.join(home, '.agents', 'skills', 'shared'), { recursive: true })
    await writeFile(
      path.join(home, '.agents', 'skills', 'shared', 'SKILL.md'),
      `---\nname: shared\ndescription: from official home\n---\n`,
      'utf8',
    )
    await mkdir(path.join(userSkillsDir, 'shared'), { recursive: true })
    await writeFile(
      path.join(userSkillsDir, 'shared', 'SKILL.md'),
      `---\nname: shared\ndescription: from app userData (legacy)\n---\n`,
      'utf8',
    )

    const summary = await discoverCodexSkills({
      cwd,
      home,
      legacyUserSkillsRoots: [userSkillsDir, codexLegacy],
    })

    const names = summary.skills.map((s) => s.name)
    expect(names).toContain('trailer-plan-generator')
    expect(names).toContain('codex-legacy-only')
    // Both legacy and official `shared` exist on disk; dedupe keeps one and
    // surfaces the official one's description.
    expect(names.filter((n) => n === 'shared')).toHaveLength(1)
    expect(summary.skills.find((s) => s.name === 'shared')?.description).toBe(
      'from official home',
    )
    // Legacy entries are surfaced as USER scope.
    expect(summary.skills.find((s) => s.name === 'trailer-plan-generator')?.scope).toBe('user')
    expect(summary.skills.find((s) => s.name === 'codex-legacy-only')?.scope).toBe('user')
  })

  it('skips missing legacy roots silently', async () => {
    const cwd = await makeTempDir()
    const home = await makeTempDir()
    const summary = await discoverCodexSkills({
      cwd,
      home,
      legacyUserSkillsRoots: [path.join(home, 'does-not-exist', 'skills')],
    })
    expect(summary.skills).toEqual([])
    expect(summary.warnings).toEqual([])
  })
})

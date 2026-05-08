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
        scope: 'workspace',
        description: 'Use from workspace.',
        path: path.join(cwd, '.agents', 'skills', 'workspace-skill', 'SKILL.md'),
      },
      {
        name: 'home-skill',
        scope: 'home',
        description: '',
        path: path.join(home, '.agents', 'skills', 'home-skill', 'SKILL.md'),
      },
    ])
    expect(summary.warnings).toEqual([
      expect.stringContaining('Invalid frontmatter in home-skill'),
    ])
  })
})

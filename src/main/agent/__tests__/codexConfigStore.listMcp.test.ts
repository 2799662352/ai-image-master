import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { listMcp, resolveWorkspacePaths } from '../codexConfigStore'

let tmp: string
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'cfg-list-'))
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function seed(home: string, cwd: string, personal: string, workspace?: string) {
  await mkdir(path.join(home, '.codex'), { recursive: true })
  await writeFile(path.join(home, '.codex', 'config.toml'), personal, 'utf8')
  if (workspace !== undefined) {
    await mkdir(path.join(cwd, '.codex'), { recursive: true })
    await writeFile(path.join(cwd, '.codex', 'workspace-mcp.toml'), workspace, 'utf8')
  }
}

describe('listMcp', () => {
  it('returns entries from both scopes with redacted env keys', async () => {
    const home = path.join(tmp, 'home')
    const cwd = path.join(tmp, 'proj')
    await mkdir(home, { recursive: true })
    await mkdir(cwd, { recursive: true })
    await seed(
      home,
      cwd,
      `[mcp_servers.github]\ncommand = "docker"\nargs = ["run", "--rm", "img"]\n[mcp_servers.github.env]\nGITHUB_TOKEN = "ghp_xxx"\n`,
      `[mcp_servers.local]\ncommand = "node"\nargs = ["server.js"]\n`,
    )
    const paths = resolveWorkspacePaths({ home, cwd, userData: tmp })
    const result = await listMcp(paths)
    const byName = Object.fromEntries(result.map((s) => [s.name, s]))
    expect(byName.github.scope).toBe('personal')
    expect(byName.github.envKeysRedacted).toContain('GITHUB_TOKEN')
    expect(byName.github.argsSummary).toContain('docker')
    expect(byName.local.scope).toBe('workspace')
  })

  it('returns empty when neither file exists', async () => {
    const home = path.join(tmp, 'home2')
    const cwd = path.join(tmp, 'proj2')
    await mkdir(home, { recursive: true })
    await mkdir(cwd, { recursive: true })
    const paths = resolveWorkspacePaths({ home, cwd, userData: tmp })
    const result = await listMcp(paths)
    expect(result).toEqual([])
  })
})

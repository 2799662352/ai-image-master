import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { getMcpDetail, resolveWorkspacePaths } from '../codexConfigStore'

let tmp: string
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'cfg-detail-'))
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('getMcpDetail', () => {
  it('returns clear-text env values when explicitly requested', async () => {
    const home = path.join(tmp, 'home')
    const cwd = path.join(tmp, 'proj')
    await mkdir(path.join(home, '.codex'), { recursive: true })
    await mkdir(cwd, { recursive: true })
    await writeFile(
      path.join(home, '.codex', 'config.toml'),
      `[mcp_servers.github]\ncommand = "docker"\nargs = ["run"]\n[mcp_servers.github.env]\nGITHUB_TOKEN = "ghp_secret"\n`,
      'utf8',
    )
    const paths = resolveWorkspacePaths({ home, cwd, userData: tmp })
    const detail = await getMcpDetail(paths, 'personal:github')
    expect(detail).toBeDefined()
    expect(detail!.name).toBe('github')
    expect(detail!.scope).toBe('personal')
    expect(detail!.env).toEqual([{ key: 'GITHUB_TOKEN', value: 'ghp_secret' }])
  })

  it('returns null for unknown id', async () => {
    const home = path.join(tmp, 'h')
    const cwd = path.join(tmp, 'c')
    await mkdir(home, { recursive: true })
    await mkdir(cwd, { recursive: true })
    const paths = resolveWorkspacePaths({ home, cwd, userData: tmp })
    expect(await getMcpDetail(paths, 'personal:nope')).toBeNull()
  })
})

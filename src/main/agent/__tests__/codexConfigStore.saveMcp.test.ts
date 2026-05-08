import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { saveMcp, listMcp, resolveWorkspacePaths } from '../codexConfigStore'

let tmp: string
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'cfg-save-'))
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function setup() {
  const home = path.join(tmp, 'home')
  const cwd = path.join(tmp, 'proj')
  await mkdir(home, { recursive: true })
  await mkdir(cwd, { recursive: true })
  return resolveWorkspacePaths({ home, cwd, userData: tmp })
}

function baseInput(over: Partial<Parameters<typeof saveMcp>[1]>) {
  return {
    name: 'github',
    scope: 'personal' as const,
    enabled: true,
    command: 'docker',
    args: [] as string[],
    env: [] as Array<{ key: string; value: string }>,
    ...over,
  }
}

describe('saveMcp', () => {
  it('writes a personal MCP entry and is round-trippable via listMcp', async () => {
    const paths = await setup()
    const result = await saveMcp(paths, {
      name: 'github',
      scope: 'personal',
      enabled: true,
      command: 'docker',
      args: ['run', '--rm', 'ghcr.io/github/github-mcp-server'],
      env: [{ key: 'GITHUB_TOKEN', value: 'ghp_xxx' }],
    })
    expect(result.ok).toBe(true)
    const list = await listMcp(paths)
    expect(list.find((s) => s.name === 'github')?.scope).toBe('personal')
    const onDisk = await readFile(paths.personalConfigToml, 'utf8')
    expect(onDisk).toContain('[mcp_servers.github]')
  })

  it('rejects names with path separators or NUL', async () => {
    const paths = await setup()
    expect((await saveMcp(paths, baseInput({ name: 'a/b' }))).ok).toBe(false)
    expect((await saveMcp(paths, baseInput({ name: '..' }))).ok).toBe(false)
    expect((await saveMcp(paths, baseInput({ name: 'x\0y' }))).ok).toBe(false)
    expect((await saveMcp(paths, baseInput({ name: '' }))).ok).toBe(false)
  })

  it('overwrites existing entry by name and scope', async () => {
    const paths = await setup()
    await saveMcp(paths, baseInput({ command: 'old' }))
    await saveMcp(paths, baseInput({ command: 'new' }))
    const detail = (await listMcp(paths)).find((s) => s.name === 'github')!
    expect(detail.command).toBe('new')
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CodexLocalBackend, rebuildRuntimeConfig } from '../CodexLocalBackend'
import { resolveWorkspacePaths } from '../codexConfigStore'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'rt-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('rebuildRuntimeConfig', () => {
  it('writes merged config to runtime path and is idempotent', async () => {
    const home = path.join(tmp, 'h')
    const cwd = path.join(tmp, 'p')
    await mkdir(path.join(home, '.codex'), { recursive: true })
    await mkdir(path.join(cwd, '.codex'), { recursive: true })
    await writeFile(
      path.join(home, '.codex', 'config.toml'),
      '[mcp_servers.foo]\ncommand = "x"\nargs = []\n',
      'utf8',
    )
    await writeFile(
      path.join(cwd, '.codex', 'workspace-mcp.toml'),
      '[mcp_servers.foo]\ncommand = "override"\nargs = []\n',
      'utf8',
    )

    const paths = resolveWorkspacePaths({ home, cwd, userData: tmp })
    await rebuildRuntimeConfig(paths)
    await rebuildRuntimeConfig(paths)

    const out = await readFile(paths.runtimeConfigToml, 'utf8')
    expect(out).toContain('command = "override"')
  })
})

describe('CodexLocalBackend.applyConfigChange', () => {
  it('rebuilds runtime config and marks config dirty', async () => {
    const home = path.join(tmp, 'h')
    const cwd = path.join(tmp, 'p')
    await mkdir(path.join(home, '.codex'), { recursive: true })
    await mkdir(path.join(cwd, '.codex'), { recursive: true })
    await writeFile(
      path.join(home, '.codex', 'config.toml'),
      '[mcp_servers.foo]\ncommand = "x"\nargs = []\n',
      'utf8',
    )
    await writeFile(
      path.join(cwd, '.codex', 'workspace-mcp.toml'),
      '[mcp_servers.foo]\ncommand = "override"\nargs = []\n',
      'utf8',
    )

    const paths = resolveWorkspacePaths({ home, cwd, userData: tmp })
    const backend = new CodexLocalBackend({ wsUrl: 'ws://127.0.0.1:1' })

    expect(backend.isConfigDirty()).toBe(false)
    await backend.applyConfigChange(paths)

    const out = await readFile(paths.runtimeConfigToml, 'utf8')
    expect(out).toContain('command = "override"')
    expect(backend.isConfigDirty()).toBe(true)
  })
})

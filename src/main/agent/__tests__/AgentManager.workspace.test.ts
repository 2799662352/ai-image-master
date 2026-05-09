import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentManager } from '../AgentManager'
import type { AgentInput, IAgentBackend } from '../types'
import type { CodexWorkspacePaths } from '../../../types/agent'

interface StubBackend extends IAgentBackend {
  applyCalls: CodexWorkspacePaths[]
  restartCalls: CodexWorkspacePaths[]
}

function makeStubBackend(options: { applyConfigChange?: boolean; restartCodex?: boolean } = {}): StubBackend {
  const applyCalls: CodexWorkspacePaths[] = []
  const restartCalls: CodexWorkspacePaths[] = []
  const backend: StubBackend = {
    applyCalls,
    restartCalls,
    async start() {},
    async stop() {},
    async *send(_threadId: string | undefined, _input: AgentInput) {},
    async cancel() {},
    isHealthy() { return true },
  }

  if (options.applyConfigChange !== false) {
    backend.applyConfigChange = async (paths) => {
      applyCalls.push(paths)
    }
  }
  if (options.restartCodex !== false) {
    backend.restartCodex = async (paths) => {
      restartCalls.push(paths)
    }
  }

  return backend
}

async function makeManager(backend = makeStubBackend()) {
  const workspace = path.join(tmpDir, 'workspace')
  await fs.mkdir(workspace, { recursive: true })
  const mgr = new AgentManager({ userDataDir: tmpDir, backend })
  await mgr.setAllowedRoots([workspace])
  return { mgr, backend, workspace }
}

function expectWorkspacePaths(paths: CodexWorkspacePaths, workspace: string) {
  expect(paths.workspaceConfigToml).toBe(path.join(workspace, '.codex', 'workspace-mcp.toml'))
  expect(paths.workspaceSkillsRoot).toBe(path.join(workspace, '.agents', 'skills'))
  expect(paths.runtimeConfigToml).toBe(path.join(tmpDir, 'codex-runtime', 'config.toml'))
  expect(paths.auditLogPath).toBe(path.join(tmpDir, 'codex-runtime', 'audit.log'))
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-mgr-workspace-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('AgentManager workspace surface', () => {
  it('exposes MCP, skill, log, and restart methods through the manager', () => {
    const mgr = new AgentManager({ userDataDir: tmpDir, backend: makeStubBackend() })

    expect(typeof (mgr as any).listMcp).toBe('function')
    expect(typeof (mgr as any).getMcpDetail).toBe('function')
    expect(typeof (mgr as any).saveMcp).toBe('function')
    expect(typeof (mgr as any).deleteMcp).toBe('function')
    expect(typeof (mgr as any).setMcpEnabled).toBe('function')
    expect(typeof (mgr as any).listSkills).toBe('function')
    expect(typeof (mgr as any).getSkillDetail).toBe('function')
    expect(typeof (mgr as any).saveSkill).toBe('function')
    expect(typeof (mgr as any).deleteSkill).toBe('function')
    expect(typeof (mgr as any).getWorkspaceLogs).toBe('function')
    expect(typeof (mgr as any).restartCodex).toBe('function')
  })

  it('saveMcp writes workspace MCP under the allowed root and refreshes backend config with injected user data paths', async () => {
    const { mgr, backend, workspace } = await makeManager()

    const result = await mgr.saveMcp({
      scope: 'workspace',
      name: 'playwright',
      enabled: true,
      command: 'npx',
      args: ['@playwright/mcp@latest'],
      env: [],
      description: 'Browser automation',
    })

    expect(result).toMatchObject({ ok: true, id: 'workspace:playwright' })
    const workspaceMcpPath = path.join(workspace, '.codex', 'workspace-mcp.toml')
    await expect(fs.readFile(workspaceMcpPath, 'utf8')).resolves.toContain('command = "npx"')
    expect(backend.applyCalls).toHaveLength(1)
    expectWorkspacePaths(backend.applyCalls[0], workspace)
  })

  it('failed saveMcp returns an error and does not refresh backend config', async () => {
    const { mgr, backend } = await makeManager()

    const result = await mgr.saveMcp({
      scope: 'workspace',
      name: '../bad',
      enabled: true,
      command: 'npx',
      args: [],
      env: [],
      description: '',
    })

    expect(result).toMatchObject({ ok: false })
    expect(backend.applyCalls).toHaveLength(0)
  })

  it('successful saveMcp throws a capability error when backend config refresh is unavailable', async () => {
    const { mgr, workspace } = await makeManager(makeStubBackend({ applyConfigChange: false }))

    await expect(mgr.saveMcp({
      scope: 'workspace',
      name: 'filesystem',
      enabled: true,
      command: 'node',
      args: ['server.js'],
      env: [],
      description: '',
    })).rejects.toThrow('Codex config refresh API is unavailable')

    await expect(
      fs.readFile(path.join(workspace, '.codex', 'workspace-mcp.toml'), 'utf8'),
    ).resolves.toContain('command = "node"')
  })

  it('saveSkill writes workspace skills under the allowed root and does not refresh backend config', async () => {
    const { mgr, backend, workspace } = await makeManager()

    const result = await mgr.saveSkill({
      scope: 'workspace',
      name: 'triage',
      description: 'Triage helper',
      whenToUse: 'Use for issue triage',
      instructions: 'Review the issue and summarize next steps.',
    })

    expect(result).toMatchObject({ ok: true, id: 'workspace:triage' })
    const skillPath = path.join(workspace, '.agents', 'skills', 'triage', 'SKILL.md')
    await expect(fs.readFile(skillPath, 'utf8')).resolves.toContain('Review the issue')
    expect(backend.applyCalls).toHaveLength(0)
  })

  it('restartCodex passes workspace paths using the allowed root and injected user data dir', async () => {
    const { mgr, backend, workspace } = await makeManager()

    await mgr.restartCodex()

    expect(backend.restartCalls).toHaveLength(1)
    expectWorkspacePaths(backend.restartCalls[0], workspace)
  })
})

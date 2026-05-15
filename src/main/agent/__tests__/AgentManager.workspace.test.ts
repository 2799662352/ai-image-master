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
  it('exposes skill, log, and restart methods through the manager', () => {
    const mgr = new AgentManager({ userDataDir: tmpDir, backend: makeStubBackend() })

    expect(typeof (mgr as any).listSkills).toBe('function')
    expect(typeof (mgr as any).getSkillDetail).toBe('function')
    expect(typeof (mgr as any).saveSkill).toBe('function')
    expect(typeof (mgr as any).deleteSkill).toBe('function')
    expect(typeof (mgr as any).getWorkspaceLogs).toBe('function')
    expect(typeof (mgr as any).restartCodex).toBe('function')
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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentManager } from '../AgentManager'
import type { AgentInput, IAgentBackend } from '../types'

function makeStubBackend(): IAgentBackend {
  return {
    async start() {},
    async stop() {},
    async *send(_threadId: string | undefined, _input: AgentInput) {},
    async cancel() {},
    isHealthy() { return true },
  }
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
})

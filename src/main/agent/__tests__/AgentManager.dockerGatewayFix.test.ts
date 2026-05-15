/**
 * E2E choreography test for AgentManager.dockerGatewayFixRpc.
 *
 * We don't spin up a real Codex backend or real `docker` here. Instead:
 *  - Stub `IAgentBackend` with `readConfig` / `batchWriteConfig` / `reloadMcpServers`.
 *  - Replace the singleton DockerMcpGatewayService with a fully-mocked one
 *    whose check/addServers/start/stop just return canned values.
 *  - Verify the orchestration calls things in the right order with the
 *    right arguments and produces the expected `mcp_servers` mutation.
 */

import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentManager } from '../AgentManager'
import { __setDockerMcpGatewayServiceForTests, type DockerMcpGatewayService } from '../dockerMcpGateway'
import { GATEWAY_PROFILE_NAME, GATEWAY_SERVER_NAME } from '../dockerMcpFix'

function makeFakeBackend(initialConfig: any) {
  const calls: any = { batchWriteConfig: [] as any[], reload: 0 }
  const backend = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendUserMessage: vi.fn(),
    cancel: vi.fn(),
    onEvent: vi.fn(),
    onApprovalRequest: vi.fn(),
    onMcpNotification: vi.fn(),
    respondToApproval: vi.fn(),
    setSessionConfig: vi.fn(),
    setAllowedRoots: vi.fn(),
    listMcpServers: vi.fn().mockResolvedValue({}),
    readConfig: vi.fn().mockResolvedValue({ config: initialConfig }),
    batchWriteConfig: vi.fn(async (edits: any[]) => {
      calls.batchWriteConfig.push(edits)
      return undefined
    }),
    writeConfigValue: vi.fn(),
    reloadMcpServers: vi.fn(async () => {
      calls.reload += 1
    }),
    mcpOAuthLogin: vi.fn(),
    mcpToolCall: vi.fn(),
  }
  return { backend, calls }
}

function makeFakeGateway(): DockerMcpGatewayService & {
  __calls: { check: number; addServers: any[]; start: any[]; stop: number }
} {
  const __calls = { check: 0, addServers: [] as any[], start: [] as any[], stop: 0 }
  const svc = {
    __calls,
    checkInstalled: vi.fn(async () => {
      __calls.check += 1
      return { installed: true, version: 'docker mcp v0.10.0' }
    }),
    addServersToProfile: vi.fn(async (profileName: string, images: string[]) => {
      __calls.addServers.push({ profileName, images })
    }),
    start: vi.fn(async (args: any) => {
      __calls.start.push(args)
      return { running: true, port: args.port, pid: 999, profile: args.profile }
    }),
    stop: vi.fn(async () => {
      __calls.stop += 1
    }),
    getStatus: vi.fn(() => ({ running: false, port: null, pid: null, profile: null })),
  } as unknown as DockerMcpGatewayService & typeof svc
  return svc as any
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-mgr-dgw-'))
})

afterEach(async () => {
  __setDockerMcpGatewayServiceForTests(null)
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

describe('AgentManager.dockerGatewayFixRpc', () => {
  it('happy path: check → addServers → start → batchWriteConfig (delete + add)', async () => {
    const config = {
      mcp_servers: {
        sequentialthinking: { command: 'docker', args: ['run', '--rm', '-i', 'mcp/sequentialthinking'] },
        dockerhub: { command: 'docker', args: ['run', '--rm', '-i', '-e', 'HUB_PAT_TOKEN', 'mcp/dockerhub'] },
        // Should be left alone:
        context7: { url: 'https://mcp.context7.com/mcp' },
        puppeteer: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] },
      },
    }
    const { backend, calls } = makeFakeBackend(config)
    const gw = makeFakeGateway()
    __setDockerMcpGatewayServiceForTests(gw)

    const mgr = new AgentManager({ userDataDir: tmpDir })
    ;(mgr as any).backend = backend

    const res = await mgr.dockerGatewayFixRpc({ port: 8811 })

    expect(res.ok).toBe(true)
    expect(res.converted).toEqual(['sequentialthinking', 'dockerhub'])
    expect(res.gatewayPort).toBe(8811)

    // Check ordering: check first, then profile, then start, then config write
    expect(gw.checkInstalled).toHaveBeenCalledTimes(1)
    expect(gw.addServersToProfile).toHaveBeenCalledWith(
      GATEWAY_PROFILE_NAME,
      ['mcp/sequentialthinking', 'mcp/dockerhub'],
    )
    expect(gw.start).toHaveBeenCalledWith({ port: 8811, profile: GATEWAY_PROFILE_NAME })

    // batchWriteConfig should remove both docker entries and add the gateway entry
    expect(backend.batchWriteConfig).toHaveBeenCalledTimes(1)
    const edits = calls.batchWriteConfig[0]
    expect(edits).toContainEqual({ keyPath: 'mcp_servers.sequentialthinking', value: null, mergeStrategy: 'replace' })
    expect(edits).toContainEqual({ keyPath: 'mcp_servers.dockerhub', value: null, mergeStrategy: 'replace' })
    expect(edits).toContainEqual({
      keyPath: `mcp_servers.${GATEWAY_SERVER_NAME}`,
      value: { url: 'http://127.0.0.1:8811/sse' },
      mergeStrategy: 'replace',
    })
    // context7 / puppeteer must NOT be touched
    expect(edits.find((e: any) => e.keyPath === 'mcp_servers.context7')).toBeUndefined()
    expect(edits.find((e: any) => e.keyPath === 'mcp_servers.puppeteer')).toBeUndefined()
  })

  it('returns ok=false with a clear error if `docker mcp` is not installed', async () => {
    const { backend } = makeFakeBackend({ mcp_servers: { x: { command: 'docker', args: ['run', '-i', 'mcp/x'] } } })
    const gw = makeFakeGateway()
    ;(gw.checkInstalled as any).mockResolvedValueOnce({ installed: false, error: 'docker not found' })
    __setDockerMcpGatewayServiceForTests(gw)

    const mgr = new AgentManager({ userDataDir: tmpDir })
    ;(mgr as any).backend = backend

    const res = await mgr.dockerGatewayFixRpc()

    expect(res.ok).toBe(false)
    expect(res.error).toContain('docker not found')
    expect(gw.start).not.toHaveBeenCalled()
    expect(backend.batchWriteConfig).not.toHaveBeenCalled()
  })

  it('returns ok=false when there are no docker stdio servers to convert', async () => {
    const { backend } = makeFakeBackend({
      mcp_servers: { context7: { url: 'https://mcp.context7.com/mcp' } },
    })
    const gw = makeFakeGateway()
    __setDockerMcpGatewayServiceForTests(gw)

    const mgr = new AgentManager({ userDataDir: tmpDir })
    ;(mgr as any).backend = backend

    const res = await mgr.dockerGatewayFixRpc()

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/没有.*docker.*MCP|nothing to fix/)
    expect(gw.start).not.toHaveBeenCalled()
    expect(backend.batchWriteConfig).not.toHaveBeenCalled()
  })

  it('does not mutate config when gateway start fails', async () => {
    const { backend } = makeFakeBackend({
      mcp_servers: { x: { command: 'docker', args: ['run', '-i', 'mcp/x'] } },
    })
    const gw = makeFakeGateway()
    ;(gw.start as any).mockRejectedValueOnce(new Error('port already in use'))
    __setDockerMcpGatewayServiceForTests(gw)

    const mgr = new AgentManager({ userDataDir: tmpDir })
    ;(mgr as any).backend = backend

    const res = await mgr.dockerGatewayFixRpc({ port: 8811 })

    expect(res.ok).toBe(false)
    expect(res.error).toContain('port already in use')
    expect(backend.batchWriteConfig).not.toHaveBeenCalled()
  })

  it('translates "profile already exists" into an actionable message', async () => {
    const { backend } = makeFakeBackend({
      mcp_servers: { x: { command: 'docker', args: ['run', '-i', 'mcp/x'] } },
    })
    const gw = makeFakeGateway()
    ;(gw.addServersToProfile as any).mockRejectedValueOnce(new Error('error: profile already exists'))
    __setDockerMcpGatewayServiceForTests(gw)

    const mgr = new AgentManager({ userDataDir: tmpDir })
    ;(mgr as any).backend = backend

    const res = await mgr.dockerGatewayFixRpc()

    expect(res.ok).toBe(false)
    expect(res.error).toContain(GATEWAY_PROFILE_NAME)
    expect(res.error).toContain('profile remove')
  })
})

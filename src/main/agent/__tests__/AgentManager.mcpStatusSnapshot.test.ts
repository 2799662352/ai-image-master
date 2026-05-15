/**
 * AgentManager caches the latest `mcp_status_updated` event per server name
 * so that `getMcpStatusSnapshotRpc()` can replay them when the renderer
 * subscribes (often AFTER codex has already finished MCP startup).
 *
 * Without this cache, every status dot stayed grey forever — see issue
 * `#agent-mcp-status-grey` for the full reproduction.
 */

import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentManager } from '../AgentManager'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-snapshot-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

function fakeBackend() {
  let captured: ((event: any) => void) | undefined
  const backend = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendUserMessage: vi.fn(),
    cancel: vi.fn(),
    onEvent: vi.fn(),
    onApprovalRequest: vi.fn(),
    onMcpNotification: vi.fn((handler: (event: any) => void) => {
      captured = handler
    }),
    respondToApproval: vi.fn(),
    setSessionConfig: vi.fn(),
    setAllowedRoots: vi.fn(),
    listMcpServers: vi.fn(),
    readConfig: vi.fn(),
    batchWriteConfig: vi.fn(),
    writeConfigValue: vi.fn(),
    reloadMcpServers: vi.fn(),
    mcpOAuthLogin: vi.fn(),
    mcpToolCall: vi.fn(),
  }
  return {
    backend,
    emit: (event: any) => captured?.(event),
  }
}

describe('AgentManager mcp status snapshot cache', () => {
  it('captures mcp_status_updated events into a per-name cache', () => {
    const { backend, emit } = fakeBackend()
    const mgr = new AgentManager({ userDataDir: tmpDir, backend: backend as any })
    // AgentManager re-wires onMcpNotification via the constructor's default
    // backend factory — but since we passed a custom backend, we have to
    // wire it ourselves the same way the manager does internally.
    ;(mgr as any).attachMcpNotificationHandler()

    emit({ type: 'mcp_status_updated', name: 'gh', status: 'starting', error: null })
    emit({ type: 'mcp_status_updated', name: 'gh', status: 'ready', error: null })
    emit({ type: 'mcp_status_updated', name: 'broken', status: 'failed', error: 'spawn ENOENT' })

    const snap = mgr.getMcpStatusSnapshotRpc()
    expect(snap).toEqual({
      ok: true,
      snapshot: {
        gh: { status: 'ready', error: null },
        broken: { status: 'failed', error: 'spawn ENOENT' },
      },
    })
  })

  it('non-status events (e.g. mcp_oauth_completed) do not pollute the cache', () => {
    const { backend, emit } = fakeBackend()
    const mgr = new AgentManager({ userDataDir: tmpDir, backend: backend as any })
    ;(mgr as any).attachMcpNotificationHandler()

    emit({ type: 'mcp_oauth_completed', name: 'gh', success: true })
    emit({ type: 'mcp_status_updated', name: 'gh', status: 'ready', error: null })

    expect(mgr.getMcpStatusSnapshotRpc()).toEqual({
      ok: true,
      snapshot: { gh: { status: 'ready', error: null } },
    })
  })
})

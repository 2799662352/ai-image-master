import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'

const mockDockerGatewayFix = vi.fn()
const mockApi = {
  dockerGatewayFix: mockDockerGatewayFix,
  readConfig: vi.fn(),
  listMcpServersRpc: vi.fn(),
  batchWriteConfig: vi.fn(),
  writeConfigValue: vi.fn(),
  reloadMcpServers: vi.fn(),
  mcpOAuthLogin: vi.fn(),
}
;(window as any).electronAPI = { agent: mockApi, shell: { openExternal: vi.fn() } }

const { useMcpStore } = await import('../useMcpStore')
const { useMcpAutoGatewayFix } = await import('../useMcpAutoGatewayFix')

describe('useMcpAutoGatewayFix', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    mockApi.dockerGatewayFix = mockDockerGatewayFix
    useMcpStore.setState({
      servers: [], loading: false, error: null,
      syncing: false, syncError: null,
      lastAutoFix: null, lastConvertedFingerprint: null,
    })
  })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  it('triggers dockerGatewayFix after 2s when docker-stdio servers exist', async () => {
    mockDockerGatewayFix.mockResolvedValue({ ok: true, converted: ['redis'], gatewayPort: 8811 })
    useMcpStore.setState({
      servers: [
        { name: 'redis', type: 'stdio', command: 'docker', args: ['run', 'redis-mcp'], enabled: true, status: 'failed', error: 'bug', tools: [], isBuiltin: false },
      ],
    })
    renderHook(() => useMcpAutoGatewayFix())
    expect(mockDockerGatewayFix).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(2500) })
    expect(mockDockerGatewayFix).toHaveBeenCalledTimes(1)
  })

  it('does not trigger when no docker-stdio servers are present', async () => {
    useMcpStore.setState({
      servers: [
        { name: 'github', type: 'http', url: 'https://mcp.github.com', enabled: true, status: 'ready', error: null, tools: [{ name: 'search' }], isBuiltin: false },
      ],
    })
    renderHook(() => useMcpAutoGatewayFix())
    await act(async () => { vi.advanceTimersByTime(3000) })
    expect(mockDockerGatewayFix).not.toHaveBeenCalled()
  })

  it('does not re-trigger when fingerprint matches lastConvertedFingerprint', async () => {
    useMcpStore.setState({
      servers: [
        { name: 'redis', type: 'stdio', command: 'docker', args: ['run', 'redis'], enabled: true, status: 'failed', error: 'bug', tools: [], isBuiltin: false },
      ],
      lastConvertedFingerprint: 'redis',
    })
    renderHook(() => useMcpAutoGatewayFix())
    await act(async () => { vi.advanceTimersByTime(3000) })
    expect(mockDockerGatewayFix).not.toHaveBeenCalled()
  })

  it('cleans up timer on unmount', async () => {
    useMcpStore.setState({
      servers: [
        { name: 'redis', type: 'stdio', command: 'docker', args: ['run', 'redis'], enabled: true, status: 'failed', error: 'bug', tools: [], isBuiltin: false },
      ],
    })
    const { unmount } = renderHook(() => useMcpAutoGatewayFix())
    unmount()
    await act(async () => { vi.advanceTimersByTime(3000) })
    expect(mockDockerGatewayFix).not.toHaveBeenCalled()
  })
})

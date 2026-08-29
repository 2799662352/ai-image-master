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

  // 下面几个夹具里的 `isAppBundled: false` 是 `McpServerCard` 的必填字段,不是可省的
  // 装饰:它区分「应用自带 vendored 进 resources 的预装项」与用户自加项,列表按它分组
  // (`McpServerList.tsx:48`)。这里的 redis / github 都是用户自加,所以是 false ——
  // 与兄弟测试 `useMcpStore.test.ts` 的每个夹具一致。
  it('triggers dockerGatewayFix after 2s when docker-stdio servers exist', async () => {
    mockDockerGatewayFix.mockResolvedValue({ ok: true, converted: ['redis'], gatewayPort: 8811 })
    useMcpStore.setState({
      servers: [
        { name: 'redis', type: 'stdio', command: 'docker', args: ['run', 'redis-mcp'], enabled: true, status: 'failed', error: 'bug', tools: [], isBuiltin: false, isAppBundled: false },
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
        { name: 'github', type: 'http', url: 'https://mcp.github.com', enabled: true, status: 'ready', error: null, tools: [{ name: 'search' }], isBuiltin: false, isAppBundled: false },
      ],
    })
    renderHook(() => useMcpAutoGatewayFix())
    await act(async () => { vi.advanceTimersByTime(3000) })
    expect(mockDockerGatewayFix).not.toHaveBeenCalled()
  })

  it('does not re-trigger when fingerprint matches lastConvertedFingerprint', async () => {
    useMcpStore.setState({
      servers: [
        { name: 'redis', type: 'stdio', command: 'docker', args: ['run', 'redis'], enabled: true, status: 'failed', error: 'bug', tools: [], isBuiltin: false, isAppBundled: false },
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
        { name: 'redis', type: 'stdio', command: 'docker', args: ['run', 'redis'], enabled: true, status: 'failed', error: 'bug', tools: [], isBuiltin: false, isAppBundled: false },
      ],
    })
    const { unmount } = renderHook(() => useMcpAutoGatewayFix())
    unmount()
    await act(async () => { vi.advanceTimersByTime(3000) })
    expect(mockDockerGatewayFix).not.toHaveBeenCalled()
  })
})

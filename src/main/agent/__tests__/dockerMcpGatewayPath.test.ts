import { describe, expect, it, afterEach } from 'vitest'
import path from 'node:path'

import { getDockerMcpBinaryName, getDockerMcpResourceDir, resolveDockerMcpBinary } from '../dockerMcpGatewayPath'

describe('dockerMcpGatewayPath', () => {
  afterEach(() => {
    delete process.env.DOCKER_MCP_BINARY
  })

  it('returns docker-mcp.exe on Windows', () => {
    expect(getDockerMcpBinaryName('win32')).toBe('docker-mcp.exe')
  })

  it('returns docker-mcp on POSIX', () => {
    expect(getDockerMcpBinaryName('linux')).toBe('docker-mcp')
    expect(getDockerMcpBinaryName('darwin')).toBe('docker-mcp')
  })

  it('builds platform-arch resource dir', () => {
    expect(getDockerMcpResourceDir('/app/resources', 'darwin', 'arm64')).toBe(
      path.join('/app/resources', 'docker-mcp', 'darwin-arm64'),
    )
  })

  it('respects DOCKER_MCP_BINARY env override', () => {
    process.env.DOCKER_MCP_BINARY = '/custom/path/docker-mcp'
    expect(resolveDockerMcpBinary('/ignored')).toBe('/custom/path/docker-mcp')
  })

  it('resolves from resourcesPath in normal mode', () => {
    const resolved = resolveDockerMcpBinary('/app/resources')
    expect(resolved).toContain('docker-mcp')
    expect(resolved).toContain(process.platform)
  })
})

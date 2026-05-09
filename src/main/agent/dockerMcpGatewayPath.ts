import path from 'node:path'

export function getDockerMcpBinaryName(platform = process.platform): string {
  return platform === 'win32' ? 'docker-mcp.exe' : 'docker-mcp'
}

export function getDockerMcpResourceDir(
  resourcesPath: string,
  platform = process.platform,
  arch = process.arch,
): string {
  return path.join(resourcesPath, 'docker-mcp', `${platform}-${arch}`)
}

export function resolveDockerMcpBinary(resourcesPath: string): string {
  if (process.env.DOCKER_MCP_BINARY) return process.env.DOCKER_MCP_BINARY
  return path.join(getDockerMcpResourceDir(resourcesPath), getDockerMcpBinaryName())
}

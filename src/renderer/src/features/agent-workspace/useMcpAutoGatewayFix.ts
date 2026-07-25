import { useEffect } from 'react'
import { getAgentApi } from '../../utils/agentBridge'
import { useMcpStore, type McpServerCard } from './useMcpStore'

function isDockerStdioCandidate(s: McpServerCard): boolean {
  if (s.type === 'http') return false
  if (!s.command) return false
  const cmd = s.command.toLowerCase()
  const isDocker =
    cmd === 'docker' ||
    cmd.endsWith('/docker') ||
    cmd.endsWith('\\docker.exe') ||
    cmd.endsWith('/docker.exe')
  if (!isDocker) return false
  const args = s.args ?? []
  if (args[0] === 'mcp' && args[1] === 'gateway') return false
  return s.status === 'failed' || s.status === 'unknown'
}

function fingerprint(servers: McpServerCard[]): string {
  return servers.map((s) => s.name).sort().join(',')
}

export function useMcpAutoGatewayFix(): void {
  const servers = useMcpStore((s) => s.servers)
  const lastConvertedFingerprint = useMcpStore((s) => s.lastConvertedFingerprint)
  const fetchServers = useMcpStore((s) => s.fetchServers)
  const setLastAutoFix = useMcpStore((s) => s.setLastAutoFix)

  useEffect(() => {
    const candidates = servers.filter(isDockerStdioCandidate)
    if (candidates.length === 0) return

    const fp = fingerprint(candidates)
    if (fp === lastConvertedFingerprint) return

    const timer = setTimeout(async () => {
      const api = getAgentApi()
      if (!api?.dockerGatewayFix) return
      try {
        const res = await api.dockerGatewayFix()
        if (res.ok) {
          useMcpStore.setState({ lastConvertedFingerprint: fp })
          setLastAutoFix({
            count: res.converted?.length ?? 0,
            port: res.gatewayPort ?? 8811,
            ts: Date.now(),
          })
          await fetchServers()
        }
      } catch { /* swallow */ }
    }, 2_000)

    return () => clearTimeout(timer)
  }, [servers, lastConvertedFingerprint, fetchServers, setLastAutoFix])
}

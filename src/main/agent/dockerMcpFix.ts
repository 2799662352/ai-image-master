/**
 * Pure helpers shared between the orchestrator (in AgentManager) and unit
 * tests. Kept separate from `dockerMcpGateway.ts` so the spawn/process
 * machinery doesn't pull these into renderer-adjacent test suites.
 */

export interface DockerStdioEntry {
  name: string
  image: string
}

/**
 * Walk a `docker run ...` argv and pick out the container image. Returns null
 * when the args don't look like a `docker run` invocation we can convert.
 *
 * Recognises:
 *   docker run --rm -i -e HUB_PAT_TOKEN mcp/dockerhub
 *   docker run -i mcp/sequentialthinking
 *   docker run --rm -i -v /tmp:/data mcp/redis
 *
 * Skips flag values for `-e/-v/--env/--volume/--name/--network/--user/...`
 * so they aren't mistaken for the image name.
 */
const FLAGS_TAKING_VALUE = new Set([
  '-e', '--env',
  '-v', '--volume',
  '--name',
  '--network',
  '--user', '-u',
  '--workdir', '-w',
  '--mount',
  '--label', '-l',
  '--add-host',
  '--device',
  '--entrypoint',
  '--platform',
  '--restart',
  '--memory', '-m',
  '--cpus',
  '--env-file',
  '--ulimit',
])

export function extractImageFromDockerArgs(args: string[]): string | null {
  if (args.length === 0 || args[0] !== 'run') return null
  let i = 1
  while (i < args.length) {
    const arg = args[i]
    if (arg === '--') {
      i += 1
      break
    }
    if (arg.startsWith('-')) {
      // `--flag=value` is a single token; skip it.
      if (arg.includes('=')) {
        i += 1
        continue
      }
      // Two-token flags consume their value.
      if (FLAGS_TAKING_VALUE.has(arg)) {
        i += 2
        continue
      }
      // Bare boolean flag like --rm, -i, --tty.
      i += 1
      continue
    }
    // First positional after `run` and its flags is the image.
    return arg
  }
  // Reached end -- if we passed `--`, the next token is the image.
  if (i < args.length) return args[i]
  return null
}

/**
 * Inspect a parsed `[mcp_servers]` table and return the entries that look
 * like docker-run-based stdio servers we can route through the gateway.
 *
 * Skips:
 *   - URL-based entries (already work)
 *   - non-`docker` commands (npx, python, bash wrappers -- those work)
 *   - `docker mcp gateway run` (don't recurse on ourselves)
 *   - explicitly disabled entries
 */
export function selectDockerStdioEntries(mcpServers: Record<string, any> | undefined | null): DockerStdioEntry[] {
  if (!mcpServers || typeof mcpServers !== 'object') return []
  const out: DockerStdioEntry[] = []
  for (const [name, raw] of Object.entries(mcpServers)) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, any>
    if (entry.url) continue
    if (entry.enabled === false) continue
    if (typeof entry.command !== 'string') continue
    const cmd = entry.command.toLowerCase()
    if (!isDockerCommand(cmd)) continue
    const args: string[] = Array.isArray(entry.args) ? entry.args : []
    if (isDockerMcpGatewayInvocation(args)) continue
    const image = extractImageFromDockerArgs(args)
    if (!image) continue
    out.push({ name, image })
  }
  return out
}

function isDockerCommand(lowerCmd: string): boolean {
  if (lowerCmd === 'docker') return true
  return lowerCmd.endsWith('/docker') || lowerCmd.endsWith('\\docker.exe') || lowerCmd.endsWith('/docker.exe')
}

function isDockerMcpGatewayInvocation(args: string[]): boolean {
  // `docker mcp gateway ...` -- don't try to convert the gateway itself.
  return args.length >= 3 && args[0] === 'mcp' && args[1] === 'gateway'
}

/**
 * The single config entry we replace docker-run servers with. Codex consumes
 * this as a URL-mode MCP server, which goes through `rmcp` (HTTP) instead of
 * the stdio→thread registration path that triggers issue #19425.
 *
 * Pinned to localhost so it's not exposed off-machine.
 */
export function buildGatewayConfigEntry(port: number): {
  url: string
} {
  return {
    url: `http://127.0.0.1:${port}/sse`,
  }
}

/**
 * Stable name for the gateway entry in `mcp_servers`. Documented prefix so
 * users can see "this was added by the Docker MCP fix" if they ever inspect
 * `~/.codex/config.toml` by hand.
 */
export const GATEWAY_SERVER_NAME = 'docker_gw'

/** Profile we own. Recreated each time `fix` runs so it always reflects
 * the current set of docker servers. */
export const GATEWAY_PROFILE_NAME = 'catimation-mcp-fix'

/** Default port. Picked to match the docker docs' example port. */
export const GATEWAY_DEFAULT_PORT = 8811

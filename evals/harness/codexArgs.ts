/**
 * Pure builder for the `codex exec --json` argv used by the eval harness.
 *
 * It mirrors the *production* MCP-exposure `-c` flags from
 * `src/main/agent/codexLaunch.ts` (non_prefixed_mcp_tool_names +
 * code_mode.direct_only_tool_namespaces)
 * so the agent SEES tools exactly the way it does in the shipped app — that's
 * the whole point of an eval: reproduce production tool exposure, then assert
 * the agent's decisions. The only intentional differences from production:
 *   - `exec` (one-shot, JSONL on stdout) instead of `app-server` (WS),
 *   - the MCP server points at our stub stdio command, not the real bridge,
 *   - sandbox defaults to `read-only` (evals shouldn't mutate the repo).
 */

import { appendProviderArgs, type CodexProviderConfig } from '../../src/main/agent/codexLaunch'

export type { CodexProviderConfig }

/** `JSON.stringify` doubles as a valid TOML basic-string serializer (handles \\ on Windows paths). */
function quote(value: string): string {
  return JSON.stringify(value)
}

export interface StubMcpRegistration {
  /** MCP server name the agent sees (default `catimation`). */
  name: string
  /** Executable codex spawns for the stub (usually `node` / `process.execPath`). */
  command: string
  /** Args for the stub command (usually `[<abs path to stub.mjs>]`). */
  args: string[]
  /** Extra env for the stub process (e.g. the canned-toolset config). */
  env?: Record<string, string>
  /** Per-tool timeout in seconds (default 120). */
  toolTimeoutSec?: number
}

export interface BuildExecArgsOptions {
  /** The user prompt. When omitted, codex reads the prompt from stdin. */
  prompt?: string
  /** Emit JSONL events on stdout (default true). */
  json?: boolean
  /** Skip codex's "must be a git repo" guard (default true). */
  skipGitRepoCheck?: boolean
  /** Sandbox mode (default `read-only`). */
  sandboxMode?: string
  /** Approval policy (default `never`). */
  approvalPolicy?: string
  /** Model slug passed via `-m`. */
  model?: string
  /** Path to a JSON Schema file for `--output-schema` (rubric scoring). */
  outputSchemaFile?: string
  /** Stub MCP server registration. Omit to run with no MCP server. */
  mcp?: StubMcpRegistration
  /**
   * OpenAI-compatible provider (e.g. the app's apiyi preset). Omit to use the
   * built-in openai provider. We reuse the SHIPPED `appendProviderArgs` so the
   * provider config is byte-for-byte identical to what the running app spawns.
   */
  provider?: CodexProviderConfig
}

function appendStubMcp(args: string[], mcp: StubMcpRegistration): void {
  args.push(
    '-c', `mcp_servers.${mcp.name}.command=${quote(mcp.command)}`,
    '-c', `mcp_servers.${mcp.name}.args=[${mcp.args.map(quote).join(', ')}]`,
  )
  const envEntries = Object.entries(mcp.env ?? {})
  if (envEntries.length > 0) {
    args.push(
      '-c',
      `mcp_servers.${mcp.name}.env={ ${envEntries.map(([k, v]) => `${quote(k)} = ${quote(v)}`).join(', ')} }`,
    )
  }
  args.push('-c', `mcp_servers.${mcp.name}.tool_timeout_sec=${mcp.toolTimeoutSec ?? 120}`)
  // Production tool-exposure flags: make MCP tools directly model-visible
  // (not deferred behind tool_search) so the agent can actually call them by
  // their bare name — identical to the shipped app.
  args.push(
    '-c', 'features.non_prefixed_mcp_tool_names=true',
    '-c', 'features.code_mode.enabled=false',
    '-c', `features.code_mode.direct_only_tool_namespaces=["${mcp.name}", "mcp__${mcp.name}"]`,
  )
}

export function buildExecArgs(options: BuildExecArgsOptions): string[] {
  const args: string[] = ['exec']

  if (options.json ?? true) args.push('--json')
  if (options.skipGitRepoCheck ?? true) args.push('--skip-git-repo-check')

  args.push(
    '-c', `approval_policy="${options.approvalPolicy ?? 'never'}"`,
    '-c', `sandbox_mode="${options.sandboxMode ?? 'read-only'}"`,
  )

  if (options.outputSchemaFile) args.push('--output-schema', options.outputSchemaFile)
  if (options.provider) appendProviderArgs(args, options.provider)
  if (options.mcp) appendStubMcp(args, options.mcp)
  if (options.model) args.push('-m', options.model)
  if (typeof options.prompt === 'string') args.push(options.prompt)

  return args
}

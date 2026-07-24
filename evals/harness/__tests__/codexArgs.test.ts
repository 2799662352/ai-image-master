import { describe, expect, it } from 'vitest'
import { buildExecArgs } from '../codexArgs'

/** Find the value of the i-th `-c key=...` override. */
function configValues(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' && i + 1 < args.length) out.push(args[i + 1])
  }
  return out
}

describe('buildExecArgs', () => {
  it('starts with `exec` and enables JSONL + git-repo skip by default', () => {
    const args = buildExecArgs({ prompt: 'hi' })
    expect(args[0]).toBe('exec')
    expect(args).toContain('--json')
    expect(args).toContain('--skip-git-repo-check')
  })

  it('puts the prompt LAST as a positional arg', () => {
    const args = buildExecArgs({ prompt: 'decide the shot size' })
    expect(args[args.length - 1]).toBe('decide the shot size')
  })

  it('omits the positional prompt when none is given (stdin mode)', () => {
    const args = buildExecArgs({})
    // last token should be a flag/override, never an empty positional
    expect(args[args.length - 1]).not.toBe('')
  })

  it('pins non-interactive sandbox/approval defaults', () => {
    const cfg = configValues(buildExecArgs({ prompt: 'x' }))
    expect(cfg).toContain('approval_policy="never"')
    expect(cfg).toContain('sandbox_mode="read-only"')
  })

  it('mirrors the production MCP tool-exposure flags so the stub behaves like the real server', () => {
    const cfg = configValues(buildExecArgs({ prompt: 'x', mcp: { name: 'catimation', command: 'node', args: ['stub.mjs'] } }))
    expect(cfg).toContain('features.non_prefixed_mcp_tool_names=true')
    expect(cfg).toContain('features.code_mode.enabled=false')
    expect(cfg).toContain('features.code_mode.direct_only_tool_namespaces=["catimation", "mcp__catimation"]')
  })

  it('registers the stub MCP as a stdio server (command + args + timeout)', () => {
    const cfg = configValues(
      buildExecArgs({ prompt: 'x', mcp: { name: 'catimation', command: 'node', args: ['C:\\a\\stub.mjs'], toolTimeoutSec: 90 } }),
    )
    expect(cfg).toContain('mcp_servers.catimation.command="node"')
    // Windows backslashes must survive as valid TOML basic-string escapes
    expect(cfg).toContain('mcp_servers.catimation.args=["C:\\\\a\\\\stub.mjs"]')
    expect(cfg).toContain('mcp_servers.catimation.tool_timeout_sec=90')
  })

  it('serializes the stub env as a TOML inline table', () => {
    const cfg = configValues(
      buildExecArgs({ prompt: 'x', mcp: { name: 'catimation', command: 'node', args: ['s.mjs'], env: { STUB_MCP_CONFIG: '{"a":1}' } } }),
    )
    expect(cfg.some((c) => c.startsWith('mcp_servers.catimation.env='))).toBe(true)
    const envLine = cfg.find((c) => c.startsWith('mcp_servers.catimation.env='))!
    expect(envLine).toContain('"STUB_MCP_CONFIG"')
  })

  it('does NOT register an mcp server when none is provided', () => {
    const cfg = configValues(buildExecArgs({ prompt: 'x' }))
    expect(cfg.some((c) => c.startsWith('mcp_servers.'))).toBe(false)
  })

  it('wires the apiyi provider via the shipped Responses configuration', () => {
    const cfg = configValues(
      buildExecArgs({
        prompt: 'x',
        provider: { id: 'apiyi', name: 'API Yi', baseUrl: 'https://api.apiyi.com/v1', envKey: 'OPENAI_API_KEY' },
      }),
    )
    expect(cfg).toContain('model_provider="apiyi"')
    expect(cfg).toContain('model_providers.apiyi.name="API Yi"')
    expect(cfg).toContain('model_providers.apiyi.base_url="https://api.apiyi.com/v1"')
    expect(cfg).toContain('model_providers.apiyi.env_key="OPENAI_API_KEY"')
    expect(cfg).toContain('model_providers.apiyi.wire_api="responses"')
    expect(cfg).not.toContain('model_providers.apiyi.namespace_tools=false')
  })

  it('carries optional provider fields (model/reasoning/requires_openai_auth) for presets like Right.Codes', () => {
    const cfg = configValues(
      buildExecArgs({
        prompt: 'x',
        provider: {
          id: 'rightcode',
          name: 'Right.Codes',
          baseUrl: 'https://rightapi.ai/codex/v1',
          envKey: 'OPENAI_API_KEY',
          model: 'gpt-5.2',
          reasoningEffort: 'xhigh',
          requiresOpenaiAuth: true,
        },
      }),
    )
    expect(cfg).toContain('model="gpt-5.2"')
    expect(cfg).toContain('model_reasoning_effort="xhigh"')
    expect(cfg).toContain('model_providers.rightcode.requires_openai_auth=true')
  })

  it('passes the model via -m when given', () => {
    const args = buildExecArgs({ prompt: 'x', model: 'gpt-5.4-mini' })
    const i = args.indexOf('-m')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe('gpt-5.4-mini')
  })

  it('adds --output-schema when an output schema file is given', () => {
    const args = buildExecArgs({ prompt: 'x', outputSchemaFile: 'C:\\schemas\\d.json' })
    const i = args.indexOf('--output-schema')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe('C:\\schemas\\d.json')
  })
})

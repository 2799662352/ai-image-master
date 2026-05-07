import { describe, expect, it } from 'vitest'
import { buildCodexLaunchArgs, DEFAULT_LISTEN_URL } from '../codexLaunch'

describe('buildCodexLaunchArgs', () => {
  it('uses app-server with the default listen URL and unrestricted defaults', () => {
    const args = buildCodexLaunchArgs()
    expect(DEFAULT_LISTEN_URL).toBe('ws://127.0.0.1:7345')
    expect(args).toEqual([
      'app-server',
      '--listen', DEFAULT_LISTEN_URL,
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_mode="danger-full-access"',
      '-c', 'tools.web_search=false',
    ])
  })

  it('respects a custom listen URL while keeping the permissive overrides after --listen', () => {
    const args = buildCodexLaunchArgs({ listenUrl: 'ws://127.0.0.1:9999' })
    expect(args).toEqual([
      'app-server',
      '--listen', 'ws://127.0.0.1:9999',
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_mode="danger-full-access"',
      '-c', 'tools.web_search=false',
    ])
    const listenIdx = args.indexOf('--listen')
    const firstConfigIdx = args.indexOf('-c')
    expect(firstConfigIdx).toBeGreaterThan(listenIdx)
  })

  // Regression: Codex 0.128 `app-server` registers the native Responses
  // `web_search` tool by default. Most third-party OpenAI-compatible
  // gateways (apiyi etc.) reject `tools[i].type="web_search"` with a 400
  // ("Supported values: 'function' and 'custom'"). The launch args must
  // explicitly disable it so the tools array stays portable across providers.
  it('disables tools.web_search by default to keep tools portable across providers', () => {
    const baseline = buildCodexLaunchArgs()
    expect(pairs(baseline)).toContainEqual(['-c', 'tools.web_search=false'])

    const withProvider = buildCodexLaunchArgs({
      provider: {
        id: 'apiyi',
        name: 'API Yi',
        baseUrl: 'https://api.apiyi.com/v1',
        envKey: 'OPENAI_API_KEY',
      },
    })
    expect(pairs(withProvider)).toContainEqual(['-c', 'tools.web_search=false'])
  })

  it('does not include the legacy `serve` subcommand', () => {
    const args = buildCodexLaunchArgs()
    expect(args).not.toContain('serve')
  })

  it('configures the active provider via -c overrides when provider config is given', () => {
    const args = buildCodexLaunchArgs({
      provider: {
        id: 'apiyi',
        name: 'API Yi',
        baseUrl: 'https://api.apiyi.com/v1',
        envKey: 'OPENAI_API_KEY',
      },
    })

    // Top-level model_provider must point to our custom id
    expect(pairs(args)).toContainEqual(['-c', 'model_provider="apiyi"'])
    // Provider table must carry name, base_url, env_key
    expect(pairs(args)).toContainEqual(['-c', 'model_providers.apiyi.name="API Yi"'])
    expect(pairs(args)).toContainEqual(['-c', 'model_providers.apiyi.base_url="https://api.apiyi.com/v1"'])
    expect(pairs(args)).toContainEqual(['-c', 'model_providers.apiyi.env_key="OPENAI_API_KEY"'])
    // We must NOT set wire_api (defaults to "responses", which is the only
    // supported value in Codex 0.128) and must NOT set supports_websockets
    // (defaults to false for custom providers, which we want — apiyi proxies
    // the Responses HTTP API, not the wss:// path).
    const flat = args.join(' ')
    expect(flat).not.toContain('wire_api')
    expect(flat).not.toContain('supports_websockets')
  })

  it('omits provider overrides when no provider config is supplied', () => {
    const args = buildCodexLaunchArgs()
    const flat = args.join(' ')
    expect(flat).not.toContain('model_provider')
    expect(flat).not.toContain('model_providers.')
  })
})

// ts-ignore-next: helper for config pair assertions
function pairs(args: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-c') out.push(['-c', args[i + 1]])
  }
  return out
}

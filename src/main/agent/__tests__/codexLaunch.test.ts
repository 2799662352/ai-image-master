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
      // Codex defaults to suppressing raw reasoning ("show_raw_agent_reasoning=false")
      // and only emits a summary when the model returns one. For our local
      // chat panel we WANT to surface reasoning so the "Thought" card has
      // something to show — without these two knobs the card stays empty
      // even when reasoningOutputTokens > 0.
      '-c', 'show_raw_agent_reasoning=true',
      '-c', 'model_reasoning_summary="auto"',
    ])
  })

  it('respects a custom listen URL while keeping the permissive overrides after --listen', () => {
    const args = buildCodexLaunchArgs({ listenUrl: 'ws://127.0.0.1:9999' })
    expect(args).toEqual([
      'app-server',
      '--listen', 'ws://127.0.0.1:9999',
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_mode="danger-full-access"',
      '-c', 'show_raw_agent_reasoning=true',
      '-c', 'model_reasoning_summary="auto"',
    ])
    const listenIdx = args.indexOf('--listen')
    const firstConfigIdx = args.indexOf('-c')
    expect(firstConfigIdx).toBeGreaterThan(listenIdx)
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
    // CRITICAL: must explicitly pin `wire_api="responses"`. Codex 0.128 (after
    // openai/codex#13592) prefers `responses_websocket` for custom providers
    // and falls through to `wss://api.openai.com/v1/responses`, returning
    // 401 + a "Reconnecting...N/5" warning loop. We need plain HTTP Responses
    // API which apiyi actually proxies (https://docs.apiyi.com/api-capabilities/openai-responses).
    expect(pairs(args)).toContainEqual(['-c', 'model_providers.apiyi.wire_api="responses"'])
    // The deprecated `supports_websockets` field was removed in 0.128 — never
    // set it; passing it would just be noise.
    const flat = args.join(' ')
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

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
    ])
  })

  it('respects a custom listen URL while keeping the permissive overrides after --listen', () => {
    const args = buildCodexLaunchArgs({ listenUrl: 'ws://127.0.0.1:9999' })
    expect(args).toEqual([
      'app-server',
      '--listen', 'ws://127.0.0.1:9999',
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_mode="danger-full-access"',
    ])
    const listenIdx = args.indexOf('--listen')
    const firstConfigIdx = args.indexOf('-c')
    expect(firstConfigIdx).toBeGreaterThan(listenIdx)
  })
})

import { describe, expect, it } from 'vitest'

import {
  buildGatewayConfigEntry,
  extractImageFromDockerArgs,
  GATEWAY_DEFAULT_PORT,
  GATEWAY_SERVER_NAME,
  selectDockerStdioEntries,
} from '../dockerMcpFix'

describe('extractImageFromDockerArgs', () => {
  it('extracts image from a minimal "docker run -i mcp/X"', () => {
    expect(extractImageFromDockerArgs(['run', '-i', 'mcp/sequentialthinking'])).toBe('mcp/sequentialthinking')
  })

  it('extracts image after --rm and -i flags', () => {
    expect(extractImageFromDockerArgs(['run', '--rm', '-i', 'mcp/dockerhub'])).toBe('mcp/dockerhub')
  })

  it('skips two-token flag values (-e ENV)', () => {
    expect(extractImageFromDockerArgs(['run', '--rm', '-i', '-e', 'HUB_PAT_TOKEN', 'mcp/dockerhub'])).toBe('mcp/dockerhub')
  })

  it('skips --flag=value form', () => {
    expect(extractImageFromDockerArgs(['run', '--rm', '--platform=linux/amd64', '-i', 'mcp/redis'])).toBe('mcp/redis')
  })

  it('skips volume mounts', () => {
    expect(extractImageFromDockerArgs(['run', '--rm', '-i', '-v', '/tmp:/data', 'mcp/git'])).toBe('mcp/git')
  })

  it('returns null when args are not a `run` invocation', () => {
    expect(extractImageFromDockerArgs(['ps'])).toBeNull()
    expect(extractImageFromDockerArgs([])).toBeNull()
  })

  it('returns null when no positional image follows the flags', () => {
    expect(extractImageFromDockerArgs(['run', '--rm', '-i'])).toBeNull()
  })

  it('respects the `--` separator and treats next token as image', () => {
    expect(extractImageFromDockerArgs(['run', '--rm', '--', 'mcp/foo'])).toBe('mcp/foo')
  })
})

describe('selectDockerStdioEntries', () => {
  it('returns docker-run entries with extracted image', () => {
    const out = selectDockerStdioEntries({
      sequentialthinking: { command: 'docker', args: ['run', '--rm', '-i', 'mcp/sequentialthinking'] },
      dockerhub: { command: 'docker', args: ['run', '--rm', '-i', '-e', 'HUB_PAT_TOKEN', 'mcp/dockerhub'] },
    })
    expect(out).toEqual([
      { name: 'sequentialthinking', image: 'mcp/sequentialthinking' },
      { name: 'dockerhub', image: 'mcp/dockerhub' },
    ])
  })

  it('skips URL-based servers (they already work)', () => {
    const out = selectDockerStdioEntries({
      context7: { url: 'https://mcp.context7.com/mcp' },
    })
    expect(out).toEqual([])
  })

  it('skips npx/python/bash commands (they already work)', () => {
    const out = selectDockerStdioEntries({
      puppeteer: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'] },
      ffmpeg: { command: 'python', args: ['D:/tools/ffmpeg-mcp/server.py'] },
    })
    expect(out).toEqual([])
  })

  it('skips a `docker mcp gateway run` entry (would cause recursion)', () => {
    const out = selectDockerStdioEntries({
      'mcp-docker': { command: 'docker', args: ['mcp', 'gateway', 'run'] },
    })
    expect(out).toEqual([])
  })

  it('skips disabled entries', () => {
    const out = selectDockerStdioEntries({
      paused: { command: 'docker', args: ['run', '-i', 'mcp/x'], enabled: false },
    })
    expect(out).toEqual([])
  })

  it('handles full-path `docker.exe` on Windows', () => {
    const out = selectDockerStdioEntries({
      x: { command: 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe', args: ['run', '-i', 'mcp/x'] },
    })
    expect(out).toEqual([{ name: 'x', image: 'mcp/x' }])
  })

  it('returns empty array on null/undefined input', () => {
    expect(selectDockerStdioEntries(null)).toEqual([])
    expect(selectDockerStdioEntries(undefined)).toEqual([])
    expect(selectDockerStdioEntries({})).toEqual([])
  })
})

describe('buildGatewayConfigEntry', () => {
  it('emits a localhost SSE URL on the requested port', () => {
    expect(buildGatewayConfigEntry(8811)).toEqual({ url: 'http://127.0.0.1:8811/sse' })
    expect(buildGatewayConfigEntry(9000)).toEqual({ url: 'http://127.0.0.1:9000/sse' })
  })
})

describe('constants', () => {
  it('has stable, documented names', () => {
    expect(GATEWAY_SERVER_NAME).toBe('docker_gw')
    expect(GATEWAY_DEFAULT_PORT).toBe(8811)
  })
})

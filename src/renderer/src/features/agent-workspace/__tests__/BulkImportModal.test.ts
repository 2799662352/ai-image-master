import { describe, it, expect } from 'vitest'

import { parseMcpImportJson } from '../BulkImportModal'

describe('parseMcpImportJson', () => {
  it('parses Cursor mcp.json format (mcpServers key)', () => {
    const input = JSON.stringify({
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'xxx' },
        },
        'context7': {
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp'],
        },
      },
    })
    const result = parseMcpImportJson(input)
    expect(result.ok).toBe(true)
    expect(result.servers).toHaveLength(2)
    expect(result.servers![0].name).toBe('github')
    expect(result.servers![0].config.command).toBe('npx')
    expect(result.servers![0].config.args).toEqual(['-y', '@modelcontextprotocol/server-github'])
    expect(result.servers![0].config.env).toEqual({ GITHUB_TOKEN: 'xxx' })
    expect(result.servers![1].name).toBe('context7')
  })

  it('parses raw Codex format (flat object of server configs)', () => {
    const input = JSON.stringify({
      myserver: { command: 'node', args: ['server.js'] },
      httpserver: { url: 'https://mcp.example.com/sse' },
    })
    const result = parseMcpImportJson(input)
    expect(result.ok).toBe(true)
    expect(result.servers).toHaveLength(2)
    expect(result.servers![0].name).toBe('myserver')
    expect(result.servers![0].config.command).toBe('node')
    expect(result.servers![1].name).toBe('httpserver')
    expect(result.servers![1].config.url).toBe('https://mcp.example.com/sse')
  })

  it('handles Cursor url-based server', () => {
    const input = JSON.stringify({
      mcpServers: {
        remote: { url: 'https://remote.mcp.dev/stream' },
      },
    })
    const result = parseMcpImportJson(input)
    expect(result.ok).toBe(true)
    expect(result.servers![0].config.url).toBe('https://remote.mcp.dev/stream')
    expect(result.servers![0].config.command).toBeUndefined()
  })

  it('returns error for invalid JSON', () => {
    const result = parseMcpImportJson('not json at all')
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('returns error for non-object input', () => {
    const result = parseMcpImportJson('"hello"')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('对象')
  })
})

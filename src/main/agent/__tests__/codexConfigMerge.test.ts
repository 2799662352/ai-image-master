import { describe, expect, it } from 'vitest'
import { mergeCodexConfigs } from '../codexConfigMerge'

describe('mergeCodexConfigs', () => {
  it('returns personal config when workspace is empty', () => {
    const merged = mergeCodexConfigs({
      personalToml: `[mcp_servers.github]\ncommand = "docker"\nargs = ["run", "--rm", "ghcr.io/github/github-mcp-server"]\n`,
      workspaceToml: '',
    })
    expect(merged).toContain('[mcp_servers.github]')
    expect(merged).toContain('command = "docker"')
  })

  it('workspace overrides personal by name', () => {
    const merged = mergeCodexConfigs({
      personalToml: `[mcp_servers.github]\ncommand = "old"\nargs = []\n`,
      workspaceToml: `[mcp_servers.github]\ncommand = "new"\nargs = ["x"]\n`,
    })
    expect(merged).toContain('command = "new"')
    expect(merged).not.toContain('command = "old"')
  })

  it('drops entries flagged enabled = false', () => {
    const merged = mergeCodexConfigs({
      personalToml: `[mcp_servers.foo]\ncommand = "x"\nargs = []\nenabled = false\n[mcp_servers.bar]\ncommand = "y"\nargs = []\n`,
      workspaceToml: '',
    })
    expect(merged).not.toContain('mcp_servers.foo')
    expect(merged).toContain('mcp_servers.bar')
  })

  it('treats missing files as empty', () => {
    expect(() => mergeCodexConfigs({ personalToml: '', workspaceToml: '' })).not.toThrow()
  })

  it('skips workspace document on parse error and surfaces warning', () => {
    const result = mergeCodexConfigs({
      personalToml: `[mcp_servers.github]\ncommand = "ok"\nargs = []\n`,
      workspaceToml: 'this is not valid toml = =',
      collectWarnings: true,
    })
    expect(result.merged).toContain('mcp_servers.github')
    expect(result.warnings.some((w) => /workspace/i.test(w))).toBe(true)
  })
})

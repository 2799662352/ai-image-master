import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { resolveWorkspacePaths } from '../codexConfigStore'

describe('resolveWorkspacePaths', () => {
  it('builds the four scope roots and runtime/audit paths', () => {
    const p = resolveWorkspacePaths({
      home: '/home/u',
      cwd: '/proj',
      userData: '/data',
    })
    expect(p.personalConfigToml).toBe(path.join('/home/u', '.codex', 'config.toml'))
    expect(p.personalSkillsRoot).toBe(path.join('/home/u', '.agents', 'skills'))
    expect(p.workspaceConfigToml).toBe(path.join('/proj', '.codex', 'workspace-mcp.toml'))
    expect(p.workspaceSkillsRoot).toBe(path.join('/proj', '.agents', 'skills'))
    expect(p.runtimeConfigToml).toBe(path.join('/data', 'codex-runtime', 'config.toml'))
    expect(p.auditLogPath).toBe(path.join('/data', 'codex-runtime', 'audit.log'))
  })
})

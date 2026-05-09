import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { saveMcp, deleteMcp, listMcp, readAuditLog, resolveWorkspacePaths } from '../codexConfigStore'

let tmp: string
beforeEach(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'audit-')) })
afterEach(async () => { await rm(tmp, { recursive: true, force: true }) })

describe('audit log', () => {
  it('appends entries on save and delete', async () => {
    const home = path.join(tmp, 'h'); const cwd = path.join(tmp, 'p')
    await mkdir(home, { recursive: true }); await mkdir(cwd, { recursive: true })
    const paths = resolveWorkspacePaths({ home, cwd, userData: tmp })
    await saveMcp(paths, {
      name: 'g', scope: 'personal', enabled: true,
      command: 'x', args: [], env: [],
    })
    await deleteMcp(paths, 'personal:g')
    const log = await readAuditLog(paths.auditLogPath)
    expect(log.map((e) => e.action)).toEqual(['mcp.save', 'mcp.delete'])
    expect(log[0]).toMatchObject({ scope: 'personal', name: 'g', ok: true })
  })

  it('audits save read failures before rethrowing', async () => {
    const home = path.join(tmp, 'h'); const cwd = path.join(tmp, 'p')
    await mkdir(home, { recursive: true }); await mkdir(cwd, { recursive: true })
    const paths = resolveWorkspacePaths({ home, cwd, userData: tmp })
    await mkdir(path.dirname(paths.personalConfigToml), { recursive: true })
    await mkdir(paths.personalConfigToml)

    await expect(saveMcp(paths, {
      name: 'broken-read', scope: 'personal', enabled: true,
      command: 'x', args: [], env: [],
    })).rejects.toThrow()

    const log = await readAuditLog(paths.auditLogPath)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      action: 'mcp.save',
      scope: 'personal',
      name: 'broken-read',
      provenance: 'manual',
      ok: false,
    })
    expect(log[0].error).toEqual(expect.any(String))
    expect(log[0].error).not.toHaveLength(0)
  })

  it('does not fail a successful save when audit append fails', async () => {
    const home = path.join(tmp, 'h'); const cwd = path.join(tmp, 'p')
    await mkdir(home, { recursive: true }); await mkdir(cwd, { recursive: true })
    const paths = resolveWorkspacePaths({ home, cwd, userData: tmp })
    await mkdir(path.dirname(paths.auditLogPath), { recursive: true })
    await mkdir(paths.auditLogPath)

    const result = await saveMcp(paths, {
      name: 'audit-directory', scope: 'personal', enabled: true,
      command: 'x', args: [], env: [],
    })

    expect(result).toEqual({ ok: true, id: 'personal:audit-directory', warnings: [] })
    await expect(listMcp(paths)).resolves.toEqual([
      expect.objectContaining({ id: 'personal:audit-directory', name: 'audit-directory' }),
    ])
  })

  it('does not throw invalid-name results when audit append fails', async () => {
    const home = path.join(tmp, 'h'); const cwd = path.join(tmp, 'p')
    await mkdir(home, { recursive: true }); await mkdir(cwd, { recursive: true })
    const paths = resolveWorkspacePaths({ home, cwd, userData: tmp })
    await mkdir(path.dirname(paths.auditLogPath), { recursive: true })
    await mkdir(paths.auditLogPath)

    const result = await saveMcp(paths, {
      name: '../bad', scope: 'personal', enabled: true,
      command: 'x', args: [], env: [],
    })

    expect(result).toMatchObject({ ok: false })
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { saveMcp, deleteMcp, readAuditLog, resolveWorkspacePaths } from '../codexConfigStore'

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
})

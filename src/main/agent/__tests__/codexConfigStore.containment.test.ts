import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { saveSkill, resolveWorkspacePaths } from '../codexConfigStore'

let tmp: string
beforeEach(async () => { tmp = await mkdtemp(path.join(os.tmpdir(), 'cont-')) })
afterEach(async () => { await rm(tmp, { recursive: true, force: true }) })

describe('path containment', () => {
  it('rejects names that resolve outside the configured roots via symlink', async () => {
    const home = path.join(tmp, 'h'); const cwd = path.join(tmp, 'p')
    const outside = path.join(tmp, 'outside')
    await mkdir(home, { recursive: true }); await mkdir(cwd, { recursive: true })
    await mkdir(outside, { recursive: true })
    await mkdir(path.join(home, '.agents'), { recursive: true })
    await symlink(outside, path.join(home, '.agents', 'skills')).catch(() => {})
    const paths = resolveWorkspacePaths({ home, cwd, userData: tmp })
    const r = await saveSkill(paths, {
      name: 'evil', scope: 'personal',
      description: '', whenToUse: '', instructions: '',
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/contain|outside|root/i)
  })
})

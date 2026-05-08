import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  deleteMcp,
  listMcp,
  saveMcp,
  setMcpEnabled,
  resolveWorkspacePaths,
} from '../codexConfigStore'

let tmp: string
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'cfg-del-'))
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function setup() {
  const home = path.join(tmp, 'h')
  const cwd = path.join(tmp, 'p')
  await mkdir(home, { recursive: true })
  await mkdir(cwd, { recursive: true })
  return resolveWorkspacePaths({ home, cwd, userData: tmp })
}

describe('deleteMcp / setMcpEnabled', () => {
  it('removes the entry from the correct scope only', async () => {
    const paths = await setup()
    await saveMcp(paths, base({ name: 'a' }))
    await saveMcp(paths, base({ name: 'b' }))
    await deleteMcp(paths, 'personal:a')
    const list = await listMcp(paths)
    expect(list.map((s) => s.name).sort()).toEqual(['b'])
  })

  it('toggles enabled flag without dropping the entry', async () => {
    const paths = await setup()
    await saveMcp(paths, base({ name: 'a' }))
    await setMcpEnabled(paths, 'personal:a', false)
    const list = await listMcp(paths)
    const a = list.find((s) => s.name === 'a')!
    expect(a.enabled).toBe(false)
  })
})

function base(over: { name: string }) {
  return {
    name: over.name,
    scope: 'personal' as const,
    enabled: true,
    command: 'echo',
    args: [],
    env: [],
  }
}

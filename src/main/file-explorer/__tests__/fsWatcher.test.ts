import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { startWatching, stopWatching, disposeAll, _resetForTests } from '../fsWatcher'

let dir: string
beforeEach(async () => {
  _resetForTests()
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fswatch-'))
})
afterEach(async () => {
  disposeAll()
  await fs.rm(dir, { recursive: true, force: true })
})

describe('fsWatcher', () => {
  it('emits change event when watched file is modified', async () => {
    const f = path.join(dir, 'a.txt')
    await fs.writeFile(f, 'one')
    const events: { type: string; path: string }[] = []
    startWatching(f, (e) => events.push(e))
    await new Promise((r) => setTimeout(r, 350))
    await fs.writeFile(f, 'two')
    await vi.waitFor(() => expect(events.find((e) => e.type === 'change')).toBeDefined(), {
      timeout: 2000,
      interval: 50,
    })
  }, 5000)

  it('stopWatching removes path from watched set', async () => {
    const f = path.join(dir, 'b.txt')
    await fs.writeFile(f, 'x')
    const events: { type: string }[] = []
    startWatching(f, (e) => events.push(e))
    await new Promise((r) => setTimeout(r, 350))
    stopWatching(f)
    await new Promise((r) => setTimeout(r, 100))
    await fs.writeFile(f, 'y')
    await new Promise((r) => setTimeout(r, 500))
    expect(events.find((e) => e.type === 'change')).toBeUndefined()
  }, 5000)
})

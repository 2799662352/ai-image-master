import { describe, expect, it } from 'vitest'
import { ImageTaskManager } from '../imageTaskRegistry'

describe('ImageTaskManager', () => {
  it('creates a running task with a unique id', () => {
    const reg = new ImageTaskManager()
    const a = reg.create('cat')
    const b = reg.create('dog')
    expect(a).not.toBe(b)
    expect(reg.get(a)).toMatchObject({ taskId: a, status: 'running', prompt: 'cat' })
  })

  it('applyUpdate(succeeded) flips status and stores the result', () => {
    const reg = new ImageTaskManager()
    const id = reg.create('cat')
    expect(reg.get(id)!.status).toBe('running')
    reg.applyUpdate({ taskId: id, kind: 'single', status: 'succeeded', result: { ok: true, paths: ['x.png'] } })
    expect(reg.get(id)!.status).toBe('succeeded')
    expect(reg.get(id)!.result).toEqual({ ok: true, paths: ['x.png'] })
  })

  it('applyUpdate(failed) flips status and stores the error message', () => {
    const reg = new ImageTaskManager()
    const id = reg.create('cat')
    reg.applyUpdate({ taskId: id, kind: 'single', status: 'failed', error: 'boom' })
    expect(reg.get(id)!.status).toBe('failed')
    expect(reg.get(id)!.error).toBe('boom')
  })

  it('fail() settles an un-acked task as failed', () => {
    const reg = new ImageTaskManager()
    const id = reg.create('cat')
    reg.fail(id, 'renderer gone')
    expect(reg.get(id)!.status).toBe('failed')
    expect(reg.get(id)!.error).toBe('renderer gone')
  })

  it('applyUpdate is idempotent — a second terminal update does not overwrite the first', () => {
    const reg = new ImageTaskManager()
    const id = reg.create('cat')
    reg.applyUpdate({ taskId: id, kind: 'single', status: 'succeeded', result: { ok: true } })
    reg.applyUpdate({ taskId: id, kind: 'single', status: 'failed', error: 'late' })
    expect(reg.get(id)!.status).toBe('succeeded')
  })

  it('applyUpdate safely ignores unknown task ids', () => {
    const reg = new ImageTaskManager()
    expect(() => reg.applyUpdate({ taskId: 'nope', kind: 'single', status: 'succeeded' })).not.toThrow()
    expect(reg.get('nope')).toBeUndefined()
  })

  it('waitForTerminal returns undefined for an unknown id', async () => {
    const reg = new ImageTaskManager()
    await expect(reg.waitForTerminal('nope', 10)).resolves.toBeUndefined()
  })

  it('waitForTerminal returns the snapshot immediately when already terminal', async () => {
    const reg = new ImageTaskManager()
    const id = reg.create('cat')
    reg.applyUpdate({ taskId: id, kind: 'single', status: 'succeeded', result: { ok: true } })
    const snap = await reg.waitForTerminal(id, 50_000)
    expect(snap!.status).toBe('succeeded')
  })

  it('waitForTerminal wakes as soon as the task settles (does not burn the full timeout)', async () => {
    const reg = new ImageTaskManager()
    const id = reg.create('cat')
    const started = Date.now()
    const waitP = reg.waitForTerminal(id, 5_000)
    setTimeout(() => reg.applyUpdate({ taskId: id, kind: 'single', status: 'succeeded', result: { ok: true } }), 5)
    const snap = await waitP
    expect(snap!.status).toBe('succeeded')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('waitForTerminal returns the running snapshot when the timeout fires first', async () => {
    const reg = new ImageTaskManager()
    const id = reg.create('cat') // never settles
    const snap = await reg.waitForTerminal(id, 10)
    expect(snap!.status).toBe('running')
  })
})

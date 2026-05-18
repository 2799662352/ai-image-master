import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildAttachmentTreeFromInputs, wireAttachmentBroadcast } from '../AttachmentTreeProvider'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'attree-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('buildAttachmentTreeFromInputs', () => {
  it('joins disk files with DB rows by basename of localPath', async () => {
    await fs.writeFile(path.join(dir, 'aaa.png'), Buffer.alloc(10))
    await fs.writeFile(path.join(dir, 'bbb.png'), Buffer.alloc(20))
    const rows = [
      { id: '1', originalName: 'cat.png', localPath: path.join(dir, 'aaa.png'), size: 10, mime: 'image/png', uploadedAt: new Date(2026, 4, 1) },
      { id: '2', originalName: 'dog.png', localPath: path.join(dir, 'bbb.png'), size: 20, mime: 'image/png', uploadedAt: new Date(2026, 4, 2) },
    ]
    const r = await buildAttachmentTreeFromInputs(dir, rows)
    expect(r.map((n) => n.name)).toEqual(['dog.png', 'cat.png'])
    expect(r[0].source).toBe('attachments')
    expect(r[0].mime).toBe('image/png')
  })

  it('orphan disk file (no DB row) keeps disk filename as name', async () => {
    await fs.writeFile(path.join(dir, 'orphan.png'), Buffer.alloc(5))
    const r = await buildAttachmentTreeFromInputs(dir, [])
    expect(r.length).toBe(1)
    expect(r[0].name).toBe('orphan.png')
  })

  it('orphan DB row (no disk file) is silently filtered', async () => {
    const rows = [
      { id: '99', originalName: 'gone.png', localPath: path.join(dir, 'gone.png'), size: 0, mime: 'image/png', uploadedAt: new Date() },
    ]
    const r = await buildAttachmentTreeFromInputs(dir, rows)
    expect(r.length).toBe(0)
  })

  it('returns empty array when uploads dir does not exist', async () => {
    const r = await buildAttachmentTreeFromInputs(path.join(dir, 'missing'), [])
    expect(r).toEqual([])
  })
})

describe('wireAttachmentBroadcast', () => {
  it('forwards attachment-added events to every open BrowserWindow as attachments:changed', () => {
    const sendA = vi.fn()
    const sendB = vi.fn()
    const win1 = {
      isDestroyed: () => false,
      webContents: { send: sendA },
    }
    const win2 = {
      isDestroyed: () => false,
      webContents: { send: sendB },
    }
    const service = new EventEmitter()

    const cleanup = wireAttachmentBroadcast(service, () => [win1 as never, win2 as never])

    service.emit('attachment-added', { saved: { originalName: 'foo.txt' } })

    expect(sendA).toHaveBeenCalledWith('attachments:changed')
    expect(sendB).toHaveBeenCalledWith('attachments:changed')

    cleanup()
    sendA.mockClear()
    sendB.mockClear()
    service.emit('attachment-added', { saved: { originalName: 'after-cleanup.txt' } })
    expect(sendA).not.toHaveBeenCalled()
    expect(sendB).not.toHaveBeenCalled()
  })

  it('skips destroyed windows so we never crash on already-closed renderers', () => {
    const liveSend = vi.fn()
    const deadSend = vi.fn()
    const live = { isDestroyed: () => false, webContents: { send: liveSend } }
    const dead = { isDestroyed: () => true, webContents: { send: deadSend } }
    const service = new EventEmitter()

    wireAttachmentBroadcast(service, () => [live as never, dead as never])
    service.emit('attachment-added', { saved: { originalName: 'x.txt' } })

    expect(liveSend).toHaveBeenCalledWith('attachments:changed')
    expect(deadSend).not.toHaveBeenCalled()
  })
})

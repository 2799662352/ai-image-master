import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  slugifyCheckpointName,
  makeCheckpointId,
  isSafeCheckpointId,
  saveCheckpointFile,
  readCheckpointFile,
  listCheckpointFiles,
} from '../canvasCheckpointIpc'

// Restorable canvas checkpoints (gap-analysis §8/§9): main-side file IO for the
// renderer's tldraw getSnapshot/loadSnapshot JSON. attachments:save only takes
// image/video, so a dedicated JSON file channel is required. These pure fns are
// the security-relevant core (path traversal, id sanitisation, roundtrip).

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-ckpt-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('slugifyCheckpointName', () => {
  it('lowercases and keeps only alnum + dash', () => {
    expect(slugifyCheckpointName('My Cool Canvas!!')).toBe('my-cool-canvas')
    expect(slugifyCheckpointName('  spaced  out  ')).toBe('spaced-out')
  })
  it('falls back to "canvas" for empty / symbol-only names', () => {
    expect(slugifyCheckpointName('')).toBe('canvas')
    expect(slugifyCheckpointName('***')).toBe('canvas')
    expect(slugifyCheckpointName(undefined as unknown as string)).toBe('canvas')
  })
})

describe('makeCheckpointId', () => {
  it('combines slug + timestamp and is always a safe id', () => {
    const id = makeCheckpointId('Night Scene', 1700000000000)
    expect(id).toBe('night-scene-1700000000000')
    expect(isSafeCheckpointId(id)).toBe(true)
  })
})

describe('isSafeCheckpointId', () => {
  it('rejects traversal / separators / unsafe chars', () => {
    expect(isSafeCheckpointId('../etc/passwd')).toBe(false)
    expect(isSafeCheckpointId('a/b')).toBe(false)
    expect(isSafeCheckpointId('a\\b')).toBe(false)
    expect(isSafeCheckpointId('UPPER')).toBe(false)
    expect(isSafeCheckpointId('')).toBe(false)
    expect(isSafeCheckpointId('ok-123')).toBe(true)
  })
})

describe('save / read / list roundtrip', () => {
  it('saves the snapshot JSON verbatim + a meta sidecar, then reads it back', async () => {
    const snapshotJson = JSON.stringify({ document: { 'shape:a': 1 }, session: { x: 1 } })
    const saved = await saveCheckpointFile(dir, {
      id: 'night-scene-1700000000000',
      name: 'Night Scene',
      createdAt: '2026-06-22T00:00:00.000Z',
      shapeCount: 3,
      snapshotJson,
    })
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.checkpointId).toBe('night-scene-1700000000000')
    expect(saved.path.endsWith('night-scene-1700000000000.json')).toBe(true)

    const read = await readCheckpointFile(dir, 'night-scene-1700000000000')
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.json).toBe(snapshotJson)
    expect(JSON.parse(read.json).document['shape:a']).toBe(1)
  })

  it('lists saved checkpoints (meta only) newest first, ignoring snapshot bodies', async () => {
    await saveCheckpointFile(dir, { id: 'a-1', name: 'A', createdAt: '2026-06-22T00:00:01.000Z', shapeCount: 1, snapshotJson: '{}' })
    await saveCheckpointFile(dir, { id: 'b-2', name: 'B', createdAt: '2026-06-22T00:00:02.000Z', shapeCount: 5, snapshotJson: '{}' })
    const list = await listCheckpointFiles(dir)
    expect(list.map((c) => c.checkpointId)).toEqual(['b-2', 'a-1'])
    expect(list[0]).toMatchObject({ name: 'B', shapeCount: 5 })
    expect(list[0].path.endsWith('b-2.json')).toBe(true)
  })

  it('returns [] for a missing directory', async () => {
    const list = await listCheckpointFiles(path.join(dir, 'does-not-exist'))
    expect(list).toEqual([])
  })
})

describe('safety + error paths', () => {
  it('refuses to save under an unsafe id', async () => {
    const res = await saveCheckpointFile(dir, { id: '../escape', name: 'x', createdAt: '', shapeCount: 0, snapshotJson: '{}' })
    expect(res.ok).toBe(false)
  })
  it('refuses to read an unsafe id', async () => {
    const res = await readCheckpointFile(dir, '../../secret')
    expect(res.ok).toBe(false)
  })
  it('returns a structured miss for an unknown id', async () => {
    const res = await readCheckpointFile(dir, 'never-saved-1')
    expect(res.ok).toBe(false)
  })
})

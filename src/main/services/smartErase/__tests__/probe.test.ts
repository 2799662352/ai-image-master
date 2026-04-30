// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import * as path from 'node:path'

const spawnMock = vi.fn()
const statSyncMock = vi.fn()

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('child_process', () => ({ spawn: spawnMock }))

vi.mock('node:fs', () => ({
  statSync: statSyncMock,
  default: { statSync: statSyncMock },
}))
vi.mock('fs', () => ({
  statSync: statSyncMock,
  default: { statSync: statSyncMock },
}))

// ffprobe-static exports `{ path }` (NOT a bare string, differs from ffmpeg-static).
// Mocking the actual published shape per plan rule §0.2.
vi.mock('ffprobe-static', () => ({
  __esModule: true,
  default: { path: '/fake/ffprobe' },
  path: '/fake/ffprobe',
}))

interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
}
function makeFakeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild
  c.stdout = new EventEmitter()
  c.stderr = new EventEmitter()
  c.kill = vi.fn()
  return c
}

function emitProbeJson(child: FakeChild, durationSeconds: string) {
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(JSON.stringify({ format: { duration: durationSeconds } })))
    child.emit('close', 0)
  })
}

describe('smartErase/probe.probeBatch', () => {
  beforeEach(() => {
    vi.resetModules()
    spawnMock.mockReset()
    statSyncMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns [] for empty input without spawning', async () => {
    const { probeBatch } = await import('../probe')
    const result = await probeBatch([])
    expect(result).toEqual([])
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('flags empty path string as FILE_PATH_UNAVAILABLE without spawning', async () => {
    const { probeBatch } = await import('../probe')
    const [r] = await probeBatch([''])
    expect(r.warning).toBe('FILE_PATH_UNAVAILABLE')
    expect(r.filePath).toBe('')
    expect(r.filename).toBe('')
    expect(r.fileSize).toBe(0)
    expect(r.durationSeconds).toBe(0)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('flags FILE_NOT_LOCAL when statSync throws (e.g. ENOENT, permission, unreachable share)', async () => {
    statSyncMock.mockImplementationOnce(() => { throw new Error('ENOENT') })
    const { probeBatch } = await import('../probe')
    const [r] = await probeBatch(['/missing/video.mp4'])
    expect(r.warning).toBe('FILE_NOT_LOCAL')
    expect(r.filename).toBe('video.mp4')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('extracts durationSeconds from ffprobe JSON on exit 0', async () => {
    statSyncMock.mockReturnValueOnce({ size: 12_345_678 })
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)

    const { probeBatch } = await import('../probe')
    const promise = probeBatch(['/videos/clip.mp4'])
    emitProbeJson(child, '12.34')
    const [r] = await promise

    expect(r.warning).toBeUndefined()
    expect(r.durationSeconds).toBeCloseTo(12.34, 2)
    expect(r.fileSize).toBe(12_345_678)
    expect(r.filename).toBe('clip.mp4')
    expect(r.filePath).toBe('/videos/clip.mp4')

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [, args] = spawnMock.mock.calls[0]
    expect(args).toEqual(['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', '/videos/clip.mp4'])
  })

  it('flags PROBE_FAILED when ffprobe exits non-zero', async () => {
    statSyncMock.mockReturnValueOnce({ size: 1024 })
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)

    const { probeBatch } = await import('../probe')
    const promise = probeBatch(['/videos/broken.mp4'])
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('moov atom not found'))
      child.emit('close', 1)
    })
    const [r] = await promise

    expect(r.warning).toBe('PROBE_FAILED')
    expect(r.fileSize).toBe(1024)
  })

  it('caps concurrent ffprobe processes at 4 across a batch of 10', async () => {
    statSyncMock.mockReturnValue({ size: 1024 })

    let active = 0
    let peak = 0
    const pending: FakeChild[] = []

    spawnMock.mockImplementation(() => {
      const child = makeFakeChild()
      active++
      peak = Math.max(peak, active)
      pending.push(child)
      // Drain one pending child every microtask so others can start, simulating staggered work.
      queueMicrotask(() => {
        const c = pending.shift()
        if (!c) return
        active--
        c.stdout.emit('data', Buffer.from('{"format":{"duration":"1.0"}}'))
        c.emit('close', 0)
      })
      return child
    })

    const { probeBatch } = await import('../probe')
    const paths = Array.from({ length: 10 }, (_, i) => path.posix.join('/v', `${i}.mp4`))
    const results = await probeBatch(paths)

    expect(results).toHaveLength(10)
    expect(results.every((r) => r.warning === undefined)).toBe(true)
    expect(spawnMock).toHaveBeenCalledTimes(10)
    // Tighter than the plan's "≤ 4" — a future bump to PROBE_CONCURRENCY MUST
    // fail this assertion. The 4 workers spin up synchronously before any
    // microtask drains, so peak === 4 is deterministic given 10 paths.
    expect(peak).toBe(4)
  })

  it('flags PROBE_FAILED and SIGKILLs the process when ffprobe hangs past 30s', async () => {
    vi.useFakeTimers()
    statSyncMock.mockReturnValueOnce({ size: 1024 })
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)

    const { probeBatch } = await import('../probe')
    const promise = probeBatch(['/videos/onedrive-cloud-only.mp4'])

    promise.catch(() => {})

    // Advance a bit shy of timeout — must NOT have killed yet.
    await vi.advanceTimersByTimeAsync(29_000)
    expect(child.kill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_000)

    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    const [r] = await promise
    expect(r.warning).toBe('PROBE_FAILED')
    expect(r.fileSize).toBe(1024)
  })
})

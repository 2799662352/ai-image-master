// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

const spawnMock = vi.fn()
vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('child_process', () => ({ spawn: spawnMock }))

// Mock must mirror real shape: ffmpeg-static is a default export string.
// Module hoisting means this runs before any test imports posterGen.
vi.mock('ffmpeg-static', () => ({
  __esModule: true,
  default: '/fake/path/to/ffmpeg',
}))

interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  return child
}

describe('smartErase/posterGen.generatePosterDataUrl', () => {
  beforeEach(() => {
    vi.resetModules()
    spawnMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('spawns ffmpeg with -ss 0.5, single-frame, scaled mjpeg piped to stdout', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)

    const { generatePosterDataUrl } = await import('../posterGen')
    const promise = generatePosterDataUrl('/videos/in.mp4')

    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
      child.emit('close', 0)
    })

    await promise

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [bin, args] = spawnMock.mock.calls[0]
    expect(bin).toContain('ffmpeg')
    expect(args).toEqual([
      '-ss', '0.5',
      '-i', '/videos/in.mp4',
      '-frames:v', '1',
      '-vf', 'scale=320:-1',
      '-f', 'mjpeg',
      'pipe:1',
    ])
  })

  it('returns a data:image/jpeg;base64,... URL when ffmpeg exits 0 with stdout', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)

    const { generatePosterDataUrl } = await import('../posterGen')
    const promise = generatePosterDataUrl('/videos/in.mp4')

    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    queueMicrotask(() => {
      child.stdout.emit('data', jpegBytes.subarray(0, 3))
      child.stdout.emit('data', jpegBytes.subarray(3))
      child.emit('close', 0)
    })

    const result = await promise
    expect(result).toBe('data:image/jpeg;base64,' + jpegBytes.toString('base64'))
  })

  it('throws POSTER_FAILED when ffmpeg exits non-zero', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)

    const { generatePosterDataUrl } = await import('../posterGen')
    const promise = generatePosterDataUrl('/videos/broken.mp4')

    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('Invalid data found when processing input'))
      child.emit('close', 1)
    })

    await expect(promise).rejects.toMatchObject({ message: expect.stringContaining('POSTER_FAILED') })
  })

  it('throws POSTER_TIMEOUT and kills the process after 5s', async () => {
    vi.useFakeTimers()
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)

    const { generatePosterDataUrl } = await import('../posterGen')
    const promise = generatePosterDataUrl('/videos/hang.mp4')

    promise.catch(() => {})

    await vi.advanceTimersByTimeAsync(5_000)

    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    await expect(promise).rejects.toMatchObject({ message: expect.stringContaining('POSTER_TIMEOUT') })
  })

  it('throws POSTER_FAILED when stdout is empty even with exit 0 (defensive)', async () => {
    const child = makeFakeChild()
    spawnMock.mockReturnValueOnce(child)

    const { generatePosterDataUrl } = await import('../posterGen')
    const promise = generatePosterDataUrl('/videos/empty.mp4')

    queueMicrotask(() => {
      child.emit('close', 0)
    })

    await expect(promise).rejects.toMatchObject({ message: expect.stringContaining('POSTER_FAILED') })
  })
})

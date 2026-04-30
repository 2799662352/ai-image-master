// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSliceUploadFile = vi.fn()
const mockPutObject = vi.fn()
const mockCancelTask = vi.fn()
const mockGetObjectUrl = vi.fn()
const mockDeleteMultipleObject = vi.fn()

const instanceCreations: Array<any> = []

vi.mock('cos-nodejs-sdk-v5', () => ({
  default: function MockCOS(_opts: any) {
    instanceCreations.push(_opts)
    return {
      sliceUploadFile: mockSliceUploadFile,
      putObject: mockPutObject,
      cancelTask: mockCancelTask,
      getObjectUrl: mockGetObjectUrl,
      deleteMultipleObject: mockDeleteMultipleObject,
    }
  },
}))

vi.mock('../credentials', () => ({
  getCredentials: () => ({ secretId: 'id', secretKey: 'k', bucket: 'b', region: 'ap-shanghai' }),
  onCredentialsInvalidated: vi.fn(),
}))

describe('tencent/cosClient', () => {
  beforeEach(() => {
    vi.resetModules()
    mockSliceUploadFile.mockReset()
    mockPutObject.mockReset()
    mockCancelTask.mockReset()
    mockGetObjectUrl.mockReset()
    mockDeleteMultipleObject.mockReset()
    instanceCreations.length = 0
  })

  it('lazy-creates the COS instance once across multiple uploadBuffer calls', async () => {
    const { uploadBuffer } = await import('../cosClient')
    mockPutObject.mockImplementation((_p: any, cb: any) => cb(null, {}))

    await uploadBuffer({ key: 'a/b.jpg', body: Buffer.from('x') })
    await uploadBuffer({ key: 'a/c.jpg', body: Buffer.from('y') })

    expect(instanceCreations.length).toBe(1)
  })

  it('credentials invalidation drops the cached instance', async () => {
    const invalidatedCallbacks: Array<() => void> = []
    vi.doMock('../credentials', () => ({
      getCredentials: () => ({ secretId: 'id', secretKey: 'k', bucket: 'b', region: 'ap-shanghai' }),
      onCredentialsInvalidated: (cb: () => void) => invalidatedCallbacks.push(cb),
    }))

    const { uploadBuffer } = await import('../cosClient')
    mockPutObject.mockImplementation((_p: any, cb: any) => cb(null, {}))

    await uploadBuffer({ key: 'a.jpg', body: Buffer.from('x') })
    invalidatedCallbacks.forEach((cb) => cb())
    await uploadBuffer({ key: 'b.jpg', body: Buffer.from('x') })

    expect(instanceCreations.length).toBe(2)
  })

  it('uploadStream surfaces TaskId via onTaskReady and progress via onProgress', async () => {
    mockSliceUploadFile.mockImplementation((params: any, cb: any) => {
      params.onTaskReady?.('task-123')
      params.onProgress?.({ loaded: 50, total: 100, percent: 0.5, speed: 1024 })
      cb(null, {})
    })

    const { uploadStream } = await import('../cosClient')
    const onProgress = vi.fn()
    const onTaskReady = vi.fn()

    await uploadStream({
      key: 'video.mp4',
      filePath: '/tmp/video.mp4',
      onProgress,
      onTaskReady,
    })

    expect(onTaskReady).toHaveBeenCalledWith('task-123')
    expect(onProgress).toHaveBeenCalledWith({ loaded: 50, total: 100, percent: 0.5, speed: 1024 })
    expect(mockSliceUploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ Bucket: 'b', Region: 'ap-shanghai', Key: 'video.mp4', FilePath: '/tmp/video.mp4' }),
      expect.any(Function),
    )
  })

  it('cancelUpload calls cos.cancelTask synchronously with the TaskId string', async () => {
    const { cancelUpload, uploadBuffer } = await import('../cosClient')
    mockPutObject.mockImplementation((_p: any, cb: any) => cb(null, {}))
    await uploadBuffer({ key: 'a.jpg', body: Buffer.from('x') })

    const ret = cancelUpload('task-123')

    expect(ret).toBeUndefined()
    expect(mockCancelTask).toHaveBeenCalledWith('task-123')
  })

  it('cancelUpload before any upload no-ops without lazy-initializing the COS instance', async () => {
    const { cancelUpload } = await import('../cosClient')

    cancelUpload('task-never-existed')

    expect(instanceCreations.length).toBe(0)
    expect(mockCancelTask).not.toHaveBeenCalled()
  })

  it('getPresignedUrl supports custom Query for ci-process', async () => {
    mockGetObjectUrl.mockImplementation((_p: any, cb: any) => cb(null, { Url: 'https://example/x?ci-process=snapshot&time=0.5' }))
    const { getPresignedUrl } = await import('../cosClient')

    const url = await getPresignedUrl({
      key: 'video.mp4',
      expireSeconds: 3600,
      query: { 'ci-process': 'snapshot', time: 0.5, format: 'jpg', width: 320 },
    })

    expect(url).toContain('ci-process=snapshot')
    expect(mockGetObjectUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        Sign: true,
        Method: 'GET',
        Query: { 'ci-process': 'snapshot', time: 0.5, format: 'jpg', width: 320 },
      }),
      expect.any(Function),
    )
  })

  it('deleteObjects no-ops on empty array', async () => {
    const { deleteObjects } = await import('../cosClient')
    await deleteObjects([])
    expect(mockDeleteMultipleObject).not.toHaveBeenCalled()
  })

  it('deleteObjects sends keys without leading slash', async () => {
    mockDeleteMultipleObject.mockImplementation((_p: any, cb: any) => cb(null, {}))
    const { deleteObjects } = await import('../cosClient')

    await deleteObjects(['/path/a.jpg', 'path/b.jpg'])

    expect(mockDeleteMultipleObject).toHaveBeenCalledWith(
      expect.objectContaining({
        Objects: [{ Key: 'path/a.jpg' }, { Key: 'path/b.jpg' }],
      }),
      expect.any(Function),
    )
  })

  it('deleteObjects rejects on partial-failure response from COS', async () => {
    mockDeleteMultipleObject.mockImplementation((_p: any, cb: any) =>
      cb(null, { Error: [{ Key: 'a.jpg', Code: 'AccessDenied' }] }),
    )
    const { deleteObjects } = await import('../cosClient')

    await expect(deleteObjects(['a.jpg', 'b.jpg'])).rejects.toThrow(/partial delete failed.*a\.jpg/)
  })
})

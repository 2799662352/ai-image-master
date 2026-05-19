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

  // ---------------------------------------------------------------------------
  // uploadBufferToBucket — like uploadBuffer but ignores the global bucket
  // from credentials so callers (e.g. image-history IPC) can target a
  // *different* bucket than storyboardSplit/smartErase use. Credentials are
  // still resolved from `getCredentials()` because the SDK key pair has
  // access to both buckets in the same Tencent Cloud account.
  // ---------------------------------------------------------------------------
  it('uploadBufferToBucket sends the explicit Bucket/Region, not the credentials bucket', async () => {
    mockPutObject.mockImplementation((_p: any, cb: any) => cb(null, {}))
    const { uploadBufferToBucket } = await import('../cosClient')

    const url = await uploadBufferToBucket({
      bucket: 'image-master-1345773498',
      region: 'ap-guangzhou',
      key: 'image-history/2026/05/abc.png',
      body: Buffer.from('img'),
      contentType: 'image/png',
    })

    expect(mockPutObject).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'image-master-1345773498',
        Region: 'ap-guangzhou',
        Key: 'image-history/2026/05/abc.png',
        ContentType: 'image/png',
      }),
      expect.any(Function),
    )
    // Confirm we do NOT silently fall back to the default credentials bucket
    // (the test mocks credentials as `bucket: 'b', region: 'ap-shanghai'`).
    const args = mockPutObject.mock.calls[0][0]
    expect(args.Bucket).not.toBe('b')
    expect(args.Region).not.toBe('ap-shanghai')

    // Returns the canonical public URL so the renderer (or any consumer)
    // can render the uploaded image without a second IPC roundtrip.
    expect(url).toBe(
      'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/2026/05/abc.png',
    )
  })

  it('uploadBufferToBucket strips a leading slash from key in the resulting URL', async () => {
    mockPutObject.mockImplementation((_p: any, cb: any) => cb(null, {}))
    const { uploadBufferToBucket } = await import('../cosClient')
    const url = await uploadBufferToBucket({
      bucket: 'image-master-1345773498',
      region: 'ap-guangzhou',
      key: '/leading/slash.png',
      body: Buffer.from('x'),
    })
    expect(url).toBe(
      'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/leading/slash.png',
    )
    const args = mockPutObject.mock.calls[0][0]
    expect(args.Key).toBe('leading/slash.png')
  })

  it('uploadBufferToBucket rejects on COS error', async () => {
    mockPutObject.mockImplementation((_p: any, cb: any) =>
      cb({ code: 'AccessDenied', statusCode: 403, message: 'no' }),
    )
    const { uploadBufferToBucket } = await import('../cosClient')
    await expect(
      uploadBufferToBucket({
        bucket: 'image-master-1345773498',
        region: 'ap-guangzhou',
        key: 'k.png',
        body: Buffer.from('x'),
      }),
    ).rejects.toMatchObject({ code: 'AccessDenied' })
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

  // ───────────────────── round-5 加固 ─────────────────────
  // uploadStream 在 sliceUploadFile 失败时, 必须显式 cancelTask 一次 ——
  // 哪怕 SDK 已经"应该"清理过, 也再保险一遍, 让 SDK 走 evictTask 释放
  // 内部 TaskInfo Map 里挂着的文件 fd。
  it('uploadStream calls cancelTask on error path to defensively release fd', async () => {
    mockSliceUploadFile.mockImplementation((params: any, cb: any) => {
      // SDK 先 onTaskReady 把 taskId 抛上来, 后续才报错
      params.onTaskReady?.('task-leak-456')
      cb({ code: 'NetworkingError', message: 'TCP reset' })
    })

    const { uploadStream } = await import('../cosClient')
    await expect(
      uploadStream({ key: 'big.bin', filePath: '/tmp/big.bin' }),
    ).rejects.toMatchObject({ code: 'NetworkingError' })

    // 关键断言: 错误分支必须 cancelTask, 否则 SDK 内部状态可能留着 fd
    expect(mockCancelTask).toHaveBeenCalledWith('task-leak-456')
  })

  // 成功路径不应该 cancelTask —— 否则会把 SDK 的"已成功上传"任务也清掉,
  // 影响 SDK 内部的 task complete 后处理 / 用户拿不到 etag 等元信息。
  it('uploadStream does NOT call cancelTask on success path', async () => {
    mockSliceUploadFile.mockImplementation((params: any, cb: any) => {
      params.onTaskReady?.('task-ok-789')
      cb(null, {})
    })

    const { uploadStream } = await import('../cosClient')
    await uploadStream({ key: 'k.bin', filePath: '/tmp/ok.bin' })

    expect(mockCancelTask).not.toHaveBeenCalled()
  })

  // 即便上游业务方传的 onTaskReady 自己抛了, uploadStream 仍要继续吃 taskId,
  // 不能因为业务回调把整条上传也带翻 —— 早期版本里没用 try 包裹直接 throw 会
  // 让 sliceUploadFile 的回调链断在中途。
  it('uploadStream swallows errors thrown by user-supplied onTaskReady', async () => {
    mockSliceUploadFile.mockImplementation((params: any, cb: any) => {
      params.onTaskReady?.('task-cb-err')
      cb(null, {})
    })

    const { uploadStream } = await import('../cosClient')
    await uploadStream({
      key: 'k.bin',
      filePath: '/tmp/ok.bin',
      onTaskReady: () => { throw new Error('user cb boom') },
    })
    // 业务 cb 抛错不应影响完成: 没 reject 就算过。
  })
})

// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fsp } from 'node:fs'

const uploadStreamToBucketMock = vi.fn()
vi.mock('../cosClient', () => ({
  uploadStreamToBucket: (...args: any[]) => uploadStreamToBucketMock(...args),
}))

const realFetch = globalThis.fetch

describe('tencent/historyBucketTransfer', () => {
  beforeEach(() => {
    vi.resetModules()
    uploadStreamToBucketMock.mockReset()
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('下载源 URL → 临时文件 → 上传历史桶,返回永久 URL,并清理临时文件', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('fake-video-bytes')) as any

    let seenTmpPath = ''
    let bytesAtUploadTime = ''
    uploadStreamToBucketMock.mockImplementation(async (opts: any) => {
      seenTmpPath = opts.filePath
      bytesAtUploadTime = await fsp.readFile(opts.filePath, 'utf-8')
      return `https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/${opts.key}`
    })

    const { transferUrlToHistoryBucket } = await import('../historyBucketTransfer')
    const url = await transferUrlToHistoryBucket({
      sourceUrl: 'https://media.example/presigned.mp4?sig=x',
      key: 'image-history/smart-erase/task-1.mp4',
      contentType: 'video/mp4',
    })

    expect(url).toBe(
      'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/smart-erase/task-1.mp4',
    )
    expect(bytesAtUploadTime).toBe('fake-video-bytes')
    expect(uploadStreamToBucketMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: 'image-master-1345773498',
        region: 'ap-guangzhou',
        key: 'image-history/smart-erase/task-1.mp4',
        contentType: 'video/mp4',
      }),
    )
    // 临时文件已被清理(unlink 是 fire-and-forget,轮一拍)
    await new Promise((r) => setTimeout(r, 20))
    await expect(fsp.access(seenTmpPath)).rejects.toThrow()
  })

  it('Key 不在 image-history/ 前缀下 → 直接抛错(STS 票据只授权该前缀)', async () => {
    const { transferUrlToHistoryBucket } = await import('../historyBucketTransfer')
    await expect(
      transferUrlToHistoryBucket({ sourceUrl: 'https://x', key: 'smart-erase/task.mp4' }),
    ).rejects.toThrow(/image-history/)
    expect(uploadStreamToBucketMock).not.toHaveBeenCalled()
  })

  it('下载 HTTP 非 2xx → 抛错且不上传', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('denied', { status: 403 })) as any

    const { transferUrlToHistoryBucket } = await import('../historyBucketTransfer')
    await expect(
      transferUrlToHistoryBucket({
        sourceUrl: 'https://media.example/expired.mp4',
        key: 'image-history/smart-erase/task-2.mp4',
      }),
    ).rejects.toThrow(/HTTP 403/)
    expect(uploadStreamToBucketMock).not.toHaveBeenCalled()
  })

  it('下载出空文件 → 抛错且不上传(防止把 0 字节结果写进历史桶)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('')) as any

    const { transferUrlToHistoryBucket } = await import('../historyBucketTransfer')
    await expect(
      transferUrlToHistoryBucket({
        sourceUrl: 'https://media.example/empty.mp4',
        key: 'image-history/smart-erase/task-3.mp4',
      }),
    ).rejects.toThrow(/empty/)
    expect(uploadStreamToBucketMock).not.toHaveBeenCalled()
  })
})

// 转存失败的代价是「用户永久丢结果」:调用方会退回媒体桶签名 URL,而它在 STS 下
// 只活 ≤30 分钟。所以这一步的下载半程不能对一次网络抖动就认输 —— 上传半程有 COS
// SDK 的分片重试兜着(见 cosClient 的 SLICE_UPLOAD_HARD_TIMEOUT_MS 注释),下载半程
// 原先是裸 fetch、零重试。形状对齐 seedanceClient.downloadVideo(两次尝试、无间隔)。
describe('tencent/historyBucketTransfer 下载重试', () => {
  beforeEach(() => {
    vi.resetModules()
    uploadStreamToBucketMock.mockReset()
    uploadStreamToBucketMock.mockResolvedValue('https://history/permanent.mp4')
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('一次网络抖动后重试成功,照旧拿到永久 URL', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue(new Response('bytes'))
    globalThis.fetch = fetchMock as any

    const { transferUrlToHistoryBucket } = await import('../historyBucketTransfer')
    await expect(
      transferUrlToHistoryBucket({ sourceUrl: 'https://media/x.mp4', key: 'image-history/a.mp4' }),
    ).resolves.toBe('https://history/permanent.mp4')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('5xx 后重试成功', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValue(new Response('bytes'))
    globalThis.fetch = fetchMock as any

    const { transferUrlToHistoryBucket } = await import('../historyBucketTransfer')
    await expect(
      transferUrlToHistoryBucket({ sourceUrl: 'https://media/x.mp4', key: 'image-history/b.mp4' }),
    ).resolves.toBe('https://history/permanent.mp4')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('403(签名 URL 已过期)不重试 —— 再试一次也是 403', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('denied', { status: 403 }))
    globalThis.fetch = fetchMock as any

    const { transferUrlToHistoryBucket } = await import('../historyBucketTransfer')
    await expect(
      transferUrlToHistoryBucket({ sourceUrl: 'https://media/x.mp4', key: 'image-history/c.mp4' }),
    ).rejects.toThrow(/HTTP 403/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(uploadStreamToBucketMock).not.toHaveBeenCalled()
  })

  it('404(对象不存在)不重试', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('gone', { status: 404 }))
    globalThis.fetch = fetchMock as any

    const { transferUrlToHistoryBucket } = await import('../historyBucketTransfer')
    await expect(
      transferUrlToHistoryBucket({ sourceUrl: 'https://media/x.mp4', key: 'image-history/d.mp4' }),
    ).rejects.toThrow(/HTTP 404/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('429 是限流不是拒绝,仍然重试', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValue(new Response('bytes'))
    globalThis.fetch = fetchMock as any

    const { transferUrlToHistoryBucket } = await import('../historyBucketTransfer')
    await expect(
      transferUrlToHistoryBucket({ sourceUrl: 'https://media/x.mp4', key: 'image-history/e.mp4' }),
    ).resolves.toBe('https://history/permanent.mp4')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('两次尝试都失败 → 如实抛出最后一次的错误,尝试次数有上限', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'))
    globalThis.fetch = fetchMock as any

    const { transferUrlToHistoryBucket, DOWNLOAD_ATTEMPTS } = await import('../historyBucketTransfer')
    await expect(
      transferUrlToHistoryBucket({ sourceUrl: 'https://media/x.mp4', key: 'image-history/f.mp4' }),
    ).rejects.toThrow(/ETIMEDOUT/)
    expect(fetchMock).toHaveBeenCalledTimes(DOWNLOAD_ATTEMPTS)
    expect(uploadStreamToBucketMock).not.toHaveBeenCalled()
  })

  it('重试成功的那次会覆盖上一轮的残留字节,不会拼接出坏文件', async () => {
    // 第一次是 5xx（body 里带垃圾字节），第二次必须从零开始写而不是接在后面。
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('PARTIAL-GARBAGE-', { status: 503 }))
      .mockResolvedValue(new Response('clean-bytes'))
    globalThis.fetch = fetchMock as any

    let uploadedBytes = ''
    uploadStreamToBucketMock.mockImplementation(async (opts: any) => {
      uploadedBytes = await fsp.readFile(opts.filePath, 'utf-8')
      return 'https://history/permanent.mp4'
    })

    const { transferUrlToHistoryBucket } = await import('../historyBucketTransfer')
    await transferUrlToHistoryBucket({ sourceUrl: 'https://media/x.mp4', key: 'image-history/g.mp4' })

    expect(uploadedBytes).toBe('clean-bytes')
  })
})

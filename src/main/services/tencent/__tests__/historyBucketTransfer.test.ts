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

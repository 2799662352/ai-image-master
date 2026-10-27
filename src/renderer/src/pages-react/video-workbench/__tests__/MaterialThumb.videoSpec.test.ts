// 视频素材的缩略图来源。以前 materialThumbTarget 对视频一律回 undefined,参考视频
// 从挂上去就只有 🎬(2026-09-24 用户反馈)。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetAssetPreviewCacheForTest, resolveAssetPreviews } from '../../../features/video-workbench/assetPreview'
import { useQuotaStore } from '../../../stores/useQuotaStore'
import { materialThumbSpec } from '../MaterialThumb'

const COS_VIDEO = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/a/clip.mp4'

beforeEach(() => {
  resetAssetPreviewCacheForTest()
  useQuotaStore.setState({ billingSource: 'own-key', selectedPool: null })
})

afterEach(() => {
  delete (globalThis as unknown as { electronAPI?: unknown }).electronAPI
})

describe('materialThumbSpec', () => {
  it('本地视频 → 主进程截帧', () => {
    expect(materialThumbSpec('video', { name: 'c1.mp4', src: 'D:\\clips\\c1.mp4' })).toEqual({
      key: 'video-frame:D:\\clips\\c1.mp4',
      kind: 'video-frame',
      src: 'D:\\clips\\c1.mp4',
    })
  })

  it('COS 上的视频 → 数据万象封面;非 COS 的网址没法出封面', () => {
    expect(materialThumbSpec('video', { name: 'v', src: COS_VIDEO })?.kind).toBe('video-poster')
    expect(materialThumbSpec('video', { name: 'v', src: 'https://example.com/v.mp4' })).toBeUndefined()
  })

  it('素材库里的视频:查到 COS 原始地址后出封面,查到之前不瞎猜', async () => {
    const m = { name: '动作参考', src: 'asset://v1' }
    expect(materialThumbSpec('video', m)).toBeUndefined()

    useQuotaStore.setState({ billingSource: 'platform', selectedPool: { projectId: 42, producerProjectId: null } })
    ;(globalThis as unknown as { electronAPI?: unknown }).electronAPI = {
      portraitLibrary: {
        list: async () => ({
          ok: true,
          data: { Items: [{ Id: 'v1', AssetType: 'Video', Status: 'Active', URL: COS_VIDEO }], TotalCount: 1, HiddenCount: 0, Truncated: false },
        }),
        resolve: async () => ({ ok: true, data: null }),
      },
    }
    await resolveAssetPreviews(['v1'])
    expect(materialThumbSpec('video', m)).toEqual({
      key: `video-poster:${COS_VIDEO}`,
      kind: 'video-poster',
      src: COS_VIDEO,
    })
  })

  it('图片仍走原来的地址;音频不出缩略图', () => {
    expect(materialThumbSpec('image', { name: 'a', src: 'D:\\a.png' })).toEqual({ key: 'D:\\a.png', kind: 'image', src: 'D:\\a.png' })
    expect(materialThumbSpec('audio', { name: 'b', src: 'D:\\b.mp3' })).toBeUndefined()
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  DEPTH_MAX_SOURCE_BYTES,
  DEPTH_UPSTREAM_MODEL_ID_BASE,
  checkDepthInput,
  depthUpstreamModelId,
  pickDepthSourceUrl,
} from '../model'
import { SEEDANCE_MODEL_IDS_BY_REGION } from '../../seedance/region'

const MB = 1024 * 1024
const statOf = (size: number | null) => ({ statSize: vi.fn(async () => size) })

describe('depthUpstreamModelId', () => {
  it('三档分辨率各对应一个网关模型名(腾讯后端三档产物一致,名字不能变)', () => {
    expect(depthUpstreamModelId('480p')).toBe('rh-video-depth-480p')
    expect(depthUpstreamModelId('720p')).toBe('rh-video-depth-720p')
    expect(depthUpstreamModelId('1080p')).toBe('rh-video-depth-1080p')
  })

  it('大小写与空白不敏感(上行口径是小写,UI 偶尔给大写)', () => {
    expect(depthUpstreamModelId(' 720P ')).toBe('rh-video-depth-720p')
  })

  it('不认识的分辨率抛错,不静默兜底(档位就是价格)', () => {
    expect(() => depthUpstreamModelId('4k')).toThrow(/4k/)
    expect(() => depthUpstreamModelId('')).toThrow()
  })

  it('区域表里 depth 登记的只是前缀,不是能直接发的模型 id', () => {
    // 那两张表要的是穷尽性;真正的 id 必须带分辨率后缀。别让前缀被当成 id 发出去。
    for (const region of ['global', 'cn'] as const) {
      expect(SEEDANCE_MODEL_IDS_BY_REGION[region].depth).toBe(DEPTH_UPSTREAM_MODEL_ID_BASE)
    }
    expect(DEPTH_UPSTREAM_MODEL_ID_BASE).not.toBe(depthUpstreamModelId('480p'))
  })
})

describe('pickDepthSourceUrl', () => {
  it('取那一段 video_url,忽略 text 条目', () => {
    expect(
      pickDepthSourceUrl([
        { type: 'text', text: 'ignored' },
        { type: 'video_url', role: 'reference_video', video_url: { url: 'https://c.example/a.mp4' } },
      ]),
    ).toBe('https://c.example/a.mp4')
  })

  it('0 段或多段都抛错', () => {
    expect(() => pickDepthSourceUrl([{ type: 'text', text: 'x' }])).toThrow(/恰好一段/)
    expect(() =>
      pickDepthSourceUrl([
        { type: 'video_url', video_url: { url: 'https://a/1.mp4' } },
        { type: 'video_url', video_url: { url: 'https://a/2.mp4' } },
      ]),
    ).toThrow(/恰好一段/)
  })

  it('图片 / 音频条目不算源视频', () => {
    expect(() =>
      pickDepthSourceUrl([
        { type: 'image_url', image_url: { url: 'https://a/1.png' } },
        { type: 'audio_url', audio_url: { url: 'https://a/1.mp3' } },
      ]),
    ).toThrow(/恰好一段/)
  })

  it('非 http(s) 拒绝 —— 上游自己去拉,拿不到 data: / asset:// / 本机路径', () => {
    for (const bad of ['asset://x', 'data:video/mp4;base64,AAAA', 'C:\\v\\a.mp4', 'file:///a.mp4']) {
      expect(() => pickDepthSourceUrl([{ type: 'video_url', video_url: { url: bad } }])).toThrow(/公网/)
    }
  })
})

describe('checkDepthInput', () => {
  it('一段远程 https 源视频放行,不去量体积(只有上游知道)', async () => {
    const deps = statOf(null)
    expect(
      await checkDepthInput({ prompt: 'x', model: 'depth', referenceVideos: ['https://a/1.mp4'] }, deps),
    ).toEqual([])
    expect(deps.statSize).not.toHaveBeenCalled()
  })

  it('本地文件 ≤ 100 MB 放行,恰好 100 MB 也放行', async () => {
    const input = { prompt: 'x', model: 'depth' as const, referenceVideos: ['D:/v/a.mp4'] }
    expect(await checkDepthInput(input, statOf(10 * MB))).toEqual([])
    expect(await checkDepthInput(input, statOf(DEPTH_MAX_SOURCE_BYTES))).toEqual([])
  })

  it('本地文件超 100 MB 提交前就拦,并指出怎么压', async () => {
    const errors = await checkDepthInput(
      { prompt: 'x', model: 'depth', referenceVideos: ['D:/v/big.mp4'] },
      statOf(DEPTH_MAX_SOURCE_BYTES + 1),
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/100\.0 MB/)
    expect(errors[0]).toMatch(/ffmpeg-win/)
  })

  it('读不到体积(不存在)不在这里报 —— 交给中转那一步给出带路径的统一错误', async () => {
    expect(
      await checkDepthInput({ prompt: 'x', model: 'depth', referenceVideos: ['D:/nope.mp4'] }, statOf(null)),
    ).toEqual([])
  })

  it('data: 按 base64 估算体积', async () => {
    const huge = `data:video/mp4;base64,${'A'.repeat(Math.ceil((DEPTH_MAX_SOURCE_BYTES * 4) / 3) + 8)}`
    const errors = await checkDepthInput(
      { prompt: 'x', model: 'depth', referenceVideos: [huge] },
      statOf(null),
    )
    expect(errors[0]).toMatch(/MB/)
    expect(
      await checkDepthInput(
        { prompt: 'x', model: 'depth', referenceVideos: ['data:video/mp4;base64,AAAA'] },
        statOf(null),
      ),
    ).toEqual([])
  })

  it('asset:// 不行 —— 上游要公网地址', async () => {
    const errors = await checkDepthInput(
      { prompt: 'x', model: 'depth', referenceVideos: ['asset://asset-2026'] },
      statOf(null),
    )
    expect(errors[0]).toMatch(/asset/)
  })

  it('没传 / 传多段源视频', async () => {
    expect((await checkDepthInput({ prompt: 'x', model: 'depth' }, statOf(null)))[0]).toMatch(/恰好一段/)
    expect(
      (await checkDepthInput(
        { prompt: 'x', model: 'depth', referenceVideos: ['https://a/1.mp4', 'https://a/2.mp4'] },
        statOf(null),
      ))[0],
    ).toMatch(/恰好一段/)
  })

  it('单数别名 referenceVideo 也算一段(buildContent 会并入)', async () => {
    expect(
      await checkDepthInput({ prompt: 'x', model: 'depth', referenceVideo: 'https://a/1.mp4' }, statOf(null)),
    ).toEqual([])
  })

  it('带图片 / 首尾帧 / 音频都拒,且在中转之前拦(不白传一遍)', async () => {
    const base = { prompt: 'x', model: 'depth' as const, referenceVideos: ['https://a/1.mp4'] }
    for (const extra of [
      { referenceImages: ['https://a/1.png'] },
      { firstFrame: 'https://a/f.png' },
      { lastFrame: 'https://a/l.png' },
      { referenceAudios: ['https://a/1.mp3'] },
      { referenceAudio: 'https://a/1.mp3' },
    ]) {
      const errors = await checkDepthInput({ ...base, ...extra }, statOf(null))
      expect(errors.join('；')).toMatch(/只接受一段源视频/)
    }
  })

  it('taskMode 拒绝', async () => {
    const errors = await checkDepthInput(
      { prompt: 'x', model: 'depth', referenceVideos: ['https://a/1.mp4'], taskMode: 'edit' },
      statOf(null),
    )
    expect(errors.join('；')).toMatch(/taskMode/)
  })

  it('空串 / 纯空白的源视频不算数', async () => {
    expect(
      (await checkDepthInput({ prompt: 'x', model: 'depth', referenceVideos: ['  '] }, statOf(null)))[0],
    ).toMatch(/恰好一段/)
  })
})

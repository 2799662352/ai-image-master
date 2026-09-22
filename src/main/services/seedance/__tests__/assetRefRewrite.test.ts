// @vitest-environment node
/**
 * 提交前「直传 URL → asset://」改写的纯函数:图片 / 视频 / 音频三种参考都收,顺序不变。
 * 背景见 assetRefRewrite.ts 头注释(视频工作台真机撞到
 * `InputVideoSensitiveContentDetected.PrivacyInformation`,原先只登记图片;音频按用户拍板一并加入)。
 */
import { describe, expect, it } from 'vitest'
import { applyAssetRewrites, collectDirectMediaRefs, libraryAssetName } from '../assetRefRewrite'
import { translateSeedanceTaskError } from '../assets'
import type { SeedanceContentItem } from '../types'

const content: SeedanceContentItem[] = [
  { type: 'text', text: '@图片1 的人在 @视频1 的场景里' },
  { type: 'image_url', role: 'reference_image', image_url: { url: 'https://cos/a.png' } },
  { type: 'image_url', role: 'reference_image', image_url: { url: 'asset://already-there' } },
  { type: 'video_url', role: 'reference_video', video_url: { url: 'https://cos/clip.mp4' } },
  { type: 'video_url', role: 'reference_video', video_url: { url: 'https://cos/clip.mp4' } },
  { type: 'audio_url', role: 'reference_audio', audio_url: { url: 'https://cos/bgm.mp3' } },
  { type: 'image_url', role: 'first_frame', image_url: { url: 'data:image/png;base64,AAAA' } },
]

describe('collectDirectMediaRefs', () => {
  it('挑出还没变成 asset:// 的图片 / 视频 / 音频,按顺序、同 URL 去重;已登记项不收', () => {
    expect(collectDirectMediaRefs(content)).toEqual([
      { kind: 'image', url: 'https://cos/a.png', role: 'reference_image' },
      { kind: 'video', url: 'https://cos/clip.mp4', role: 'reference_video' },
      { kind: 'audio', url: 'https://cos/bgm.mp3', role: 'reference_audio' },
      { kind: 'image', url: 'data:image/png;base64,AAAA', role: 'first_frame' },
    ])
  })

  it('libraryAssetName 沿用「视频参考-<role>-<ts>」约定,缺 role 时按类型补默认角色', () => {
    expect(libraryAssetName({ kind: 'video', url: 'x' })).toMatch(/^视频参考-reference_video-\d+$/)
    expect(libraryAssetName({ kind: 'audio', url: 'x' })).toMatch(/^视频参考-reference_audio-\d+$/)
    expect(libraryAssetName({ kind: 'image', url: 'x', role: 'first_frame' })).toMatch(/^视频参考-first_frame-\d+$/)
  })
})

describe('applyAssetRewrites', () => {
  it('图片 / 视频 / 音频都回填,数组顺序与其它项原样;没登记上的保留原 URL', () => {
    const rewrites = new Map([
      ['https://cos/a.png', 'asset://img-1'],
      ['https://cos/clip.mp4', 'asset://vid-1'],
      ['https://cos/bgm.mp3', 'asset://aud-1'],
    ])
    const out = applyAssetRewrites(content, rewrites)
    expect(out.map((item) => item.type)).toEqual(content.map((item) => item.type))
    expect(out[1]).toEqual({ type: 'image_url', role: 'reference_image', image_url: { url: 'asset://img-1' } })
    expect(out[3]).toEqual({ type: 'video_url', role: 'reference_video', video_url: { url: 'asset://vid-1' } })
    expect(out[4]).toEqual({ type: 'video_url', role: 'reference_video', video_url: { url: 'asset://vid-1' } })
    expect(out[5]).toEqual({ type: 'audio_url', role: 'reference_audio', audio_url: { url: 'asset://aud-1' } })
    // 未登记的 data: 首帧、文本原样。
    expect(out[6]).toEqual(content[6])
    expect(out[0]).toEqual(content[0])
    // 不改输入。
    expect(content[3]).toEqual({ type: 'video_url', role: 'reference_video', video_url: { url: 'https://cos/clip.mp4' } })
  })

  it('没有任何改写时返回等价副本', () => {
    expect(applyAssetRewrites(content, new Map())).toEqual(content)
  })
})

describe('translateSeedanceTaskError · 真人检测', () => {
  const raw =
    '网关视频 API 400: fail_to_fetch_task: {"error":{"code":"InputVideoSensitiveContentDetected.PrivacyInformation",'
    + '"message":"The request failed because the input video \'content[6]\' may contain real person. '
    + 'Request id: 0217900569396677dd244b6caaa2409295dae72fd71f679100dd6","param":"content[6]","type":"BadRequest"}}'

  it('视频版:说清是哪一项、为什么被拒、有哪几条出路,并保留 request id', () => {
    const text = translateSeedanceTaskError(raw)
    expect(text).toContain('参考视频(content[6] 那一项)被上游判定含有真人')
    expect(text).toContain('ffmpeg')
    expect(text).toContain('人像库')
    expect(text).toContain('Request id: 0217900569396677dd244b6caaa2409295dae72fd71f679100dd6')
    expect(text).not.toContain('fail_to_fetch_task')
  })

  it('图片版走同一条,出路换成「从人像库选素材」', () => {
    const text = translateSeedanceTaskError(
      '{"error":{"code":"InputImageSensitiveContentDetected.PrivacyInformation","message":"input image \'content[2]\' may contain real person","param":"content[2]"}}',
    )
    expect(text).toContain('参考图(content[2] 那一项)')
    expect(text).toContain('asset://')
  })

  it('认不出的错误原样返回', () => {
    expect(translateSeedanceTaskError('something else')).toBe('something else')
  })
})

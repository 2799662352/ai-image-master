// @vitest-environment node
//
// content[] 的顺序即素材编号。
//
// Seedance OpenAPI §2.3「提示词里加 @素材」写得很直接:「如果你在提示词中使用
// `@参考N / @视频N / @音频N` 这类标签,请确保它们与 `content[]` 里的素材顺序
// 一一对应」。也就是说「图片1」不是某个 ID,而是「content 里第一个 image_url」。
//
// 这条测试存在的唯一理由:并发化素材上传之后,如果写成「谁传完就 push 谁」,
// 数组顺序会变成**完成顺序**而不是**输入顺序** —— 一张 4MB 的人物图和几张
// 300KB 的场景图同时上传,人物图必然最后到,于是提示词里的「图片1」指向了场景。
// 上游收到的是一个完全合法的请求,不报任何错,只是内容跟用户想的不一样;
// 而且网速一变顺序又变,同一张卡两次生成结果不同。
//
// 所以这里**故意让后面的素材先完成**,断言 content 顺序仍与输入一致。
// 本地跑几张体积相近的图很可能六次都碰巧顺序正确,那样等于没测。

import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveMediaUrl = vi.fn()

vi.mock('../mediaResolve', () => ({
  resolveMediaUrl: (...a: unknown[]) => resolveMediaUrl(...a),
  MAX_INLINE_FILE_BYTES: 512 * 1024,
}))

vi.mock('../promptReferences', () => ({
  normalizeSeedancePromptReferences: (t: string) => t,
}))

/**
 * 越靠后的素材越快返回 —— 与「大图排前面、小图排后面」的真实情形同构。
 *
 * 延迟按**素材名**查表,不按调用次序。用调用计数会让测试形同虚设:实现若多调
 * 一轮或换个次序,计数就越界、延迟全变 0、所有素材同时返回,顺序碰巧正确 ——
 * 一条永远不会红的测试。(这个坑本轮真踩过。)
 */
function resolveWithDelays(delaysBySrc: Record<string, number>): void {
  resolveMediaUrl.mockImplementation((src: string) => {
    const delay = delaysBySrc[src]
    if (delay === undefined) throw new Error(`测试未给 "${src}" 配延迟,顺序断言将失去意义`)
    return new Promise((res) => setTimeout(() => res(`https://cos/${src}`), delay))
  })
}

beforeEach(() => {
  resolveMediaUrl.mockReset()
})

describe('buildContent — 素材顺序必须等于输入顺序', () => {
  it('参考图:后面的先传完,content 顺序仍是 1/2/3', async () => {
    const { __buildContentForTests } = await import('../runtime')
    // 第 1 张最慢(30ms),第 3 张最快(1ms)。
    resolveWithDelays({ 'hero.png': 30, 'room.jpg': 10, 'prop.png': 1 })

    const content = await __buildContentForTests({
      prompt: 'p',
      referenceImages: ['hero.png', 'room.jpg', 'prop.png'],
    })

    const urls = content
      .filter((c): c is Extract<typeof c, { type: 'image_url' }> => c.type === 'image_url')
      .map((c) => c.image_url.url)
    expect(urls).toEqual(['https://cos/hero.png', 'https://cos/room.jpg', 'https://cos/prop.png'])
  })

  it('参考视频与参考音频各自保序,且图片段整体在视频段之前', async () => {
    const { __buildContentForTests } = await import('../runtime')
    resolveWithDelays({
      'i1.png': 40,
      'i2.png': 30,
      'v1.mp4': 20,
      'v2.mp4': 10,
      'a1.mp3': 5,
      'a2.mp3': 1,
    })

    const content = await __buildContentForTests({
      prompt: 'p',
      referenceImages: ['i1.png', 'i2.png'],
      referenceVideos: ['v1.mp4', 'v2.mp4'],
      referenceAudios: ['a1.mp3', 'a2.mp3'],
    })

    const shape = content.map((c) => c.type)
    expect(shape).toEqual([
      'text',
      'image_url',
      'image_url',
      'video_url',
      'video_url',
      'audio_url',
      'audio_url',
    ])

    const pick = (t: string): string[] =>
      content
        .filter((c) => c.type === t)
        .map((c) =>
          t === 'image_url'
            ? (c as { image_url: { url: string } }).image_url.url
            : t === 'video_url'
              ? (c as { video_url: { url: string } }).video_url.url
              : (c as { audio_url: { url: string } }).audio_url.url,
        )
    expect(pick('image_url')).toEqual(['https://cos/i1.png', 'https://cos/i2.png'])
    expect(pick('video_url')).toEqual(['https://cos/v1.mp4', 'https://cos/v2.mp4'])
    expect(pick('audio_url')).toEqual(['https://cos/a1.mp3', 'https://cos/a2.mp3'])
  })

  it('首帧/尾帧带 role,且排在参考图之前', async () => {
    const { __buildContentForTests } = await import('../runtime')
    resolveWithDelays({ 'f.png': 50, 'l.png': 40, 'r.png': 1 })

    const content = await __buildContentForTests({
      prompt: 'p',
      firstFrame: 'f.png',
      lastFrame: 'l.png',
      referenceImages: ['r.png'],
    })

    const roles = content.filter((c) => c.type === 'image_url').map((c) => (c as { role?: string }).role)
    expect(roles).toEqual(['first_frame', 'last_frame', 'reference_image'])
  })

  it('单数字段并入数组时排在复数字段之后 —— 与串行实现的顺序一致', async () => {
    const { __buildContentForTests } = await import('../runtime')
    resolveWithDelays({ 'plural.mp4': 30, 'singular.mp4': 1 })

    const content = await __buildContentForTests({
      prompt: 'p',
      referenceVideos: ['plural.mp4'],
      referenceVideo: 'singular.mp4',
    })

    const urls = content
      .filter((c) => c.type === 'video_url')
      .map((c) => (c as { video_url: { url: string } }).video_url.url)
    expect(urls).toEqual(['https://cos/plural.mp4', 'https://cos/singular.mp4'])
  })

  it('并发确实发生了 —— 三张图不是一张传完才传下一张', async () => {
    const { __buildContentForTests } = await import('../runtime')
    let concurrent = 0
    let peak = 0
    resolveMediaUrl.mockImplementation((src: string) => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      return new Promise((res) =>
        setTimeout(() => {
          concurrent -= 1
          res(`https://cos/${src}`)
        }, 10),
      )
    })

    await __buildContentForTests({ prompt: 'p', referenceImages: ['a.png', 'b.png', 'c.png'] })
    expect(peak).toBeGreaterThan(1)
  })
})

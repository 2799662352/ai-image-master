// @vitest-environment node
//
// 素材解析的两条不变量:
//  1. **不设体积闸门** —— 多大都往上游送,让上游给出确切上限;
//  2. **一份素材一套降级策略** —— 中转失败之后怎么办,不能取决于这份素材是以
//     本地路径还是 data: URL 进来的。历史上正是这里分了岔:本地路径直接抛错,
//     data: URL 悄悄降级回内联,同一张图两种命运,而用户根本不知道自己走的
//     是哪个入口。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const relayDataUrlToCos = vi.fn()
const relayFileToCos = vi.fn()
const stat = vi.fn()
const readFile = vi.fn()

vi.mock('../../tencent/mediaRelay', () => ({
  relayDataUrlToCos: (...a: unknown[]) => relayDataUrlToCos(...a),
  relayFileToCos: (...a: unknown[]) => relayFileToCos(...a),
}))

vi.mock('node:fs/promises', () => ({
  default: {
    stat: (...a: unknown[]) => stat(...a),
    readFile: (...a: unknown[]) => readFile(...a),
  },
}))

/** 造一个「原始字节数约为 bytes」的 base64 data: URL。 */
function dataUrlOfBytes(bytes: number): string {
  return `data:image/png;base64,${'A'.repeat(Math.ceil((bytes * 4) / 3))}`
}

function fileOfBytes(bytes: number) {
  stat.mockResolvedValue({ size: bytes, isFile: () => true })
  readFile.mockResolvedValue(Buffer.from('fake-bytes'))
}

beforeEach(() => {
  relayDataUrlToCos.mockReset()
  relayFileToCos.mockReset()
  stat.mockReset()
  readFile.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveMediaUrl — 直接透传', () => {
  it('http(s) 与 asset:// 原样返回,不碰磁盘也不碰中转', async () => {
    const { resolveMediaUrl } = await import('../mediaResolve')
    expect(await resolveMediaUrl('https://cdn/x.png', 'ref')).toBe('https://cdn/x.png')
    expect(await resolveMediaUrl('asset://abc123', 'ref')).toBe('asset://abc123')
    expect(stat).not.toHaveBeenCalled()
    expect(relayFileToCos).not.toHaveBeenCalled()
  })
})

describe('resolveMediaUrl — 不设体积闸门', () => {
  it('500MB 本地视频照样往上走,交给上游裁决', async () => {
    const { resolveMediaUrl } = await import('../mediaResolve')
    fileOfBytes(500 * 1024 * 1024)
    relayFileToCos.mockResolvedValue('https://bucket/relayed.mp4')

    const url = await resolveMediaUrl('D:\\clips\\hero.mp4', 'referenceVideos[0]')

    expect(url).toBe('https://bucket/relayed.mp4')
    // 走流式上传,整个文件不进 Buffer —— 这才是能取消闸门的前提。
    expect(readFile).not.toHaveBeenCalled()
    expect(relayFileToCos).toHaveBeenCalledWith('D:\\clips\\hero.mp4', 'video/mp4', {
      fileSize: 500 * 1024 * 1024,
    })
  })

  it('小文件仍然内联,省掉一次往返', async () => {
    const { resolveMediaUrl } = await import('../mediaResolve')
    fileOfBytes(100 * 1024)
    readFile.mockResolvedValue(Buffer.from('tiny'))

    const url = await resolveMediaUrl('D:\\shots\\a.png', 'referenceImages[0]')

    expect(url).toBe(`data:image/png;base64,${Buffer.from('tiny').toString('base64')}`)
    expect(relayFileToCos).not.toHaveBeenCalled()
  })

  // 上游按 URL 后缀判断素材类型,`.bin` 链接可能被直接拒掉;而 mime 反查表是有限
  // 的,.mkv/.avi/.flac 这类查不到就会退化成 bin。所以扩展名不认识时要能吃下
  // 调用方给的 mime(渲染端 File.type),中转那头也会用文件自己的扩展名生成 Key。
  it('扩展名查不到时用调用方给的 mime,不退化成 application/octet-stream', async () => {
    const { resolveMediaUrl } = await import('../mediaResolve')
    fileOfBytes(80 * 1024 * 1024)
    relayFileToCos.mockResolvedValue('https://bucket/ok.mkv')

    await resolveMediaUrl('D:\\clips\\hero.mkv', 'referenceVideos[0]', 'video/x-matroska')

    expect(relayFileToCos.mock.calls[0][1]).toBe('video/x-matroska')
  })

  it('扩展名认识时以扩展名为准 —— 磁盘上的事实优先于浏览器的猜测', async () => {
    const { resolveMediaUrl } = await import('../mediaResolve')
    fileOfBytes(80 * 1024 * 1024)
    relayFileToCos.mockResolvedValue('https://bucket/ok.mp4')

    await resolveMediaUrl('D:\\clips\\hero.mp4', 'referenceVideos[0]', 'application/octet-stream')

    expect(relayFileToCos.mock.calls[0][1]).toBe('video/mp4')
  })

  it('路径不存在时说清是读不到文件,而不是甩一句上传失败', async () => {
    const { resolveMediaUrl } = await import('../mediaResolve')
    stat.mockRejectedValue(new Error('ENOENT'))
    await expect(resolveMediaUrl('D:\\nope.png', 'referenceImages[0]')).rejects.toThrow(
      /cannot read local file/,
    )
  })

  it('目录不算文件 —— 别把一个目录喂给流式上传', async () => {
    const { resolveMediaUrl } = await import('../mediaResolve')
    stat.mockResolvedValue({ size: 4096, isFile: () => false })
    await expect(resolveMediaUrl('D:\\clips', 'referenceVideos[0]')).rejects.toThrow(
      /cannot read local file/,
    )
    expect(relayFileToCos).not.toHaveBeenCalled()
  })
})

describe('resolveMediaUrl — 中转失败后的降级,两个入口必须同命', () => {
  const relayDown = { code: 'RequestError', error: { code: 'ENOTFOUND' } }

  it('本地路径:仍在上游内联限内 → 降级内联(以前这里直接抛)', async () => {
    const { resolveMediaUrl } = await import('../mediaResolve')
    fileOfBytes(700 * 1024) // 超过 512KB 内联线,但在 1MB 上游线内
    readFile.mockResolvedValue(Buffer.from('seven-hundred-kb'))
    relayFileToCos.mockRejectedValue(relayDown)

    const url = await resolveMediaUrl('D:\\shots\\mid.png', 'referenceImages[0]')

    expect(url).toBe(`data:image/png;base64,${Buffer.from('seven-hundred-kb').toString('base64')}`)
  })

  it('data: URL:同一体积同样降级内联', async () => {
    const { resolveMediaUrl } = await import('../mediaResolve')
    const inline = dataUrlOfBytes(700 * 1024)
    relayDataUrlToCos.mockRejectedValue(relayDown)

    expect(await resolveMediaUrl(inline, 'referenceImages[0]')).toBe(inline)
  })

  it('本地路径:超过上游内联限 → 报错,且带上真实原因', async () => {
    const { resolveMediaUrl } = await import('../mediaResolve')
    fileOfBytes(6 * 1024 * 1024)
    relayFileToCos.mockRejectedValue(relayDown)

    const error = await resolveMediaUrl('D:\\shots\\big.png', 'referenceImages[0]').catch(
      (e: unknown) => e as Error,
    )

    expect(error.message).toContain('referenceImages[0]')
    expect(error.message).toContain('6.0MB')
    expect(error.message).toContain('ENOTFOUND')
    expect(error.message).not.toContain('[object Object]')
    // 旧文案让用户「压到 512KB 以下」,那只是绕开中转,不解决中转为什么失败。
    expect(error.message).not.toContain('512KB')
  })

  it('data: URL:超过上游内联限 → 同样报错,不再硬塞进去换一句 url is too long', async () => {
    const { resolveMediaUrl } = await import('../mediaResolve')
    relayDataUrlToCos.mockRejectedValue(relayDown)

    await expect(resolveMediaUrl(dataUrlOfBytes(6 * 1024 * 1024), 'firstFrame')).rejects.toThrow(
      /firstFrame: 6\.0MB/,
    )
  })

  it('中转成功时不白读一遍文件 —— 降级路径是惰性的', async () => {
    const { resolveMediaUrl } = await import('../mediaResolve')
    fileOfBytes(700 * 1024)
    relayFileToCos.mockResolvedValue('https://bucket/ok.png')

    await resolveMediaUrl('D:\\shots\\mid.png', 'referenceImages[0]')

    expect(readFile).not.toHaveBeenCalled()
  })
})

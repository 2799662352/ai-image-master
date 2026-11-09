import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  IMAGE_SNIFF_BYTES,
  mimeFromUrl,
  mimeTypeToExtension,
  readImageHead,
  resolveFetchedImageMime,
  sniffImageMime,
} from '../imageMime'

const bytes = (...n: number[]): Uint8Array => Uint8Array.from(n)
const text = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'utf8'))

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0)
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10)
const GIF89 = text('GIF89a\x01\x00\x01\x00')
const GIF87 = text('GIF87a\x01\x00\x01\x00')
const WEBP = Uint8Array.from([...text('RIFF'), 0, 0, 0, 0, ...text('WEBPVP8 ')])

describe('mimeTypeToExtension / mimeFromUrl:SVG 不再落成 .bin / 被当 png', () => {
  it('svg ↔ image/svg+xml,其余既有映射不变', () => {
    expect(mimeTypeToExtension('image/svg+xml')).toBe('svg')
    expect(mimeTypeToExtension('image/gif')).toBe('gif')
    expect(mimeTypeToExtension('image/png')).toBe('png')
    expect(mimeTypeToExtension('image/jpeg')).toBe('jpg')
    expect(mimeTypeToExtension('image/jpg')).toBe('jpg')
    expect(mimeTypeToExtension('image/webp')).toBe('webp')
    expect(mimeTypeToExtension('application/octet-stream')).toBe('bin')
  })

  it('URL 后缀(含带查询串)认 svg,没后缀回落 fallback', () => {
    expect(mimeFromUrl('https://x/a/b.svg')).toBe('image/svg+xml')
    expect(mimeFromUrl('https://x/a/B.SVG?sig=1')).toBe('image/svg+xml')
    expect(mimeFromUrl('https://x/a/b.gif')).toBe('image/gif')
    expect(mimeFromUrl('https://x/response_images/17137/2026/11/09/241')).toBe('image/png')
    expect(mimeFromUrl('https://x/241', 'image/jpeg')).toBe('image/jpeg')
  })
})

describe('sniffImageMime:看文件头字节', () => {
  it('png / jpeg / gif(87a 与 89a)/ webp', () => {
    expect(sniffImageMime(PNG)).toBe('image/png')
    expect(sniffImageMime(JPEG)).toBe('image/jpeg')
    expect(sniffImageMime(GIF89)).toBe('image/gif')
    expect(sniffImageMime(GIF87)).toBe('image/gif')
    expect(sniffImageMime(WEBP)).toBe('image/webp')
  })

  it('RIFF 但不是 WEBP(比如 WAV / AVI)不算图片', () => {
    expect(sniffImageMime(Uint8Array.from([...text('RIFF'), 0, 0, 0, 0, ...text('WAVEfmt ')]))).toBeNull()
  })

  it('SVG:直接 <svg、带 BOM / 前导空白、带 XML 声明 + 注释 + DOCTYPE', () => {
    expect(sniffImageMime(text('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml')
    expect(sniffImageMime(text('\uFEFF  \n<svg width="10"></svg>'))).toBe('image/svg+xml')
    expect(sniffImageMime(text('<?xml version="1.0"?>\n<!-- c -->\n<!DOCTYPE svg PUBLIC "x" "y">\n<svg>'))).toBe('image/svg+xml')
    expect(sniffImageMime(text('<SVG viewBox="0 0 1 1"/>'))).toBe('image/svg+xml')
  })

  it('不是图片的文本 / 二进制 / 空 / 太短 → null(不乱认)', () => {
    expect(sniffImageMime(text('<html><body><svg></svg></body></html>'))).toBeNull()
    expect(sniffImageMime(text('<?xml version="1.0"?><rss></rss>'))).toBeNull()
    expect(sniffImageMime(text('{"error":"expired"}'))).toBeNull()
    expect(sniffImageMime(new Uint8Array(0))).toBeNull()
    expect(sniffImageMime(bytes(0x89, 0x50))).toBeNull()
    expect(sniffImageMime(text('<svgx>'))).toBeNull()
  })
})

describe('readImageHead:流式落盘后只读开头,不把整张图读进内存', () => {
  it('只读前 IMAGE_SNIFF_BYTES 字节;SVG / GIF 落盘后能被认出', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'imgmime-'))
    try {
      const svgFile = path.join(dir, 'a')
      await fsp.writeFile(svgFile, '<svg xmlns="http://www.w3.org/2000/svg">' + 'x'.repeat(5000) + '</svg>')
      const head = await readImageHead(svgFile)
      expect(head.byteLength).toBe(IMAGE_SNIFF_BYTES)
      expect(sniffImageMime(head)).toBe('image/svg+xml')

      const gifFile = path.join(dir, 'b')
      await fsp.writeFile(gifFile, Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'))
      expect(sniffImageMime(await readImageHead(gifFile))).toBe('image/gif')
    } finally {
      await fsp.rm(dir, { recursive: true, force: true })
    }
  })

  it('文件不存在 / 读不了 → 空(等于认不出,不抛)', async () => {
    const head = await readImageHead(path.join(os.tmpdir(), 'imgmime-definitely-missing-file'))
    expect(head.byteLength).toBe(0)
    expect(sniffImageMime(head)).toBeNull()
  })
})

describe('resolveFetchedImageMime:响应头可信就信头,不可信才看字节', () => {
  const SVG = text('<svg xmlns="http://www.w3.org/2000/svg"/>')

  it('头是 image/* → 以头为准(含大小写与 ;charset),哪怕字节另有说法', () => {
    expect(resolveFetchedImageMime('image/gif', 'image/png', PNG)).toBe('image/gif')
    expect(resolveFetchedImageMime('Image/WebP; charset=binary', 'image/png', PNG)).toBe('image/webp')
    expect(resolveFetchedImageMime('image/svg+xml', 'image/png', SVG)).toBe('image/svg+xml')
  })

  it('头缺失 / octet-stream / 非图片 → 看字节:认得出就用(extension-less 的 apiyi 链就是这个场景)', () => {
    expect(resolveFetchedImageMime(undefined, 'image/png', SVG)).toBe('image/svg+xml')
    expect(resolveFetchedImageMime('application/octet-stream', 'image/png', GIF89)).toBe('image/gif')
    expect(resolveFetchedImageMime('binary/octet-stream', 'image/png', SVG)).toBe('image/svg+xml')
    expect(resolveFetchedImageMime('text/plain', 'image/png', SVG)).toBe('image/svg+xml')
  })

  it('头不可信且字节也认不出 → 保持调用方的猜测,不凭空改', () => {
    expect(resolveFetchedImageMime(undefined, 'image/jpeg', text('hello'))).toBe('image/jpeg')
    expect(resolveFetchedImageMime('application/octet-stream', 'image/png', new Uint8Array(0))).toBe('image/png')
  })
})

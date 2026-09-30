// src/main/voice/tarGz.ts
/**
 * 最小 ustar 打包 + gzip。只为把 Vosk 官方 zip 模型转成 vosk-browser 能吃的
 * `.tar.gz`(它在 Worker 里用 libarchive 解包),所以只写普通文件和目录两种条目。
 */

import { gzip } from 'node:zlib'
import { promisify } from 'node:util'

const gzipAsync = promisify(gzip)

export interface TarEntry {
  /** POSIX 相对路径;目录以 `/` 结尾且不带 data。 */
  name: string
  data?: Uint8Array
}

const BLOCK = 512

function writeField(buf: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > length) throw new Error(`tar 字段超长: ${value}`)
  bytes.copy(buf, offset)
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  writeField(buf, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`)
}

/** ustar 的 name 只有 100 字节,更长的路径在 `/` 处拆到 155 字节的 prefix。 */
function splitName(name: string): { prefix: string; short: string } {
  if (Buffer.byteLength(name) <= 100) return { prefix: '', short: name }
  const probe = name.endsWith('/') ? name.slice(0, -1) : name
  for (let i = probe.lastIndexOf('/'); i > 0; i = probe.lastIndexOf('/', i - 1)) {
    const prefix = name.slice(0, i)
    const short = name.slice(i + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(short) <= 100) return { prefix, short }
  }
  throw new Error(`tar 路径过长: ${name}`)
}

function header(name: string, size: number, isDir: boolean, mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK)
  const { prefix, short } = splitName(name)
  writeField(h, 0, 100, short)
  writeOctal(h, 100, 8, isDir ? 0o755 : 0o644)
  writeOctal(h, 108, 8, 0)
  writeOctal(h, 116, 8, 0)
  writeOctal(h, 124, 12, size)
  writeOctal(h, 136, 12, mtime)
  h.fill(0x20, 148, 156)
  h[156] = isDir ? 0x35 : 0x30
  writeField(h, 257, 6, 'ustar\0')
  writeField(h, 263, 2, '00')
  writeField(h, 345, 155, prefix)
  let sum = 0
  for (const byte of h) sum += byte
  writeField(h, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `)
  return h
}

export function buildTar(entries: readonly TarEntry[], mtime = 0): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const isDir = entry.name.endsWith('/')
    const data = isDir ? undefined : entry.data ?? new Uint8Array()
    parts.push(header(entry.name, data?.length ?? 0, isDir, mtime))
    if (data && data.length > 0) {
      parts.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
      const pad = (BLOCK - (data.length % BLOCK)) % BLOCK
      if (pad) parts.push(Buffer.alloc(pad))
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(parts)
}

export async function buildTarGz(entries: readonly TarEntry[], mtime = 0): Promise<Buffer> {
  return gzipAsync(buildTar(entries, mtime))
}

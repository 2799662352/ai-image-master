// @vitest-environment node
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import JSZip from 'jszip'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ protocol: { handle: vi.fn() } }))
vi.mock('../voskModelInfo', () => {
  const VOSK_MODEL = { id: 'test-model', url: 'https://example.test/test-model.zip', size: 0, sha256: '' }
  return { VOSK_MODEL, VOSK_MODEL_ARCHIVE: 'test-model.tar.gz' }
})

import { buildTar } from '../tarGz'
import { VOSK_MODEL } from '../voskModelInfo'
import { ensureVoskModel, zipToTarGz } from '../voskModel'
import { resolveVoiceModelRequest, voiceModelUrl } from '../voiceModelProtocol'

interface ParsedEntry {
  name: string
  type: string
  data: Buffer
}

function readField(block: Buffer, offset: number, length: number): string {
  const raw = block.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end < 0 ? length : end).toString('utf8')
}

function parseTar(tar: Buffer): ParsedEntry[] {
  const entries: ParsedEntry[] = []
  let offset = 0
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512)
    if (block.every((byte) => byte === 0)) break
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]
    expect(parseInt(readField(block, 148, 8).trim(), 8)).toBe(sum)
    expect(readField(block, 257, 6)).toBe('ustar')
    const prefix = readField(block, 345, 155)
    const short = readField(block, 0, 100)
    const size = parseInt(readField(block, 124, 12), 8)
    const data = tar.subarray(offset + 512, offset + 512 + size)
    entries.push({ name: prefix ? `${prefix}/${short}` : short, type: String.fromCharCode(block[156]), data })
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

async function modelZip(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) zip.file(name, content)
  return zip.generateAsync({ type: 'nodebuffer' })
}

function responseOf(bytes: Buffer, chunkSize = 7): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.subarray(i, i + chunkSize))
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'content-length': String(bytes.length) } })
}

describe('buildTar', () => {
  it('writes ustar headers that a standard reader can walk back', () => {
    const longDir = `model/${'d'.repeat(90)}/`
    const tar = buildTar([
      { name: 'model/' },
      { name: 'model/am/final.mdl', data: Buffer.from('weights') },
      { name: `${longDir}conf.txt`, data: Buffer.alloc(1300, 1) },
      { name: 'model/empty.txt' },
    ])
    expect(tar.length % 512).toBe(0)
    const entries = parseTar(tar)
    expect(entries.map((e) => [e.name, e.type])).toEqual([
      ['model/', '5'],
      ['model/am/final.mdl', '0'],
      [`${longDir}conf.txt`, '0'],
      ['model/empty.txt', '0'],
    ])
    expect(entries[1].data.toString()).toBe('weights')
    expect(entries[2].data.length).toBe(1300)
  })

  it('rejects a path that cannot fit name + prefix', () => {
    expect(() => buildTar([{ name: `${'x'.repeat(120)}.bin`, data: Buffer.from('1') }])).toThrow(/过长/)
  })
})

describe('zipToTarGz', () => {
  it('keeps the single top-level folder vosk-browser strips on extraction', async () => {
    const archive = await zipToTarGz(await modelZip({ 'm/am/final.mdl': 'A', 'm/conf/model.conf': 'B' }))
    const names = parseTar(gunzipSync(archive)).map((e) => e.name)
    expect(names).toEqual(expect.arrayContaining(['m/am/final.mdl', 'm/conf/model.conf']))
    expect(names.every((name) => name.startsWith('m/'))).toBe(true)
  })

  it('refuses archives with several roots or parent-directory paths', async () => {
    await expect(zipToTarGz(await modelZip({ 'a/x': '1', 'b/y': '2' }))).rejects.toThrow(/顶层目录/)
    await expect(zipToTarGz(await modelZip({ 'a/../../evil': '1' }))).rejects.toThrow()
  })
})

describe('ensureVoskModel', () => {
  let dir: string
  let zipBytes: Buffer

  beforeAll(async () => {
    zipBytes = await modelZip({ 'test-model/am/final.mdl': 'model-bytes', 'test-model/README': 'hi' })
  })

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-model-'))
    ;(VOSK_MODEL as { sha256: string }).sha256 = createHash('sha256').update(zipBytes).digest('hex')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('downloads, verifies, converts and then reuses the archive', async () => {
    const fetchImpl = vi.fn(async () => responseOf(zipBytes))
    const onProgress = vi.fn()
    const target = await ensureVoskModel({ dir, fetchImpl, onProgress })
    expect(target).toBe(path.join(dir, 'test-model.tar.gz'))
    const names = parseTar(gunzipSync(await fs.readFile(target))).map((e) => e.name)
    expect(names).toContain('test-model/am/final.mdl')
    expect(onProgress).toHaveBeenCalledWith({ phase: 'download', received: zipBytes.length, total: zipBytes.length })
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'convert' }))
    expect(await fs.readdir(dir)).toEqual(['test-model.tar.gz'])

    await ensureVoskModel({ dir, fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not keep anything when the checksum does not match', async () => {
    ;(VOSK_MODEL as { sha256: string }).sha256 = '0'.repeat(64)
    await expect(ensureVoskModel({ dir, fetchImpl: async () => responseOf(zipBytes) })).rejects.toThrow(/校验失败/)
    expect(await fs.readdir(dir)).toEqual([])
  })

  it('surfaces HTTP failures and lets the next call retry', async () => {
    await expect(
      ensureVoskModel({ dir, fetchImpl: async () => new Response('nope', { status: 503 }) }),
    ).rejects.toThrow(/HTTP 503/)
    await expect(ensureVoskModel({ dir, fetchImpl: async () => responseOf(zipBytes) })).resolves.toContain(
      'test-model.tar.gz',
    )
  })

  it('shares one download between concurrent callers', async () => {
    const fetchImpl = vi.fn(async () => responseOf(zipBytes))
    const [a, b] = await Promise.all([ensureVoskModel({ dir, fetchImpl }), ensureVoskModel({ dir, fetchImpl })])
    expect(a).toBe(b)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('resolveVoiceModelRequest', () => {
  const dir = path.join(os.tmpdir(), 'models')

  it('serves only whitelisted archives on the models host', () => {
    expect(resolveVoiceModelRequest(voiceModelUrl('test-model.tar.gz'), dir)).toBe(path.join(dir, 'test-model.tar.gz'))
    expect(resolveVoiceModelRequest('voice-model://models/other.tar.gz', dir)).toBeNull()
    expect(resolveVoiceModelRequest('voice-model://elsewhere/test-model.tar.gz', dir)).toBeNull()
    expect(resolveVoiceModelRequest('voice-model://models/..%2Ftest-model.tar.gz', dir)).toBeNull()
    expect(resolveVoiceModelRequest('local-file://models/test-model.tar.gz', dir)).toBeNull()
    expect(resolveVoiceModelRequest('not a url', dir)).toBeNull()
  })
})

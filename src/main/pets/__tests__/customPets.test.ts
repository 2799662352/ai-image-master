import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readImageSize, scanCustomPets } from '../customPets'

/** 最小的 VP8L 头:RIFF/WEBP/VP8L + 签名 0x2f + 14 位宽高。 */
function vp8lHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(22, 4)
  buf.write('WEBP', 8, 'ascii')
  buf.write('VP8L', 12, 'ascii')
  buf.writeUInt32LE(10, 16)
  buf[20] = 0x2f
  buf.writeUInt32LE(((width - 1) | ((height - 1) << 14) | (1 << 28)) >>> 0, 21)
  return buf
}

function vp8xHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30)
  buf.write('RIFF', 0, 'ascii')
  buf.write('WEBP', 8, 'ascii')
  buf.write('VP8X', 12, 'ascii')
  buf.writeUIntLE(width - 1, 24, 3)
  buf.writeUIntLE(height - 1, 27, 3)
  return buf
}

function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

describe('readImageSize', () => {
  it('reads VP8L / VP8X / PNG headers', () => {
    expect(readImageSize(vp8lHeader(1536, 2288))).toEqual({ width: 1536, height: 2288 })
    expect(readImageSize(vp8xHeader(1536, 1872))).toEqual({ width: 1536, height: 1872 })
    expect(readImageSize(pngHeader(1536, 1872))).toEqual({ width: 1536, height: 1872 })
    expect(readImageSize(Buffer.from('not an image at all, just some bytes'))).toBeNull()
  })

  it('reads the bundled Doro sheet as a V1 atlas', async () => {
    const sheet = path.resolve(__dirname, '../../../renderer/public/pets/doro/spritesheet.webp')
    const head = (await fs.readFile(sheet)).subarray(0, 32)
    expect(readImageSize(head)).toEqual({ width: 1536, height: 1872 })
  })
})

describe('scanCustomPets', () => {
  let dir: string

  async function addPet(folder: string, manifest: unknown, sheet?: Buffer, sheetName = 'spritesheet.webp') {
    const petDir = path.join(dir, folder)
    await fs.mkdir(petDir, { recursive: true })
    if (manifest !== undefined) {
      await fs.writeFile(
        path.join(petDir, 'pet.json'),
        typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
      )
    }
    if (sheet) await fs.writeFile(path.join(petDir, sheetName), sheet)
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'catimation-pets-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('returns an empty list when the pets folder does not exist', async () => {
    const missing = path.join(dir, 'nope')
    expect(await scanCustomPets(missing)).toEqual({ dir: missing, pets: [], skipped: [] })
  })

  it('loads V1 and V2 packs, keyed by folder name', async () => {
    await addPet(
      'greenbyte-miku',
      { id: 'greenbyte-miku', displayName: 'Greenbyte Miku', spritesheetPath: 'spritesheet.webp', spriteVersionNumber: 2 },
      vp8lHeader(1536, 2288),
    )
    await addPet('doro', { id: 'doro', displayName: 'My Doro' }, vp8lHeader(1536, 1872))

    const scan = await scanCustomPets(dir)
    expect(scan.skipped).toEqual([])
    expect(scan.pets).toEqual([
      {
        folder: 'greenbyte-miku',
        displayName: 'Greenbyte Miku',
        description: undefined,
        spriteVersion: 2,
        spritesheetPath: path.join(dir, 'greenbyte-miku', 'spritesheet.webp'),
      },
      {
        folder: 'doro',
        displayName: 'My Doro',
        description: undefined,
        spriteVersion: 1,
        spritesheetPath: path.join(dir, 'doro', 'spritesheet.webp'),
      },
    ])
  })

  it('accepts a UTF-8 BOM in pet.json', async () => {
    await addPet('bom', '\uFEFF{"displayName":"Bom"}', vp8lHeader(1536, 1872))
    const scan = await scanCustomPets(dir)
    expect(scan.pets.map((p) => p.displayName)).toEqual(['Bom'])
  })

  it('skips packs whose atlas size does not match the declared version', async () => {
    // 声明 V2 却是 9 行图集:按 11 行切会整张错位
    await addPet('wrong', { displayName: 'Wrong', spriteVersionNumber: 2 }, vp8lHeader(1536, 1872))
    const scan = await scanCustomPets(dir)
    expect(scan.pets).toEqual([])
    expect(scan.skipped).toEqual([{ folder: 'wrong', reason: 'V2 图集应为 1536x2288,实际 1536x1872' }])
  })

  it('skips missing manifests, bad JSON, unknown versions, missing sheets and path escapes', async () => {
    await addPet('no-manifest', undefined, vp8lHeader(1536, 1872))
    await addPet('bad-json', '{oops', vp8lHeader(1536, 1872))
    await addPet('v3', { spriteVersionNumber: 3 }, vp8lHeader(1536, 1872))
    await addPet('no-sheet', { displayName: 'No sheet' })
    await addPet('escape', { spritesheetPath: '../no-manifest/spritesheet.webp' })

    const scan = await scanCustomPets(dir)
    expect(scan.pets).toEqual([])
    const reasons = Object.fromEntries(scan.skipped.map((s) => [s.folder, s.reason]))
    expect(reasons['no-manifest']).toBe('缺少 pet.json')
    expect(reasons['bad-json']).toMatch(/^pet\.json 读不了/)
    expect(reasons.v3).toBe('不支持的 spriteVersionNumber:3')
    expect(reasons['no-sheet']).toBe('找不到图集 spritesheet.webp')
    expect(reasons.escape).toBe('spritesheetPath 指向宠物目录之外')
  })
})

/**
 * 用户自装宠物:扫描 `<CODEX_HOME>/pets/<folder>/`(和 Codex 桌面端同一个目录,
 * 社区宠物包的 README 都让用户放这里)。
 *
 * 契约(codexpet.xyz/spec,awesome-codex-pet):
 *   - `pet.json`:id / displayName / description / spritesheetPath,可选
 *     `spriteVersionNumber`(缺省 = 1);
 *   - 图集 8 列、单帧 192x208:V1 必须 1536x1872(9 行),V2 必须 1536x2288
 *     (11 行,第 9–10 行是 16 个视线方向)。
 *
 * 尺寸和声明版本对不上的包直接跳过:渲染层按行数切 background-size,
 * 行数错一行就是整张图纵向错位,不如不显示。
 */

import { promises as fs, type Dirent } from 'node:fs'
import path from 'node:path'

import type { CustomPetInfo, PetSpriteVersion } from '../../types/pets'

interface SkippedPet {
  folder: string
  reason: string
}

export interface CustomPetScan {
  dir: string
  pets: CustomPetInfo[]
  skipped: SkippedPet[]
}

export const PET_SHEET_WIDTH = 1536
export const PET_SHEET_HEIGHT_BY_VERSION: Record<PetSpriteVersion, number> = {
  1: 1872,
  2: 2288,
}

const MAX_MANIFEST_BYTES = 64 * 1024

/**
 * 只读文件头拿图片宽高。支持 WebP(VP8 / VP8L / VP8X)与 PNG;
 * 认不出的格式返回 null。
 */
export function readImageSize(head: Buffer): { width: number; height: number } | null {
  if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47) {
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
  }
  if (head.length < 30) return null
  if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WEBP') return null
  const chunk = head.toString('ascii', 12, 16)
  if (chunk === 'VP8X') {
    return { width: 1 + head.readUIntLE(24, 3), height: 1 + head.readUIntLE(27, 3) }
  }
  if (chunk === 'VP8L') {
    if (head[20] !== 0x2f) return null
    const bits = head.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8 ') {
    return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff }
  }
  return null
}

async function readHead(file: string, bytes: number): Promise<Buffer> {
  const handle = await fs.open(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

async function loadOne(petsDir: string, folder: string): Promise<CustomPetInfo | SkippedPet> {
  const petDir = path.join(petsDir, folder)
  let manifest: Record<string, unknown>
  try {
    const stat = await fs.stat(path.join(petDir, 'pet.json'))
    if (stat.size > MAX_MANIFEST_BYTES) return { folder, reason: 'pet.json 过大' }
    const raw = await fs.readFile(path.join(petDir, 'pet.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { folder, reason: 'pet.json 不是对象' }
    }
    manifest = parsed as Record<string, unknown>
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return { folder, reason: code === 'ENOENT' ? '缺少 pet.json' : `pet.json 读不了:${String(err)}` }
  }

  const version = manifest.spriteVersionNumber ?? 1
  if (version !== 1 && version !== 2) {
    return { folder, reason: `不支持的 spriteVersionNumber:${String(version)}` }
  }

  const sheetName = typeof manifest.spritesheetPath === 'string' ? manifest.spritesheetPath : 'spritesheet.webp'
  const sheetPath = path.resolve(petDir, sheetName)
  if (!isInside(petDir, sheetPath)) return { folder, reason: 'spritesheetPath 指向宠物目录之外' }

  let size: { width: number; height: number } | null
  try {
    size = readImageSize(await readHead(sheetPath, 32))
  } catch {
    return { folder, reason: `找不到图集 ${sheetName}` }
  }
  if (!size) return { folder, reason: '图集不是 WebP / PNG' }
  const expectedHeight = PET_SHEET_HEIGHT_BY_VERSION[version]
  if (size.width !== PET_SHEET_WIDTH || size.height !== expectedHeight) {
    return {
      folder,
      reason: `V${version} 图集应为 ${PET_SHEET_WIDTH}x${expectedHeight},实际 ${size.width}x${size.height}`,
    }
  }

  const displayName =
    typeof manifest.displayName === 'string' && manifest.displayName.trim()
      ? manifest.displayName.trim()
      : folder
  const description = typeof manifest.description === 'string' ? manifest.description : undefined
  return { folder, displayName, description, spriteVersion: version, spritesheetPath: sheetPath }
}

export async function scanCustomPets(petsDir: string): Promise<CustomPetScan> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(petsDir, { withFileTypes: true })
  } catch {
    return { dir: petsDir, pets: [], skipped: [] }
  }
  const folders = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
  const results = await Promise.all(folders.map((folder) => loadOne(petsDir, folder)))
  const pets: CustomPetInfo[] = []
  const skipped: SkippedPet[] = []
  for (const r of results) {
    if ('reason' in r) skipped.push(r)
    else pets.push(r)
  }
  pets.sort((a, b) => a.displayName.localeCompare(b.displayName))
  return { dir: petsDir, pets, skipped }
}

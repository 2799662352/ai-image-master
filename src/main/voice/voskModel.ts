// src/main/voice/voskModel.ts
/**
 * Vosk 中文小模型的获取与缓存(与 Shinsekai 内置的 VoskAdapter 用同一个模型)。
 *
 * 官方只发 zip,vosk-browser 只认「单个顶层目录」的 tar.gz(Worker 解包时剥掉第一层),
 * 所以首次使用时下载 → 校验 sha256 → 转 tar.gz → 原子写到 userData。之后渲染层的
 * Worker 解出来的模型缓存在 IndexedDB 里,这个文件只在缓存被清空后才会再被读。
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import type { VoiceModelProgress } from '../../types/voice'
import { buildTarGz, type TarEntry } from './tarGz'
import { VOSK_MODEL, VOSK_MODEL_ARCHIVE } from './voskModelInfo'

export type ModelFetch = (url: string) => Promise<Response>

export async function zipToTarGz(zipBytes: Uint8Array): Promise<Buffer> {
  const zip = await JSZip.loadAsync(zipBytes)
  const names = Object.keys(zip.files).sort()
  const roots = new Set(names.map((name) => name.split('/')[0]))
  if (roots.size !== 1) throw new Error('识别模型包应只有一个顶层目录')
  const entries: TarEntry[] = []
  for (const name of names) {
    if (name.startsWith('/') || name.split('/').includes('..')) {
      throw new Error(`识别模型包里有非法路径: ${name}`)
    }
    const file = zip.files[name]
    if (file.dir) entries.push({ name: name.endsWith('/') ? name : `${name}/` })
    else entries.push({ name, data: await file.async('uint8array') })
  }
  return buildTarGz(entries)
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile()
  } catch {
    return false
  }
}

async function download(
  fetchImpl: ModelFetch,
  onProgress?: (p: VoiceModelProgress) => void,
): Promise<Buffer> {
  const response = await fetchImpl(VOSK_MODEL.url)
  if (!response.ok || !response.body) {
    throw new Error(`识别模型下载失败(HTTP ${response.status})`)
  }
  const total = Number(response.headers.get('content-length')) || VOSK_MODEL.size
  const hash = createHash('sha256')
  const chunks: Buffer[] = []
  let received = 0
  let reported = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    hash.update(chunk)
    chunks.push(chunk)
    received += chunk.length
    if (received - reported >= 512 * 1024 || received === total) {
      reported = received
      onProgress?.({ phase: 'download', received, total })
    }
  }
  if (hash.digest('hex') !== VOSK_MODEL.sha256) {
    throw new Error('识别模型校验失败(下载不完整或被篡改),请重试')
  }
  return Buffer.concat(chunks)
}

async function ensure(
  dir: string,
  fetchImpl: ModelFetch,
  onProgress?: (p: VoiceModelProgress) => void,
): Promise<string> {
  const target = path.join(dir, VOSK_MODEL_ARCHIVE)
  if (await isFile(target)) return target
  await fs.mkdir(dir, { recursive: true })
  const zipBytes = await download(fetchImpl, onProgress)
  onProgress?.({ phase: 'convert', received: zipBytes.length, total: zipBytes.length })
  const archive = await zipToTarGz(zipBytes)
  const part = `${target}.part`
  await fs.writeFile(part, archive)
  await fs.rename(part, target)
  return target
}

let inflight: Promise<string> | null = null

/** 并发调用共享同一次下载;失败后下一次调用重新开始。 */
export function ensureVoskModel(options: {
  dir: string
  fetchImpl: ModelFetch
  onProgress?: (p: VoiceModelProgress) => void
}): Promise<string> {
  if (!inflight) {
    inflight = ensure(options.dir, options.fetchImpl, options.onProgress).finally(() => {
      inflight = null
    })
  }
  return inflight
}

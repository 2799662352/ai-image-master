// src/main/voice/voiceModelProtocol.ts
/**
 * `voice-model://models/<archive>`:只把识别模型包交给 vosk-browser 的 Worker。
 *
 * 不能走 `local-file://` —— 它的 frame guard 刻意拦掉 Worker 发出的请求(那是
 * corsEnabled 下唯一的信任边界)。vosk-browser 又按模型 URL 字符串给 IndexedDB
 * 缓存起目录名,URL 必须每次启动都一样,`blob:` 也不行。这个 scheme 只认白名单里
 * 的文件名,暴露面就是一个公开的模型包。
 */

import { protocol, type CustomScheme } from 'electron'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { VOSK_MODEL_ARCHIVE } from './voskModelInfo'

export const VOICE_MODEL_SCHEME = 'voice-model'
const HOST = 'models'
const SERVABLE = new Set([VOSK_MODEL_ARCHIVE])

export const VOICE_MODEL_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: VOICE_MODEL_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}

export function voiceModelUrl(archive: string): string {
  return `${VOICE_MODEL_SCHEME}://${HOST}/${archive}`
}

/** 请求 URL → 磁盘路径;不在白名单里返回 null。 */
export function resolveVoiceModelRequest(url: string, dir: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${VOICE_MODEL_SCHEME}:` || parsed.hostname !== HOST) return null
  const name = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
  return SERVABLE.has(name) ? path.join(dir, name) : null
}

export function installVoiceModelProtocol(modelsDir: () => string): void {
  protocol.handle(VOICE_MODEL_SCHEME, async (request) => {
    const file = resolveVoiceModelRequest(request.url, modelsDir())
    if (!file) return new Response('not found', { status: 404 })
    let size: number
    try {
      size = (await fs.stat(file)).size
    } catch {
      return new Response('not found', { status: 404 })
    }
    const body = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Length': String(size),
        'Access-Control-Allow-Origin': '*',
      },
    })
  })
}

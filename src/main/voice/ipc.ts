// src/main/voice/ipc.ts

import { app, ipcMain, net, type WebContents } from 'electron'
import path from 'node:path'
import type { VoiceEnsureAsrModelResult, VoiceRealtimeOpenResult } from '../../types/voice'
import { resolveGatewayOrigin } from '../services/auth/gatewayHeaderInjector'
import { gatewayPlatformHeaders, getActivePoolToken } from '../services/auth/gatewayToken'
import { notePlatformSpend } from '../services/auth/platformSpend'
import { ensureVoskModel } from './voskModel'
import { VOSK_MODEL_ARCHIVE } from './voskModelInfo'
import { installVoiceModelProtocol, voiceModelUrl } from './voiceModelProtocol'
import { RealtimeRelay } from './realtimeRelay'

export const VOICE_IPC = {
  ENSURE_ASR_MODEL: 'voice:ensure-asr-model',
  ASR_MODEL_PROGRESS: 'voice:asr-model-progress',
  REALTIME_OPEN: 'voice:realtime-open',
  REALTIME_SEND: 'voice:realtime-send',
  REALTIME_CLOSE: 'voice:realtime-close',
  REALTIME_MESSAGE: 'voice:realtime-message',
} as const

export function voiceModelsDir(): string {
  return path.join(app.getPath('userData'), 'voice', 'models')
}

/** 需在 app ready 之后调用(protocol.handle 的要求)。 */
export function installVoiceProtocol(): void {
  installVoiceModelProtocol(voiceModelsDir)
}

const relay = new RealtimeRelay({
  gatewayOrigin: resolveGatewayOrigin,
  platformHeaders: () => {
    const token = getActivePoolToken()
    return token ? gatewayPlatformHeaders(token) : null
  },
  onSpend: notePlatformSpend,
})

const watchedOwners = new Set<number>()

/** 页面销毁或整页刷新后,它开过的连接没人接收了,一并关掉。 */
function watchOwner(sender: WebContents): void {
  const owner = sender.id
  if (watchedOwners.has(owner)) return
  watchedOwners.add(owner)
  sender.on('did-navigate', () => relay.closeOwner(owner))
  sender.once('destroyed', () => {
    watchedOwners.delete(owner)
    relay.closeOwner(owner)
  })
}

export function registerVoiceIpc(): void {
  ipcMain.removeHandler(VOICE_IPC.ENSURE_ASR_MODEL)
  ipcMain.handle(VOICE_IPC.ENSURE_ASR_MODEL, async (event): Promise<VoiceEnsureAsrModelResult> => {
    try {
      await ensureVoskModel({
        dir: voiceModelsDir(),
        fetchImpl: (url) => net.fetch(url),
        onProgress: (progress) => {
          if (!event.sender.isDestroyed()) event.sender.send(VOICE_IPC.ASR_MODEL_PROGRESS, progress)
        },
      })
      return { ok: true, url: voiceModelUrl(VOSK_MODEL_ARCHIVE) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.removeHandler(VOICE_IPC.REALTIME_OPEN)
  ipcMain.handle(VOICE_IPC.REALTIME_OPEN, async (event, model: unknown): Promise<VoiceRealtimeOpenResult> => {
    const sender = event.sender
    try {
      watchOwner(sender)
      const id = await relay.open(sender.id, String(model), (message) => {
        if (!sender.isDestroyed()) sender.send(VOICE_IPC.REALTIME_MESSAGE, message)
      })
      return { ok: true, id }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.removeAllListeners(VOICE_IPC.REALTIME_SEND)
  ipcMain.on(VOICE_IPC.REALTIME_SEND, (event, id: unknown, data: unknown) => {
    if (typeof id === 'string' && typeof data === 'string') relay.send(event.sender.id, id, data)
  })

  ipcMain.removeAllListeners(VOICE_IPC.REALTIME_CLOSE)
  ipcMain.on(VOICE_IPC.REALTIME_CLOSE, (event, id: unknown) => {
    if (typeof id === 'string') relay.close(event.sender.id, id)
  })
}

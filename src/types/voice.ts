// src/types/voice.ts
/** 语音输入 / 朗读的主进程 ↔ 渲染层契约。 */

export interface VoiceModelProgress {
  phase: 'download' | 'convert'
  received: number
  total: number
}

export type VoiceEnsureAsrModelResult =
  | { ok: true; url: string }
  | { ok: false; error: string }

/** 走网关 `/v1/realtime` 的千问实时语音模型。主进程只为这张表里的模型开连接。 */
export type VoiceRealtimeModel = 'qwen3-asr-flash-realtime' | 'qwen3-tts-flash-realtime'

export type VoiceRealtimeOpenResult =
  | { ok: true; id: string }
  | { ok: false; error: string }

/** 主进程转发来的一条实时连接消息:上游的 JSON 事件原文,或连接已关闭。 */
export type VoiceRealtimeMessage =
  | { id: string; kind: 'event'; data: string }
  | { id: string; kind: 'closed'; code: number; reason: string }

export interface VoiceApi {
  /** 确保识别模型在本地(首次会下载),返回给 vosk-browser 用的固定 URL。 */
  ensureAsrModel: () => Promise<VoiceEnsureAsrModelResult>
  onAsrModelProgress: (cb: (progress: VoiceModelProgress) => void) => () => void
  /** 以平台余额开一条到网关的实时连接;握手成功才返回 id。 */
  realtimeOpen: (model: VoiceRealtimeModel) => Promise<VoiceRealtimeOpenResult>
  /** 发一条 JSON 事件(已序列化)。连接不在或已关时静默丢弃。 */
  realtimeSend: (id: string, data: string) => void
  realtimeClose: (id: string) => void
  onRealtimeMessage: (cb: (message: VoiceRealtimeMessage) => void) => () => void
}

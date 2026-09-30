// src/main/voice/voskModelInfo.ts
/** 与 Shinsekai 内置 VoskAdapter 相同的中文小模型。sha256 是官方 zip 实测值。 */
export const VOSK_MODEL = {
  id: 'vosk-model-small-cn-0.22',
  url: 'https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip',
  size: 43_898_754,
  sha256: '3af8b0e7e0f835ae9d414ce5df580237a3cfb08d586c9fbbb0f7ff29ad5b14ba',
} as const

export const VOSK_MODEL_ARCHIVE = `${VOSK_MODEL.id}.tar.gz`

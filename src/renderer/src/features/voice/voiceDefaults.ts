// src/renderer/src/features/voice/voiceDefaults.ts
/** 只放常量:voiceStore 被宠物等轻量组件引用,不能连带拉进识别/朗读引擎。 */

export const QWEN_ASR_PROVIDER = 'qwen_realtime'
export const VOSK_ASR_PROVIDER = 'vosk'
export const DEFAULT_ASR_PROVIDER = QWEN_ASR_PROVIDER

export const QWEN_TTS_PROVIDER = 'qwen-realtime'
export const SEED_AUDIO_TTS_PROVIDER = 'seed-audio'
export const DEFAULT_TTS_PROVIDER = QWEN_TTS_PROVIDER

export const DEFAULT_QWEN_VOICE = 'Cherry'
export const DEFAULT_VOICE_PROMPT = '一位年轻女性,用自然亲切的语气、适中的语速'

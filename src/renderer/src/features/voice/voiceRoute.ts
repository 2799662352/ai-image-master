// src/renderer/src/features/voice/voiceRoute.ts
/**
 * 口型分发(对应 Shinsekai `character-visual/voiceRoute.ts`):
 * 播放器按角色名报口型开合,这里转给已绑定、且会动嘴的形象。
 */

/** 宠物在 voiceRoute 上的名字;朗读都以它的口型播放。 */
export const PET_VOICE_NAME = 'pet'

export interface AvatarCapabilities {
  mouth: boolean
}

export interface AvatarVoiceTarget {
  capabilities: AvatarCapabilities
  setMouthOpen(value: number): void
}

const targets = new Map<string, Set<AvatarVoiceTarget>>()

export function bindAvatarVoice(name: string, session: AvatarVoiceTarget): () => void {
  if (!name || !session.capabilities.mouth) return () => {}
  const instances = targets.get(name) ?? new Set<AvatarVoiceTarget>()
  instances.add(session)
  targets.set(name, instances)
  return () => {
    session.setMouthOpen(0)
    instances.delete(session)
    if (!instances.size) targets.delete(name)
  }
}

export function routeAvatarVoice(name: string, value: number): void {
  for (const session of targets.get(name) ?? []) session.setMouthOpen(value)
}

// src/renderer/src/features/agent-chat/pets/petAnimations.ts
/**
 * Codex 官方宠物 spritesheet 契约(V1)。
 *
 * 来源:openai/codex `/pets`(TUI PR #21206)与社区文档
 * (awesome-codex-pets docs/pet-contract.md、petdex.crafter.run):
 *   - WebP 图集 1536x1872,8 列 x 9 行,单帧 192x208,透明底;
 *   - 每行一个动画状态,未用格子全透明。
 *
 * 我们的宠物包(public/pets/<id>/)直接取自 petdex 社区市场,和
 * `~/.codex/pets/` 的官方自定义宠物是同一份格式 —— 用户以后想加新宠物,
 * 丢一个同契约文件夹进 public/pets/ 并在 BUILT_IN_PETS 登记即可。
 */

export const PET_FRAME_WIDTH = 192
export const PET_FRAME_HEIGHT = 208
export const PET_SHEET_COLS = 8
export const PET_SHEET_ROWS = 9

/** 官方 9 行动画表:行号 + 该行实际使用的帧数(列 0..frames-1)。 */
export type PetAnimationState =
  | 'idle'
  | 'running-right'
  | 'running-left'
  | 'waving'
  | 'jumping'
  | 'failed'
  | 'waiting'
  | 'running'
  | 'review'

export const PET_ANIMATIONS: Record<PetAnimationState, { row: number; frames: number }> = {
  idle: { row: 0, frames: 6 },
  'running-right': { row: 1, frames: 8 },
  'running-left': { row: 2, frames: 8 },
  waving: { row: 3, frames: 4 },
  jumping: { row: 4, frames: 5 },
  failed: { row: 5, frames: 8 },
  waiting: { row: 6, frames: 6 },
  running: { row: 7, frames: 6 },
  review: { row: 8, frames: 6 },
}

/** 动画帧率(官方 App 观感约 8fps)。 */
export const PET_FPS = 8

export interface BuiltInPet {
  id: string
  displayName: string
  /** 相对 renderer 根的路径(public/ 静态资源,dev 与打包后一致)。 */
  spritesheetPath: string
}

/** 预装宠物(petdex 社区包,官方契约格式)。 */
export const BUILT_IN_PETS: BuiltInPet[] = [
  { id: 'gugugaga', displayName: '咕咕嘎嘎', spritesheetPath: './pets/gugugaga/spritesheet.webp' },
  { id: 'doro', displayName: 'Doro', spritesheetPath: './pets/doro/spritesheet.webp' },
]

export const PET_STORAGE_KEY = 'catimation.agentPet'
export const PET_POSITION_STORAGE_KEY = 'catimation.agentPetPos'

/** 拖拽偏移(相对默认停靠点,px)。 */
export interface PetOffset {
  x: number
  y: number
}

export function loadPetOffset(): PetOffset {
  try {
    const raw = localStorage.getItem(PET_POSITION_STORAGE_KEY)
    if (!raw) return { x: 0, y: 0 }
    const parsed = JSON.parse(raw) as Partial<PetOffset>
    const x = typeof parsed.x === 'number' && Number.isFinite(parsed.x) ? parsed.x : 0
    const y = typeof parsed.y === 'number' && Number.isFinite(parsed.y) ? parsed.y : 0
    return { x, y }
  } catch {
    return { x: 0, y: 0 }
  }
}

export function savePetOffset(offset: PetOffset): void {
  try {
    localStorage.setItem(PET_POSITION_STORAGE_KEY, JSON.stringify(offset))
  } catch {
    /* incognito / quota — 位置不持久化也不影响使用 */
  }
}

export function loadPetSelection(): string | null {
  try {
    const v = localStorage.getItem(PET_STORAGE_KEY)
    if (v === 'off' || v == null) return null
    return BUILT_IN_PETS.some((p) => p.id === v) ? v : null
  } catch {
    return null
  }
}

export function savePetSelection(id: string | null): void {
  try {
    localStorage.setItem(PET_STORAGE_KEY, id ?? 'off')
  } catch {
    /* incognito / quota — 选择不持久化也不影响使用 */
  }
}

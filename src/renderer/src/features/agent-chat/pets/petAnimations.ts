// src/renderer/src/features/agent-chat/pets/petAnimations.ts
/**
 * Codex 官方宠物 spritesheet 契约(V1 / V2)。
 *
 * 来源:openai/codex `/pets`(TUI PR #21206)与社区文档
 * (codexpet.xyz/spec、awesome-codex-pet、petdex.crafter.run):
 *   - 8 列,单帧 192x208,透明底;每行一个动画状态,未用格子全透明;
 *   - V1:1536x1872,9 行;
 *   - V2(pet.json `spriteVersionNumber: 2`):1536x2288,11 行 —— 前 9 行
 *     与 V1 相同,第 9–10 行是 16 个视线方向(从正上方 0° 起顺时针,每格 22.5°)。
 *
 * 内置宠物(public/pets/<id>/)取自 petdex 社区市场;用户自装的宠物放在
 * `<CODEX_HOME>/pets/<folder>/`,由主进程扫描(src/main/pets/),和 Codex
 * 桌面端读的是同一个目录。
 */

export const PET_FRAME_WIDTH = 192
export const PET_FRAME_HEIGHT = 208
export const PET_SHEET_COLS = 8

export type PetSpriteVersion = 1 | 2

export const PET_SHEET_ROWS_BY_VERSION: Record<PetSpriteVersion, number> = { 1: 9, 2: 11 }

/** V2 视线方向:16 格,占第 9、10 行。 */
export const PET_LOOK_FIRST_ROW = 9
export const PET_LOOK_DIRECTIONS = 16

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

export interface PetDefinition {
  id: string
  displayName: string
  /** 可直接放进 CSS `url()` 的地址:内置宠物是相对 renderer 根的路径,自装宠物是 local-file URL。 */
  spritesheetPath: string
  spriteVersion: PetSpriteVersion
  /**
   * 每行实际帧数(按行号)。内置宠物和推荐帧数不一致时写在这里:打包后内置
   * 图集走 `file://`,读不了像素,没法像自装宠物那样现场识别。
   */
  frameCounts?: readonly number[]
  /** 来自 `<CODEX_HOME>/pets` 的用户自装宠物。 */
  custom?: boolean
}

/** Pixel Miku(LuminZA/pixel-miku-pets)实测帧数:idle 7 帧,其余与推荐一致。 */
const PIXEL_MIKU_FRAME_COUNTS = [7, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8] as const

/**
 * 预装宠物:咕咕嘎嘎 / Doro 来自 petdex 社区包;Pixel Miku 经作者同意随客户端
 * 分发,署名与版权声明见各自目录下的 RIGHTS.md(初音未来角色版权归
 * Crypton Future Media, INC.,依 PCL)。
 */
export const BUILT_IN_PETS: PetDefinition[] = [
  {
    id: 'gugugaga',
    displayName: '咕咕嘎嘎',
    spritesheetPath: './pets/gugugaga/spritesheet.webp',
    spriteVersion: 1,
  },
  { id: 'doro', displayName: 'Doro', spritesheetPath: './pets/doro/spritesheet.webp', spriteVersion: 1 },
  ...(['greenbyte', 'pinkbyte', 'bluebyte'] as const).map((color) => ({
    id: `${color}-miku`,
    displayName: `${color[0].toUpperCase()}${color.slice(1)} Miku`,
    spritesheetPath: `./pets/${color}-miku/spritesheet.webp`,
    spriteVersion: 2 as const,
    frameCounts: PIXEL_MIKU_FRAME_COUNTS,
  })),
]

/** 自装宠物的 id 前缀:文件夹名可能和内置宠物撞名。 */
export const CUSTOM_PET_ID_PREFIX = 'custom:'

export interface PetLookFrame {
  row: number
  col: number
}

/**
 * 屏幕坐标系向量(x 向右、y 向下)→ V2 视线格。0° 在正上方,顺时针。
 * 零向量没有方向,返回 null。
 */
export function lookFrameForVector(dx: number, dy: number): PetLookFrame | null {
  if (dx === 0 && dy === 0) return null
  const degrees = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360
  const index = Math.round(degrees / (360 / PET_LOOK_DIRECTIONS)) % PET_LOOK_DIRECTIONS
  return {
    row: PET_LOOK_FIRST_ROW + Math.floor(index / PET_SHEET_COLS),
    col: index % PET_SHEET_COLS,
  }
}

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
    // 自装宠物要等主进程扫描完才知道还在不在,这里先原样保留。
    if (v.startsWith(CUSTOM_PET_ID_PREFIX) && v.length > CUSTOM_PET_ID_PREFIX.length) return v
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

/** 主进程 `pets:*` IPC 与渲染层共用的契约(实现见 src/main/pets/)。 */

export type PetSpriteVersion = 1 | 2

export interface CustomPetInfo {
  folder: string
  displayName: string
  description?: string
  spriteVersion: PetSpriteVersion
  /** 图集的绝对路径(渲染层自己转 local-file URL)。 */
  spritesheetPath: string
}

export type PetsListCustomResult =
  | {
      ok: true
      dir: string
      pets: CustomPetInfo[]
      skipped: { folder: string; reason: string }[]
    }
  | { ok: false; error: string }

export interface PetsApi {
  listCustom: () => Promise<PetsListCustomResult>
  openFolder: () => Promise<{ ok: boolean; error?: string }>
}

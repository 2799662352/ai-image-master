// src/renderer/src/features/agent-chat/pets/petStore.ts
/**
 * 宠物选择的共享状态。官方 Codex 的入口是 `/pets` 斜杠命令(TUI PR #21206)
 * 与设置页,没有独立按钮 —— 所以 composer(MentionInput)需要一条到
 * PetOverlay 的通道来打开选择器。用一个极小的 zustand store 承载:
 *   - petId:当前宠物(null = 关闭),持久化到 localStorage;
 *   - pickerOpen:`/pets` 选择器是否打开;
 *   - customPets:`<CODEX_HOME>/pets` 里扫到的自装宠物(主进程 `pets:list-custom`)。
 */

import { create } from 'zustand'
import { toRenderableUri } from '../../file-explorer/uri'
import {
  BUILT_IN_PETS,
  CUSTOM_PET_ID_PREFIX,
  loadPetSelection,
  savePetSelection,
  type PetDefinition,
} from './petAnimations'

interface PetStore {
  petId: string | null
  pickerOpen: boolean
  customPets: PetDefinition[]
  customPetsDir: string | null
  customPetsLoaded: boolean
  selectPet: (id: string | null) => void
  openPicker: () => void
  closePicker: () => void
  refreshCustomPets: () => Promise<void>
}

export const usePetStore = create<PetStore>((set) => ({
  petId: loadPetSelection(),
  pickerOpen: false,
  customPets: [],
  customPetsDir: null,
  customPetsLoaded: false,
  selectPet: (id) => {
    savePetSelection(id)
    set({ petId: id, pickerOpen: false })
  },
  openPicker: () => set({ pickerOpen: true }),
  closePicker: () => set({ pickerOpen: false }),
  refreshCustomPets: async () => {
    const api = window.electronAPI?.pets
    if (!api) {
      set({ customPetsLoaded: true })
      return
    }
    const result = await api.listCustom().catch(() => null)
    if (!result || !result.ok) {
      set({ customPetsLoaded: true })
      return
    }
    set({
      customPetsLoaded: true,
      customPetsDir: result.dir,
      customPets: result.pets.map((p) => ({
        id: CUSTOM_PET_ID_PREFIX + p.folder,
        displayName: p.displayName,
        spritesheetPath: toRenderableUri(p.spritesheetPath),
        spriteVersion: p.spriteVersion,
        custom: true,
      })),
    })
  },
}))

export function allPets(customPets: PetDefinition[]): PetDefinition[] {
  return [...BUILT_IN_PETS, ...customPets]
}

/** 当前选中的宠物;自装宠物还没扫描完或已被删掉时为 undefined。 */
export function useSelectedPet(): PetDefinition | undefined {
  const petId = usePetStore((s) => s.petId)
  const customPets = usePetStore((s) => s.customPets)
  if (!petId) return undefined
  return allPets(customPets).find((p) => p.id === petId)
}

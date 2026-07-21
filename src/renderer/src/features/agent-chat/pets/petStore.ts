// src/renderer/src/features/agent-chat/pets/petStore.ts
/**
 * 宠物选择的共享状态。官方 Codex 的入口是 `/pets` 斜杠命令(TUI PR #21206)
 * 与设置页,没有独立按钮 —— 所以 composer(MentionInput)需要一条到
 * PetOverlay 的通道来打开选择器。用一个极小的 zustand store 承载:
 *   - petId:当前宠物(null = 关闭),持久化到 localStorage;
 *   - pickerOpen:`/pets` 选择器是否打开。
 */

import { create } from 'zustand'
import { loadPetSelection, savePetSelection } from './petAnimations'

interface PetStore {
  petId: string | null
  pickerOpen: boolean
  selectPet: (id: string | null) => void
  openPicker: () => void
  closePicker: () => void
}

export const usePetStore = create<PetStore>((set) => ({
  petId: loadPetSelection(),
  pickerOpen: false,
  selectPet: (id) => {
    savePetSelection(id)
    set({ petId: id, pickerOpen: false })
  },
  openPicker: () => set({ pickerOpen: true }),
  closePicker: () => set({ pickerOpen: false }),
}))

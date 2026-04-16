import { create } from 'zustand'

export interface DialogConfig {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  onConfirm?: () => void
  onCancel?: () => void
  type?: 'confirm' | 'alert' | 'prompt'
}

interface DialogState {
  isOpen: boolean
  config: DialogConfig | null
  openDialog: (config: DialogConfig) => void
  closeDialog: () => void
  confirm: () => void
}

export const useDialogStore = create<DialogState>((set, get) => ({
  isOpen: false,
  config: null,
  openDialog: (config) => set({ isOpen: true, config }),
  closeDialog: () => {
    get().config?.onCancel?.()
    set({ isOpen: false, config: null })
  },
  confirm: () => {
    get().config?.onConfirm?.()
    set({ isOpen: false, config: null })
  },
}))

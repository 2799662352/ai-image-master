import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface UIPrefsState {
  imageEditorToolbar: { enabled: boolean }
  setImageEditorToolbar: (enabled: boolean) => void
}

export const useUIPrefsStore = create<UIPrefsState>()(
  persist(
    (set) => ({
      imageEditorToolbar: { enabled: true },
      setImageEditorToolbar: (enabled) =>
        set({ imageEditorToolbar: { enabled } }),
    }),
    {
      name: 'ui-prefs',
      partialize: (state) => ({ imageEditorToolbar: state.imageEditorToolbar }),
      version: 1,
    },
  ),
)

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface TemplateStoreState {
  selections: Record<string, string | null>
  getSelection: (context: string) => string | null
  setSelection: (context: string, key: string | null) => void
}

export const useTemplateStore = create<TemplateStoreState>()(
  persist(
    (set, get) => ({
      selections: {},
      getSelection: (context) => get().selections[context] ?? null,
      setSelection: (context, key) =>
        set((state) => ({
          selections: { ...state.selections, [context]: key },
        })),
    }),
    { name: 'template-selections.v1' },
  ),
)

import { create } from 'zustand'
import type { Template, TemplateActions } from '../hooks/useTemplates'

export interface TemplatesState {
  templates: Template[]
  searchQuery: string
  activeCategory: string

  loadTemplates: (templates: TemplateActions) => void
  setSearchQuery: (q: string) => void
  setActiveCategory: (cat: string) => void
}

export const initialState = {
  templates: [] as Template[],
  searchQuery: '',
  activeCategory: 'all',
}

export const useTemplatesStore = create<TemplatesState>((set) => ({
  ...initialState,

  loadTemplates: (templates) => {
    set({ templates: templates.getAll() })
  },

  setSearchQuery: (q) => set({ searchQuery: q }),
  setActiveCategory: (cat) => set({ activeCategory: cat }),
}))

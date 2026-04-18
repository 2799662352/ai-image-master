const STORAGE_KEY = 'prompt_templates'

export interface Template {
  id: string
  name: string
  prompt: string
  category: string
  tags?: string[]
}

export interface TemplateActions {
  getAll(): Template[]
}

export function useTemplates(): TemplateActions {
  return {
    getAll(): Template[] {
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    },
  }
}

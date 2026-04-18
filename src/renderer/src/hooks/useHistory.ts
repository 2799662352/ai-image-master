const STORAGE_KEY = 'image_history'

export interface HistoryItem {
  id: number
  type: string
  prompt: string
  urls: string[]
  timestamp: string
  model?: string
}

export interface HistoryActions {
  getAll(): HistoryItem[]
  remove(id: number): boolean
  add(item: Omit<HistoryItem, 'id'>): HistoryItem
  clear(): void
}

function readItems(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeItems(items: HistoryItem[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
}

export function useHistory(): HistoryActions {
  return {
    getAll(): HistoryItem[] {
      return readItems()
    },

    add(item: Omit<HistoryItem, 'id'>): HistoryItem {
      const items = readItems()
      const maxId = items.reduce((max, i) => Math.max(max, i.id), 0)
      const newItem: HistoryItem = { ...item, id: maxId + 1 }
      writeItems([...items, newItem])
      return newItem
    },

    remove(id: number): boolean {
      const items = readItems()
      const filtered = items.filter((i) => i.id !== id)
      if (filtered.length === items.length) return false
      writeItems(filtered)
      return true
    },

    clear(): void {
      writeItems([])
    },
  }
}

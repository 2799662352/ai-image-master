import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useHistoryStore, initialState } from '../useHistoryStore'
import type { HistoryActions, HistoryItem } from '../../hooks/useHistory'

function createMockHistory(overrides: Partial<HistoryActions> = {}): HistoryActions {
  return {
    getAll: vi.fn().mockReturnValue([]),
    remove: vi.fn().mockReturnValue(true),
    add: vi.fn().mockImplementation((item) => ({ ...item, id: 1 })),
    clear: vi.fn(),
    ...overrides,
  }
}

const sampleItems: HistoryItem[] = [
  { id: 1, type: 'generate', prompt: 'cat', urls: ['http://cat.jpg'], timestamp: '2025-01-01' },
  { id: 2, type: 'generate', prompt: 'dog', urls: ['http://dog.jpg'], timestamp: '2025-01-02' },
]

describe('useHistoryStore', () => {
  beforeEach(() => {
    useHistoryStore.setState({ ...initialState })
  })

  it('has correct initial state', () => {
    const state = useHistoryStore.getState()
    expect(state.items).toEqual([])
    expect(state.searchQuery).toBe('')
    expect(state.error).toBeNull()
  })

  it('setSearchQuery updates searchQuery', () => {
    useHistoryStore.getState().setSearchQuery('cat')
    expect(useHistoryStore.getState().searchQuery).toBe('cat')
  })

  describe('loadHistory', () => {
    it('loads items from history actions', () => {
      const history = createMockHistory({
        getAll: vi.fn().mockReturnValue(sampleItems),
      })

      useHistoryStore.getState().loadHistory(history)

      const state = useHistoryStore.getState()
      expect(state.items).toEqual(sampleItems)
      expect(state.error).toBeNull()
    })

    it('sets error on exception', () => {
      const history = createMockHistory({
        getAll: vi.fn().mockImplementation(() => {
          throw new Error('storage corrupt')
        }),
      })

      useHistoryStore.getState().loadHistory(history)

      expect(useHistoryStore.getState().error).toBe('storage corrupt')
    })
  })

  describe('deleteItem', () => {
    it('removes item from state and calls history.remove', () => {
      useHistoryStore.setState({ items: [...sampleItems] })
      const history = createMockHistory()

      useHistoryStore.getState().deleteItem(1, history)

      expect(history.remove).toHaveBeenCalledWith(1)
      const items = useHistoryStore.getState().items
      expect(items).toHaveLength(1)
      expect(items[0].id).toBe(2)
      expect(useHistoryStore.getState().error).toBeNull()
    })

    it('sets error when history.remove throws', () => {
      useHistoryStore.setState({ items: [...sampleItems] })
      const history = createMockHistory({
        remove: vi.fn().mockImplementation(() => {
          throw new Error('delete failed')
        }),
      })

      useHistoryStore.getState().deleteItem(1, history)

      expect(useHistoryStore.getState().error).toBe('delete failed')
    })
  })
})

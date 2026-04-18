import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useHistory } from '../useHistory'
import type { HistoryItem } from '../useHistory'

const STORAGE_KEY = 'image_history'

describe('useHistory', () => {
  let mockStorage: Record<string, string>

  beforeEach(() => {
    mockStorage = {}
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => mockStorage[key] ?? null)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, val) => { mockStorage[key] = val })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((key) => { delete mockStorage[key] })
  })

  it('getAll returns empty array when no data', () => {
    const history = useHistory()
    expect(history.getAll()).toEqual([])
  })

  it('getAll returns parsed items from localStorage', () => {
    const items: HistoryItem[] = [
      { id: 1, type: 'generate', prompt: 'test', urls: ['http://a.jpg'], timestamp: '2026-01-01' },
    ]
    mockStorage[STORAGE_KEY] = JSON.stringify(items)

    const history = useHistory()
    expect(history.getAll()).toEqual(items)
  })

  it('add creates item with auto-incremented id', () => {
    const history = useHistory()
    const item = history.add({ type: 'generate', prompt: 'hello', urls: ['http://b.jpg'], timestamp: '2026-01-02' })

    expect(item.id).toBe(1)
    expect(item.prompt).toBe('hello')

    const stored = JSON.parse(mockStorage[STORAGE_KEY])
    expect(stored).toHaveLength(1)
    expect(stored[0].id).toBe(1)
  })

  it('add auto-increments from existing max id', () => {
    mockStorage[STORAGE_KEY] = JSON.stringify([
      { id: 5, type: 'generate', prompt: 'old', urls: [], timestamp: '2026-01-01' },
    ])

    const history = useHistory()
    const item = history.add({ type: 'generate', prompt: 'new', urls: [], timestamp: '2026-01-03' })

    expect(item.id).toBe(6)
  })

  it('remove deletes item by id and returns true', () => {
    mockStorage[STORAGE_KEY] = JSON.stringify([
      { id: 1, type: 'generate', prompt: 'a', urls: [], timestamp: '2026-01-01' },
      { id: 2, type: 'generate', prompt: 'b', urls: [], timestamp: '2026-01-02' },
    ])

    const history = useHistory()
    const result = history.remove(1)

    expect(result).toBe(true)
    const stored = JSON.parse(mockStorage[STORAGE_KEY])
    expect(stored).toHaveLength(1)
    expect(stored[0].id).toBe(2)
  })

  it('remove returns false for non-existent id', () => {
    mockStorage[STORAGE_KEY] = JSON.stringify([])
    const history = useHistory()
    expect(history.remove(999)).toBe(false)
  })

  it('clear empties all history', () => {
    mockStorage[STORAGE_KEY] = JSON.stringify([
      { id: 1, type: 'generate', prompt: 'a', urls: [], timestamp: '2026-01-01' },
    ])

    const history = useHistory()
    history.clear()

    const stored = JSON.parse(mockStorage[STORAGE_KEY])
    expect(stored).toEqual([])
  })

  it('getAll returns empty array on malformed JSON', () => {
    mockStorage[STORAGE_KEY] = 'not-json'
    const history = useHistory()
    expect(history.getAll()).toEqual([])
  })
})

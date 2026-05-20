/**
 * useHistoryData — DonorItemView identity preservation.
 *
 * The whole point of memoizing DonorCard is wasted if the hook hands React
 * brand-new view objects every time the store pushes [...history]. These
 * tests lock in the cache-by-id + raw-ref invariant.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

let serviceItems: Array<{ id: number | string; [k: string]: unknown }> = []
let onChangeListeners: Array<(items: typeof serviceItems) => void> = []

vi.mock('../../features/history/HistoryDataService', () => ({
  getHistoryDataService: () => ({
    getAll: () => serviceItems,
    onChange: (cb: (items: typeof serviceItems) => void) => {
      onChangeListeners.push(cb)
      return () => {
        onChangeListeners = onChangeListeners.filter((c) => c !== cb)
      }
    },
    delete: vi.fn(),
    clearOldHistory: vi.fn(),
  }),
}))

import { useHistoryData } from '../useHistoryData'

function emit(next: typeof serviceItems) {
  serviceItems = next
  onChangeListeners.forEach((cb) => cb(next))
}

describe('useHistoryData — view identity', () => {
  beforeEach(() => {
    serviceItems = []
    onChangeListeners = []
  })

  it('preserves view object identity for unchanged raw items across store pushes', () => {
    const raw1 = { id: 1, urls: ['a'], r2Storage: true }
    const raw2 = { id: 2, urls: ['b'] }
    serviceItems = [raw1, raw2]

    const { result } = renderHook(() => useHistoryData())
    const first = result.current.items

    // Service re-emits the SAME items (typical no-op subscriber notification).
    act(() => {
      emit([raw1, raw2])
    })

    const second = result.current.items
    // Outer array may be new, but each view object reference must be stable
    // when its underlying raw object reference didn't change.
    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])
  })

  it('creates a new view only for items whose raw reference changed', () => {
    const raw1 = { id: 1, urls: ['a'] }
    const raw2 = { id: 2, urls: ['b'] }
    serviceItems = [raw1, raw2]

    const { result } = renderHook(() => useHistoryData())
    const first = result.current.items

    // raw1 untouched, raw2 replaced (immutable update pattern)
    const raw2Next = { id: 2, urls: ['c'], r2Storage: true }
    act(() => {
      emit([raw1, raw2Next])
    })

    expect(result.current.items[0]).toBe(first[0]) // unchanged
    expect(result.current.items[1]).not.toBe(first[1]) // new view
    expect(result.current.items[1].status).toBe('ok-cloud') // toView re-ran
  })

  it('drops cache entries for deleted items (no leak)', () => {
    const raw1 = { id: 1, urls: ['a'] }
    const raw2 = { id: 2, urls: ['b'] }
    serviceItems = [raw1, raw2]

    const { result } = renderHook(() => useHistoryData())
    expect(result.current.items).toHaveLength(2)

    // Delete raw1 from store, then re-add a fresh item with same id 1 later.
    act(() => {
      emit([raw2])
    })
    expect(result.current.items).toHaveLength(1)

    const raw1Fresh = { id: 1, urls: ['fresh'] }
    act(() => {
      emit([raw1Fresh, raw2])
    })
    // Should NOT return the stale cached view for id=1.
    expect(result.current.items[0].displayUrls).toEqual(['fresh'])
  })
})

import { describe, expect, it } from 'vitest'
import { resolveHistoryItemDisplayUrls } from '../HistoryPage'

describe('resolveHistoryItemDisplayUrls', () => {
  it('returns originalUrls when urls are pending placeholders', () => {
    const urls = resolveHistoryItemDisplayUrls({
      urls: ['pending:1'],
      originalUrls: ['https://example.com/fallback.png']
    })

    expect(urls).toEqual(['https://example.com/fallback.png'])
  })

  it('returns empty when only pending placeholder exists without source', () => {
    const urls = resolveHistoryItemDisplayUrls({
      urls: ['pending:1'],
      originalUrls: undefined
    })

    expect(urls).toEqual([])
  })
})

// @vitest-environment node

import { describe, it, expect, vi } from 'vitest'

import {
  dispatchBatchItemToHistory,
  type AddToHistoryFn,
  type BatchItemResult,
} from '../BatchPage'

// ---------------------------------------------------------------------------
// Why this test exists
// ---------------------------------------------------------------------------
// Before this fix, BatchPage waited for the entire `api.batchGenerate(...)`
// loop to settle before calling `app.addToHistory(allUrls)` *once* — meaning
// every image had to finish generating before any of them started uploading
// to Tencent COS. UX result: user stares at progress bar, nothing visibly
// uploads; then at the very end N uploads start in parallel.
//
// Fix: as each `batchItemComplete` event arrives, immediately call
// `addToHistory(type, prompt, [singleUrl], ratio)` for that one image.
// HistoryDataService → R2StorageService.uploadBase64 then routes through
// the `cos:upload-image-history` IPC, kicking off COS PutObject right away.
//
// We test the pure dispatcher in isolation so we don't have to instantiate
// the 1700-line BatchPage class with its DOM/i18n/PageManager dependencies.
// ---------------------------------------------------------------------------

describe('dispatchBatchItemToHistory', () => {
  function mkResult(overrides: Partial<BatchItemResult> = {}): BatchItemResult {
    return {
      index: 0,
      prompt: 'a robot in a forest',
      urls: ['data:image/png;base64,AAAA'],
      success: true,
      ...overrides,
    }
  }

  it('forwards a single successful result as a 1-url addToHistory call', () => {
    const addToHistory = vi.fn<AddToHistoryFn>()
    const result = mkResult()

    dispatchBatchItemToHistory(result, {
      historyType: 'batch',
      ratio: '16:9',
      addToHistory,
    })

    expect(addToHistory).toHaveBeenCalledTimes(1)
    expect(addToHistory).toHaveBeenCalledWith(
      'batch',
      'a robot in a forest',
      ['data:image/png;base64,AAAA'],
      '16:9',
    )
  })

  it('does NOT call addToHistory on failed results — they have no URLs to upload', () => {
    const addToHistory = vi.fn<AddToHistoryFn>()
    dispatchBatchItemToHistory(
      mkResult({ success: false, urls: [], errorMessage: 'timeout' }),
      { historyType: 'batch', ratio: '1:1', addToHistory },
    )
    expect(addToHistory).not.toHaveBeenCalled()
  })

  it('does NOT call addToHistory when success=true but urls is empty', () => {
    const addToHistory = vi.fn<AddToHistoryFn>()
    dispatchBatchItemToHistory(
      mkResult({ success: true, urls: [] }),
      { historyType: 'batch', ratio: '1:1', addToHistory },
    )
    expect(addToHistory).not.toHaveBeenCalled()
  })

  it('emits one addToHistory call per URL when API returned multiple variants (n>1)', () => {
    // ApiService.batchGenerate can request N variants per prompt. We still
    // want each variant to start uploading independently — N urls → N
    // single-url calls, not one multi-url call.
    const addToHistory = vi.fn<AddToHistoryFn>()
    dispatchBatchItemToHistory(
      mkResult({
        urls: [
          'data:image/png;base64,AAAA',
          'data:image/png;base64,BBBB',
          'data:image/png;base64,CCCC',
        ],
      }),
      { historyType: 'batch-card', ratio: '1:1', addToHistory },
    )
    expect(addToHistory).toHaveBeenCalledTimes(3)
    expect(addToHistory.mock.calls[0]).toEqual([
      'batch-card',
      'a robot in a forest',
      ['data:image/png;base64,AAAA'],
      '1:1',
    ])
    expect(addToHistory.mock.calls[1][2]).toEqual(['data:image/png;base64,BBBB'])
    expect(addToHistory.mock.calls[2][2]).toEqual(['data:image/png;base64,CCCC'])
  })

  it('passes through any historyType (card vs multi-prompt vs with-reference)', () => {
    const addToHistory = vi.fn<AddToHistoryFn>()
    for (const t of ['batch-card', 'batch', 'batch-with-reference'] as const) {
      dispatchBatchItemToHistory(mkResult(), { historyType: t, ratio: '1:1', addToHistory })
    }
    expect(addToHistory.mock.calls.map((c) => c[0])).toEqual([
      'batch-card',
      'batch',
      'batch-with-reference',
    ])
  })

  it('does not throw and does nothing when addToHistory is undefined (defensive guard)', () => {
    // Real-world: window.appTS / this.app may be undefined during early
    // shutdown / hot-reload. Dispatcher must not crash the event handler.
    expect(() =>
      dispatchBatchItemToHistory(mkResult(), {
        historyType: 'batch',
        ratio: '1:1',
        addToHistory: undefined,
      }),
    ).not.toThrow()
  })
})

import { describe, it, expect, vi } from 'vitest'
import { createEventCoalescer } from '../eventCoalescer'

type E = { type: string; id?: string }

/**
 * Manual scheduler: captures the flush callback so the test drives the "frame"
 * deterministically instead of waiting on real rAF/timers.
 */
function manualScheduler() {
  let pending: (() => void) | null = null
  let nextHandle = 1
  return {
    schedule: (cb: () => void) => {
      pending = cb
      return nextHandle++
    },
    cancel: () => {
      pending = null
    },
    /** Run the scheduled flush, if any (simulates the next animation frame). */
    tick: () => {
      const cb = pending
      pending = null
      cb?.()
    },
    hasPending: () => pending !== null,
  }
}

describe('createEventCoalescer', () => {
  it('buffers item_delta events and applies them on the next frame, in order', () => {
    const sched = manualScheduler()
    const applied: E[] = []
    const c = createEventCoalescer<E>((e) => applied.push(e), {
      schedule: sched.schedule,
      cancel: sched.cancel,
    })

    c.push({ type: 'item_delta', id: 'a' })
    c.push({ type: 'item_delta', id: 'b' })
    // Not applied yet — still buffered for the frame.
    expect(applied).toEqual([])
    expect(sched.hasPending()).toBe(true)

    sched.tick()
    expect(applied.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('coalesces a burst into a SINGLE scheduled frame', () => {
    const schedule = vi.fn((cb: () => void) => {
      // store but never auto-run; count calls
      void cb
      return 1
    })
    const cancel = vi.fn()
    const c = createEventCoalescer<E>(() => {}, { schedule, cancel })
    c.push({ type: 'item_delta' })
    c.push({ type: 'item_delta' })
    c.push({ type: 'item_delta' })
    // Only one frame scheduled for the whole burst.
    expect(schedule).toHaveBeenCalledTimes(1)
  })

  it('flushes buffered deltas immediately (in order) when a non-delta event arrives', () => {
    const sched = manualScheduler()
    const applied: E[] = []
    const c = createEventCoalescer<E>((e) => applied.push(e), {
      schedule: sched.schedule,
      cancel: sched.cancel,
    })

    c.push({ type: 'item_delta', id: 'd1' })
    c.push({ type: 'item_delta', id: 'd2' })
    c.push({ type: 'turn_completed', id: 'done' })

    // Terminal/structural event must not wait for the frame: buffered deltas
    // drain first, then the structural event — order preserved, nothing lost.
    expect(applied.map((e) => e.id)).toEqual(['d1', 'd2', 'done'])
    // Pending frame got cancelled (already drained).
    expect(sched.hasPending()).toBe(false)
  })

  it('item_completed is treated as immediate (final text is authoritative, never delayed)', () => {
    const sched = manualScheduler()
    const applied: E[] = []
    const c = createEventCoalescer<E>((e) => applied.push(e), {
      schedule: sched.schedule,
      cancel: sched.cancel,
    })
    c.push({ type: 'item_delta', id: 'x' })
    c.push({ type: 'item_completed', id: 'final' })
    expect(applied.map((e) => e.id)).toEqual(['x', 'final'])
  })

  it('flush() drains buffered deltas on demand', () => {
    const sched = manualScheduler()
    const applied: E[] = []
    const c = createEventCoalescer<E>((e) => applied.push(e), {
      schedule: sched.schedule,
      cancel: sched.cancel,
    })
    c.push({ type: 'item_delta', id: 'p' })
    c.flush()
    expect(applied.map((e) => e.id)).toEqual(['p'])
    expect(sched.hasPending()).toBe(false)
  })

  it('dispose() flushes remaining deltas then stops (no loss on unmount)', () => {
    const sched = manualScheduler()
    const applied: E[] = []
    const c = createEventCoalescer<E>((e) => applied.push(e), {
      schedule: sched.schedule,
      cancel: sched.cancel,
    })
    c.push({ type: 'item_delta', id: 'tail' })
    c.dispose()
    expect(applied.map((e) => e.id)).toEqual(['tail'])
    // After dispose, further pushes are ignored.
    c.push({ type: 'item_delta', id: 'after' })
    sched.tick()
    expect(applied.map((e) => e.id)).toEqual(['tail'])
  })

  it('respects a custom shouldCoalesce predicate', () => {
    const sched = manualScheduler()
    const applied: E[] = []
    const c = createEventCoalescer<E>((e) => applied.push(e), {
      schedule: sched.schedule,
      cancel: sched.cancel,
      // Coalesce nothing → every event is immediate.
      shouldCoalesce: () => false,
    })
    c.push({ type: 'item_delta', id: 'now' })
    expect(applied.map((e) => e.id)).toEqual(['now'])
  })
})

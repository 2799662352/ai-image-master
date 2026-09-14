/**
 * Sketch pad stroke slider (user feedback 2026-09-14: "画板换成滑块那种"):
 * a vertical rail that snaps to tldraw's four size stops — keyboard, click and
 * drag all land on a stop; the thumb doubles as the live width preview.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StrokeSlider } from '../sketch/StrokeSlider'
import { STROKE_STOPS } from '../sketch/sketchExport'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('StrokeSlider', () => {
  it('is a vertical slider whose value is the stop index with a human value text', () => {
    render(<StrokeSlider value="m" onChange={() => {}} />)
    const slider = screen.getByRole('slider', { name: '笔宽' })
    expect(slider.getAttribute('aria-orientation')).toBe('vertical')
    expect(slider.getAttribute('aria-valuemin')).toBe('0')
    expect(slider.getAttribute('aria-valuemax')).toBe(String(STROKE_STOPS.length - 1))
    expect(slider.getAttribute('aria-valuenow')).toBe('1')
    expect(slider.getAttribute('aria-valuetext')).toBe('中 4.5px')
  })

  it('arrow keys step one stop at a time and clamp at both ends', () => {
    const onChange = vi.fn()
    const { rerender } = render(<StrokeSlider value="m" onChange={onChange} />)
    const slider = screen.getByRole('slider', { name: '笔宽' })
    fireEvent.keyDown(slider, { key: 'ArrowDown' })
    expect(onChange).toHaveBeenLastCalledWith('l')
    fireEvent.keyDown(slider, { key: 'ArrowUp' })
    expect(onChange).toHaveBeenLastCalledWith('s')
    fireEvent.keyDown(slider, { key: 'End' })
    expect(onChange).toHaveBeenLastCalledWith('xl')

    onChange.mockClear()
    rerender(<StrokeSlider value="s" onChange={onChange} />)
    fireEvent.keyDown(screen.getByRole('slider', { name: '笔宽' }), { key: 'ArrowUp' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('pointer down / drag on the rail snaps to the nearest stop', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 100, height: 132, left: 0, width: 36, bottom: 232, right: 36, x: 0, y: 100, toJSON: () => ({}),
    } as DOMRect)
    const onChange = vi.fn()
    const { rerender } = render(<StrokeSlider value="s" onChange={onChange} />)
    const slider = screen.getByRole('slider', { name: '笔宽' })
    // bottom of the rail → thickest
    fireEvent.pointerDown(slider, { clientY: 232, pointerId: 1 })
    expect(onChange).toHaveBeenLastCalledWith('xl')
    rerender(<StrokeSlider value="xl" onChange={onChange} />)
    // drag up to ~1/3 → 'm'
    fireEvent.pointerMove(slider, { clientY: 100 + 132 / 3, pointerId: 1 })
    expect(onChange).toHaveBeenLastCalledWith('m')
    fireEvent.pointerUp(slider, { pointerId: 1 })
    onChange.mockClear()
    // after release, moving does nothing
    fireEvent.pointerMove(slider, { clientY: 100, pointerId: 1 })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('draws every stop at its real pixel width and the thumb preview at the current width', () => {
    const { container } = render(<StrokeSlider value="l" onChange={() => {}} />)
    const dots = Array.from(container.querySelectorAll('span[style]')).map((el) => (el as HTMLElement).style.width)
    for (const s of STROKE_STOPS) expect(dots).toContain(`${s.px}px`)
    expect(screen.getByText('6px')).toBeTruthy()
  })
})

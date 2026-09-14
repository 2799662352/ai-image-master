import { useRef, useState } from 'react'
import type { JSX } from 'react'
import { STROKE_STOPS, type SketchStrokeSize } from './sketchExport'

interface StrokeSliderProps {
  value: SketchStrokeSize
  onChange: (next: SketchStrokeSize) => void
}

const TRACK_HEIGHT = 132
const THUMB = 30

function clampIndex(i: number): number {
  return Math.min(STROKE_STOPS.length - 1, Math.max(0, i))
}

/** Vertical position (px from track top) of stop `i`, thin at the top, thick at the bottom. */
function stopOffset(i: number): number {
  return (i / (STROKE_STOPS.length - 1)) * TRACK_HEIGHT
}

/**
 * Stroke-width slider for the sketch pad: a vertical rail with the four tldraw
 * size stops drawn as dots at their real width, and a draggable cyan thumb
 * that snaps to the nearest stop (drag, click anywhere on the rail, or ↑ ↓).
 * The thumb shows the current width inside it, so the control doubles as the
 * brush preview.
 */
export function StrokeSlider({ value, onChange }: StrokeSliderProps): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const index = Math.max(0, STROKE_STOPS.findIndex((s) => s.id === value))
  const current = STROKE_STOPS[index]

  const pick = (i: number): void => {
    const next = STROKE_STOPS[clampIndex(i)]
    if (next.id !== value) onChange(next.id)
  }
  const pickFromClientY = (clientY: number): void => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.height <= 0) return
    const t = (clientY - rect.top) / rect.height
    pick(Math.round(Math.min(1, Math.max(0, t)) * (STROKE_STOPS.length - 1)))
  }

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="笔宽"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={STROKE_STOPS.length - 1}
      aria-valuenow={index}
      aria-valuetext={`${current.label} ${current.px}px`}
      title="笔宽:拖动 / 点击 / ↑↓"
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          e.preventDefault()
          pick(index - 1)
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          e.preventDefault()
          pick(index + 1)
        } else if (e.key === 'Home') {
          e.preventDefault()
          pick(0)
        } else if (e.key === 'End') {
          e.preventDefault()
          pick(STROKE_STOPS.length - 1)
        }
      }}
      onPointerDown={(e) => {
        e.preventDefault()
        const el = e.currentTarget
        if (typeof el.setPointerCapture === 'function') el.setPointerCapture(e.pointerId)
        setDragging(true)
        pickFromClientY(e.clientY)
      }}
      onPointerMove={(e) => {
        if (dragging) pickFromClientY(e.clientY)
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      className={[
        'group relative flex w-9 cursor-pointer select-none touch-none flex-col items-center rounded-full py-2 outline-none',
        'bg-white/70 shadow-[0_1px_4px_rgba(0,0,0,0.12)] ring-1 ring-zinc-900/10 backdrop-blur-sm',
        'focus-visible:ring-2 focus-visible:ring-cyan-400',
      ].join(' ')}
    >
      <div ref={trackRef} className="relative w-full" style={{ height: TRACK_HEIGHT }}>
        {/* rail */}
        <span aria-hidden="true" className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-zinc-900/15" />
        {/* stops at their real width */}
        {STROKE_STOPS.map((s, i) => (
          <span
            key={s.id}
            aria-hidden="true"
            className={`absolute left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors ${i === index ? 'bg-zinc-900' : 'bg-zinc-900/55 group-hover:bg-zinc-900/80'}`}
            style={{ top: stopOffset(i), width: s.px, height: s.px }}
          />
        ))}
        {/* thumb: rides the current stop, shows the current width inside */}
        <span
          aria-hidden="true"
          className={[
            'absolute left-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border transition-[top,transform] duration-150',
            dragging ? 'scale-110 border-cyan-400 bg-cyan-100' : 'border-cyan-300/80 bg-cyan-50 shadow-[0_0_0_3px_rgba(34,211,238,0.18)]',
          ].join(' ')}
          style={{ top: stopOffset(index), width: THUMB, height: THUMB }}
        >
          <span className="rounded-full bg-zinc-900" style={{ width: current.px, height: current.px }} />
        </span>
      </div>
      <span className="mt-3 font-mono text-[9px] leading-none text-zinc-500 tabular-nums">{current.px}px</span>
    </div>
  )
}

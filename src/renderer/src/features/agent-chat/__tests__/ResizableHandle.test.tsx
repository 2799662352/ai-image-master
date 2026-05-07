// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { ResizableHandle } from '../ResizableHandle'

describe('ResizableHandle', () => {
  it('calls onResize during pointer drag', () => {
    const onResize = vi.fn()
    const onResizeEnd = vi.fn()
    const { container } = render(
      <ResizableHandle panelRight={1000} onResize={onResize} onResizeEnd={onResizeEnd} />,
    )
    const handle = container.firstElementChild!
    fireEvent.pointerDown(handle, { clientX: 1000 })
    fireEvent.pointerMove(document, { clientX: 900 })
    expect(onResize).toHaveBeenCalled()
  })
})

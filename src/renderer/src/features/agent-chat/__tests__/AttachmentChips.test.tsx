import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentChips } from '../AttachmentChips'
import { useAgentChatStore } from '../store'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AttachmentChips duplicate filenames', () => {
  beforeEach(() => {
    useAgentChatStore.setState({ attachments: [] } as never)
  })

  it('gives same-name attachments distinct identities and removes only the clicked one', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const firstBuffer = new Uint8Array([1]).buffer
    const secondBuffer = new Uint8Array([2]).buffer
    const { addAttachment } = useAgentChatStore.getState()
    addAttachment({ name: 'image.png', mime: 'image/png', size: 1, buffer: firstBuffer })
    addAttachment({ name: 'image.png', mime: 'image/png', size: 1, buffer: secondBuffer })

    render(<AttachmentChips />)

    const before = useAgentChatStore.getState().attachments
    expect(before).toHaveLength(2)
    expect(before[0].composerId).toBeTruthy()
    expect(before[1].composerId).toBeTruthy()
    expect(before[0].composerId).not.toBe(before[1].composerId)
    expect(screen.getAllByRole('button', { name: 'image.png x' })).toHaveLength(2)
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('Encountered two children with the same key'),
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'image.png x' })[0])

    const after = useAgentChatStore.getState().attachments
    expect(after).toHaveLength(1)
    expect(after[0].buffer).toBe(secondBuffer)
    expect(screen.getAllByRole('button', { name: 'image.png x' })).toHaveLength(1)
  })
})

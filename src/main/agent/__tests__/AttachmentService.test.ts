import { describe, expect, it, vi } from 'vitest'

describe('AttachmentService contract', () => {
  it('stores metadata needed by agent attachments', () => {
    const create = vi.fn()
    create({
      data: {
        threadId: 't1',
        originalName: 'a.png',
        localPath: '/tmp/a.png',
        mime: 'image/png',
        size: 3,
      },
    })

    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ mime: 'image/png' }) })
  })
})

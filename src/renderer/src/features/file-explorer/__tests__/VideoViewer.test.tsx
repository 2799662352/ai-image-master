import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VideoViewer } from '../VideoViewer'
import type { FileTab } from '../types'

const tab: FileTab = {
  id: 'v1',
  path: 'D:/repo/demo.mp4',
  name: 'demo.mp4',
  source: 'workspace',
  kind: 'video',
  state: null,
  diskContent: '',
  diskMtime: 0,
  dirty: false,
}

beforeEach(() => {
  // Stub electronAPI.fs.readBinary so useFileUrl can resolve to ready state
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    fs: {
      readBinary: vi.fn(async () => ({
        ok: true,
        base64: '',
        mime: 'video/mp4',
      })),
    },
  }
  // jsdom doesn't implement createObjectURL
  if (!URL.createObjectURL) {
    URL.createObjectURL = vi.fn(() => 'blob:mock') as typeof URL.createObjectURL
  }
  if (!URL.revokeObjectURL) {
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL
  }
})

afterEach(() => {
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = undefined
})

describe('VideoViewer', () => {
  it('renders an HTML video control once the blob URL resolves', async () => {
    const { container } = render(<VideoViewer tab={tab} />)
    await waitFor(() => expect(container.querySelector('video')).toBeTruthy())
    expect(screen.getByText('demo.mp4')).toBeTruthy()
  })
})

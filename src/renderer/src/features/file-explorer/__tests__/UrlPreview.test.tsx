import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentReference } from '../../../../../types/agent-reference'
import { UrlPreview } from '../UrlPreview'

afterEach(cleanup)

const safeRef: AgentReference = {
  id: 'url:https://developers.openai.com',
  type: 'url',
  label: 'developers.openai.com',
  source: { kind: 'url', url: 'https://developers.openai.com' },
  status: 'ready',
  openBehavior: 'url',
}

describe('UrlPreview', () => {
  it('renders an iframe with a minimal sandbox for https URLs', () => {
    const { container } = render(<UrlPreview reference={safeRef} />)
    const iframe = container.querySelector('iframe')
    expect(iframe).toBeTruthy()
    const sandbox = iframe?.getAttribute('sandbox') ?? ''
    expect(sandbox.split(/\s+/)).toContain('allow-popups')
    expect(sandbox.split(/\s+/)).toContain('allow-scripts')
    expect(sandbox.split(/\s+/)).not.toContain('allow-same-origin')
    expect(sandbox.split(/\s+/)).not.toContain('allow-forms')
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('refuses to render iframe for unsafe schemes', () => {
    render(<UrlPreview reference={{ ...safeRef, source: { kind: 'url', url: 'javascript:alert(1)' } }} />)
    expect(screen.queryByText(/Embedded preview blocked/i)).toBeTruthy()
  })

  it('does not embed http URLs but allows validated external opening', () => {
    const openExternal = vi.fn(async () => undefined)
    Object.defineProperty(window, 'electronAPI', {
      value: { shell: { openExternal } },
      configurable: true,
    })
    const { container } = render(
      <UrlPreview reference={{ ...safeRef, source: { kind: 'url', url: 'http://localhost:3000/preview' } }} />,
    )
    expect(container.querySelector('iframe')).toBeNull()
    screen.getByText(/HTTP preview not embedded/i)
    screen.getByRole('button', { name: /open external/i }).click()
    expect(openExternal).toHaveBeenCalledWith('http://localhost:3000/preview')
  })
})

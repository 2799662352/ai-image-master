// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ModelReasoningEffort,
  ModelSettingsCapabilities,
} from '../../../../../shared/modelSettings'
import {
  ModelSettingsPanel,
  formatContextWindow,
} from '../ModelSettingsPanel'

const SOL_CAPABILITIES: ModelSettingsCapabilities = {
  model: 'gpt-5.6-sol',
  provider: 'rightcode',
  defaultContextWindow: 372_000,
  contextOptions: [
    { value: 372_000, experimental: false },
    { value: 1_000_000, experimental: true },
  ],
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
}

const GPT_55_CAPABILITIES: ModelSettingsCapabilities = {
  model: 'gpt-5.5',
  provider: 'rightcode',
  defaultContextWindow: 272_000,
  contextOptions: [
    { value: 272_000, experimental: false },
    { value: 1_000_000, experimental: true },
  ],
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
}

interface RenderPanelOptions {
  capabilities?: ModelSettingsCapabilities
  reasoningEffort?: ModelReasoningEffort
  contextWindow?: number
  disabled?: boolean
  pending?: boolean
  error?: string
  onReasoningChange?: (effort: ModelReasoningEffort) => void
  onContextChange?: (contextWindow: number) => Promise<void>
}

function renderPanel(options: RenderPanelOptions = {}) {
  const onReasoningChange = options.onReasoningChange ?? vi.fn()
  const onContextChange = options.onContextChange ?? vi.fn().mockResolvedValue(undefined)

  const result = render(
    <ModelSettingsPanel
      capabilities={options.capabilities ?? SOL_CAPABILITIES}
      reasoningEffort={options.reasoningEffort ?? 'medium'}
      contextWindow={options.contextWindow ?? 372_000}
      disabled={options.disabled ?? false}
      pending={options.pending ?? false}
      error={options.error}
      onReasoningChange={onReasoningChange}
      onContextChange={onContextChange}
    />,
  )

  return { ...result, onReasoningChange, onContextChange }
}

afterEach(() => {
  cleanup()
})

describe('ModelSettingsPanel', () => {
  it('renders Right Code gpt-5.6-sol capabilities without unsupported options', () => {
    renderPanel()

    expect(screen.getByRole('option', { name: /^372K$/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /1M.*实验性/ })).toBeTruthy()
    for (const label of ['Auto', 'Low', 'Medium', 'High', 'Extra high', 'Max']) {
      expect(screen.getByRole('option', { name: label })).toBeTruthy()
    }
    expect(screen.queryByRole('option', { name: /Ultra/i })).toBeNull()
    expect(screen.queryByRole('option', { name: /Fast/i })).toBeNull()
    expect(screen.getByText(/Provider 可能拒绝/).textContent).toMatch(/成本.*延迟/)
  })

  it('does not render Max when gpt-5.5 capabilities omit it', () => {
    renderPanel({ capabilities: GPT_55_CAPABILITIES, contextWindow: 272_000 })

    expect(screen.getByRole('option', { name: 'Extra high' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Max' })).toBeNull()
  })

  it.each([
    ['disabled', { disabled: true }],
    ['pending', { pending: true }],
  ])('disables every option and callback while %s', (_label, state) => {
    const onReasoningChange = vi.fn()
    const onContextChange = vi.fn().mockResolvedValue(undefined)
    renderPanel({ ...state, onReasoningChange, onContextChange })

    const options = screen.getAllByRole('option')
    expect(options.length).toBeGreaterThan(0)
    for (const option of options) {
      expect((option as HTMLButtonElement).disabled).toBe(true)
      expect(option.getAttribute('aria-disabled')).toBe('true')
      fireEvent.click(option)
    }
    expect(onReasoningChange).not.toHaveBeenCalled()
    expect(onContextChange).not.toHaveBeenCalled()
  })

  it('emits the selected context and Auto reasoning values', () => {
    const onReasoningChange = vi.fn()
    const onContextChange = vi.fn().mockResolvedValue(undefined)
    renderPanel({ onReasoningChange, onContextChange })

    fireEvent.click(screen.getByRole('option', { name: /1M.*实验性/ }))
    fireEvent.click(screen.getByRole('option', { name: 'Auto' }))

    expect(onContextChange).toHaveBeenCalledWith(1_000_000)
    expect(onReasoningChange).toHaveBeenCalledWith('auto')
  })

  it('announces external errors before pending status through a polite live region', () => {
    const { rerender } = renderPanel({ pending: true, error: 'Provider 更新失败' })
    const status = screen.getByRole('status')

    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toContain('Provider 更新失败')
    expect(status.textContent).not.toContain('保存中')

    rerender(
      <ModelSettingsPanel
        capabilities={SOL_CAPABILITIES}
        reasoningEffort="medium"
        contextWindow={372_000}
        disabled={false}
        pending
        onReasoningChange={vi.fn()}
        onContextChange={vi.fn().mockResolvedValue(undefined)}
      />,
    )
    expect(screen.getByRole('status').textContent).toContain('保存中')
  })

  it('connects named sections and marks both current selections', () => {
    renderPanel({ reasoningEffort: 'high', contextWindow: 1_000_000 })

    const contextSection = screen.getByRole('region', { name: 'Context' })
    const reasoningSection = screen.getByRole('region', { name: 'Reasoning' })
    expect(within(contextSection).getByRole('listbox', { name: '模型上下文' })).toBeTruthy()
    expect(within(reasoningSection).getByRole('listbox', { name: '推理强度' })).toBeTruthy()
    expect(
      screen.getByRole('option', { name: /1M.*实验性/ }).getAttribute('aria-selected'),
    ).toBe('true')
    expect(screen.getByRole('option', { name: 'High' }).getAttribute('aria-selected')).toBe(
      'true',
    )
  })

  it('consumes a rejected context update without an unhandled rejection', async () => {
    const onContextChange = vi.fn().mockRejectedValue(new Error('rejected'))
    renderPanel({ onContextChange })

    fireEvent.click(screen.getByRole('option', { name: /1M.*实验性/ }))

    await waitFor(() => {
      expect(onContextChange).toHaveBeenCalledWith(1_000_000)
    })
    await Promise.resolve()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('formatContextWindow', () => {
  it('formats known context sizes compactly', () => {
    expect(formatContextWindow(372_000)).toBe('372K')
    expect(formatContextWindow(1_000_000)).toBe('1M')
  })
})

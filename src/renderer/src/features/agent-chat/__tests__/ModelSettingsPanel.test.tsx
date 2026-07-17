// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ModelReasoningEffort,
  ModelSettingsCapabilities,
} from '../../../../../shared/modelSettings'
import { mergeModelSettingsCapabilities } from '../../../../../shared/modelSettings'
import {
  ModelSettingsPanel,
  formatContextWindow,
} from '../ModelSettingsPanel'

const SOL_CAPABILITIES: ModelSettingsCapabilities = mergeModelSettingsCapabilities({
  model: 'gpt-5.6-sol',
  gatewayId: 'rightcode',
  channelId: 'rightcode-standard',
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
    'fast',
  ],
})

const GPT_55_CAPABILITIES: ModelSettingsCapabilities = mergeModelSettingsCapabilities({
  model: 'gpt-5.5',
  gatewayId: 'rightcode',
  channelId: 'rightcode-standard',
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'fast'],
})

const UNKNOWN_CAPABILITIES: ModelSettingsCapabilities = mergeModelSettingsCapabilities({
  model: 'vendor-new-model',
  gatewayId: 'rightcode',
  channelId: 'rightcode-standard',
  supportedReasoningEfforts: ['low', 'medium'],
})

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
    expect(screen.getByText(
      '强制客户端按 1M 管理上下文；Provider 可能拒绝、返回 HTTP 413、增加费用或延迟。',
    )).toBeTruthy()
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
    for (const listbox of screen.getAllByRole('listbox')) {
      const groupOptions = within(listbox).getAllByRole('option') as HTMLButtonElement[]
      const initialTabStops = groupOptions.map((option) => option.tabIndex)
      const tabStop = groupOptions.find((option) => option.tabIndex === 0)
      expect(tabStop).toBeTruthy()
      fireEvent.keyDown(tabStop!, { key: 'ArrowRight' })
      expect(groupOptions.map((option) => option.tabIndex)).toEqual(initialTabStops)
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
    expect(status.textContent).not.toContain('正在应用并恢复线程')

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
    expect(screen.getByRole('status').textContent).toBe('正在应用并恢复线程')
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

  it('uses the selected option as each group tab stop and falls back to the first option', () => {
    const { rerender } = renderPanel({ reasoningEffort: 'high', contextWindow: 1_000_000 })
    const contextOptions = within(
      screen.getByRole('listbox', { name: '模型上下文' }),
    ).getAllByRole('option') as HTMLButtonElement[]
    const reasoningOptions = within(
      screen.getByRole('listbox', { name: '推理强度' }),
    ).getAllByRole('option') as HTMLButtonElement[]

    expect(contextOptions.map((option) => option.tabIndex)).toEqual([-1, 0])
    expect(reasoningOptions.map((option) => option.tabIndex)).toEqual([
      -1,
      -1,
      -1,
      0,
      -1,
      -1,
    ])

    rerender(
      <ModelSettingsPanel
        capabilities={GPT_55_CAPABILITIES}
        reasoningEffort="max"
        contextWindow={999}
        disabled={false}
        pending={false}
        onReasoningChange={vi.fn()}
        onContextChange={vi.fn().mockResolvedValue(undefined)}
      />,
    )

    const fallbackContextOptions = within(
      screen.getByRole('listbox', { name: '模型上下文' }),
    ).getAllByRole('option') as HTMLButtonElement[]
    const fallbackReasoningOptions = within(
      screen.getByRole('listbox', { name: '推理强度' }),
    ).getAllByRole('option') as HTMLButtonElement[]
    expect(fallbackContextOptions.map((option) => option.tabIndex)).toEqual([0, -1])
    expect(fallbackReasoningOptions.map((option) => option.tabIndex)).toEqual([
      0,
      -1,
      -1,
      -1,
      -1,
    ])
  })

  it('moves context focus cyclically with arrows, Home, and End without selecting', () => {
    const { onContextChange } = renderPanel()
    const contextOptions = within(
      screen.getByRole('listbox', { name: '模型上下文' }),
    ).getAllByRole('option') as HTMLButtonElement[]
    const [standard, experimental] = contextOptions

    standard.focus()
    fireEvent.keyDown(standard, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(experimental)
    expect(contextOptions.map((option) => option.tabIndex)).toEqual([-1, 0])

    fireEvent.keyDown(experimental, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(standard)
    fireEvent.keyDown(standard, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(experimental)
    fireEvent.keyDown(experimental, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(standard)
    fireEvent.keyDown(standard, { key: 'End' })
    expect(document.activeElement).toBe(experimental)
    fireEvent.keyDown(experimental, { key: 'Home' })
    expect(document.activeElement).toBe(standard)

    expect(contextOptions.map((option) => option.tabIndex)).toEqual([0, -1])
    expect(onContextChange).not.toHaveBeenCalled()
  })

  it('applies the same roving focus behavior to reasoning options', () => {
    const { onReasoningChange } = renderPanel()
    const reasoningOptions = within(
      screen.getByRole('listbox', { name: '推理强度' }),
    ).getAllByRole('option') as HTMLButtonElement[]
    const medium = screen.getByRole('option', { name: 'Medium' }) as HTMLButtonElement
    const high = screen.getByRole('option', { name: 'High' }) as HTMLButtonElement
    const auto = screen.getByRole('option', { name: 'Auto' }) as HTMLButtonElement
    const max = screen.getByRole('option', { name: 'Max' }) as HTMLButtonElement

    medium.focus()
    fireEvent.keyDown(medium, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(high)
    fireEvent.keyDown(high, { key: 'Home' })
    expect(document.activeElement).toBe(auto)
    fireEvent.keyDown(auto, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(max)
    fireEvent.keyDown(max, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(auto)
    fireEvent.keyDown(auto, { key: 'End' })
    expect(document.activeElement).toBe(max)

    expect(reasoningOptions.filter((option) => option.tabIndex === 0)).toEqual([max])
    expect(onReasoningChange).not.toHaveBeenCalled()
  })

  it('labels the unknown-model context as a conservative default', () => {
    renderPanel({
      capabilities: UNKNOWN_CAPABILITIES,
      contextWindow: 200_000,
      reasoningEffort: 'auto',
    })

    expect(screen.getByRole('option', { name: /200K.*保守默认/ })).toBeTruthy()
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

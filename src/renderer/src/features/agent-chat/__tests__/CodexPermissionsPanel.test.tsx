import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexPermissionsPanel } from '../CodexPermissionsPanel'
import type { CodexSessionStatus } from '../../../../../types/agent'

const baseStatus: CodexSessionStatus = {
  model: 'gpt-5.5',
  sandboxMode: 'workspace-write',
  approvalPolicy: 'on-request',
  webSearch: 'cached',
  writableRoots: ['D:/workspace'],
}

afterEach(cleanup)

// Labels are Chinese-first with the raw config value in mono, so accessible
// names look like "工作区可写 workspace-write" — match on the canonical value.
describe('CodexPermissionsPanel', () => {
  it('shows current values', () => {
    render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} />)

    expect(screen.getByRole('radio', { name: /workspace-write/ })).toHaveProperty('checked', true)
    expect(screen.getByRole('radio', { name: /on-request/ })).toHaveProperty('checked', true)
    expect(screen.getByRole('radio', { name: /cached/ })).toHaveProperty('checked', true)
    expect(screen.getByText('D:/workspace')).toBeTruthy()
  })

  it('disables Apply initially', () => {
    render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} />)

    expect(screen.getByRole('button', { name: /应用设置/ })).toHaveProperty('disabled', true)
  })

  it('shows a warning and enables Apply when an unsafe value is selected', () => {
    render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} />)

    fireEvent.click(screen.getByRole('radio', { name: /danger-full-access/ }))

    expect(screen.getByText(/高权限配置/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /应用设置/ })).toHaveProperty('disabled', false)
  })

  it('calls onApply with only changed fields', () => {
    const onApply = vi.fn()
    render(<CodexPermissionsPanel status={baseStatus} onApply={onApply} />)

    fireEvent.click(screen.getByRole('radio', { name: /disabled/ }))
    fireEvent.click(screen.getByRole('button', { name: /应用设置/ }))

    expect(onApply).toHaveBeenCalledWith({ webSearch: 'disabled' })
  })

  it('defaults the session tuning group to the historical hardcoded behavior', () => {
    render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} />)

    // Both personality AND verbosity default rows read "默认 default".
    const defaults = screen.getAllByRole('radio', { name: /default/ })
    expect(defaults).toHaveLength(2)
    for (const radio of defaults) {
      expect(radio).toHaveProperty('checked', true)
    }
    expect(screen.getByRole('radio', { name: /auto/ })).toHaveProperty('checked', true)
    expect(screen.getByRole('checkbox', { name: /原始思维链/ })).toHaveProperty('checked', true)
    expect(screen.getByRole('radio', { name: /indexed/ })).toHaveProperty('checked', false)
  })

  it('applies session tuning changes as a minimal patch', () => {
    const onApply = vi.fn()
    render(<CodexPermissionsPanel status={baseStatus} onApply={onApply} />)

    fireEvent.click(screen.getByRole('radio', { name: /pragmatic/ }))
    fireEvent.click(screen.getByRole('radio', { name: /detailed/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /原始思维链/ }))
    fireEvent.click(screen.getByRole('button', { name: /应用设置/ }))

    expect(onApply).toHaveBeenCalledWith({
      personality: 'pragmatic',
      reasoningSummary: 'detailed',
      showRawReasoning: false,
    })
  })

  it('includes modelVerbosity in the patch when changed (batch 2)', () => {
    const onApply = vi.fn()
    render(<CodexPermissionsPanel status={baseStatus} onApply={onApply} />)

    fireEvent.click(screen.getByRole('radio', { name: /详尽/ }))
    fireEvent.click(screen.getByRole('button', { name: /应用设置/ }))

    expect(onApply).toHaveBeenCalledWith({ modelVerbosity: 'high' })
  })

  it('passes persist:true when 保存为默认 is checked', () => {
    const onApply = vi.fn()
    render(<CodexPermissionsPanel status={baseStatus} onApply={onApply} />)

    fireEvent.click(screen.getByRole('radio', { name: /disabled/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /保存为默认/ }))
    fireEvent.click(screen.getByRole('button', { name: /应用设置/ }))

    expect(onApply).toHaveBeenCalledWith({ webSearch: 'disabled' }, { persist: true })
  })

  it('enables Apply with persist checked even without field changes (snapshot current config)', () => {
    const onApply = vi.fn()
    render(<CodexPermissionsPanel status={baseStatus} onApply={onApply} />)

    expect(screen.getByRole('button', { name: /应用设置/ })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('checkbox', { name: /保存为默认/ }))
    expect(screen.getByRole('button', { name: /应用设置/ })).toHaveProperty('disabled', false)

    fireEvent.click(screen.getByRole('button', { name: /应用设置/ }))
    expect(onApply).toHaveBeenCalledWith({}, { persist: true })
  })

  it('shows the persisted hint + factory reset only when defaults come from a saved snapshot', () => {
    const onReset = vi.fn()
    render(
      <CodexPermissionsPanel
        status={{ ...baseStatus, persistedDefaults: true }}
        onApply={vi.fn()}
        onReset={onReset}
      />,
    )

    expect(screen.getByText(/来自你保存的设置/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /恢复出厂设置/ }))
    expect(onReset).toHaveBeenCalled()
  })

  it('hides the factory reset when defaults are pristine', () => {
    render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} onReset={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /恢复出厂设置/ })).toBeNull()
  })

  it('renders an unavailable state when no status is provided', () => {
    render(<CodexPermissionsPanel onApply={vi.fn()} />)

    expect(screen.getByText(/设置不可用/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /应用设置/ })).toBeNull()
  })

  it('defaults the 跨会话记忆 toggle to ON when the status omits the field', () => {
    render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} />)

    expect(screen.getByRole('checkbox', { name: /启用跨会话记忆/ })).toHaveProperty('checked', true)
  })

  it('reflects memoriesEnabled=false from the status snapshot', () => {
    render(
      <CodexPermissionsPanel
        status={{ ...baseStatus, memoriesEnabled: false }}
        onApply={vi.fn()}
      />,
    )

    expect(screen.getByRole('checkbox', { name: /启用跨会话记忆/ })).toHaveProperty('checked', false)
  })

  it('includes memoriesEnabled in the patch when toggled off', () => {
    const onApply = vi.fn()
    render(<CodexPermissionsPanel status={baseStatus} onApply={onApply} />)

    fireEvent.click(screen.getByRole('checkbox', { name: /启用跨会话记忆/ }))
    fireEvent.click(screen.getByRole('button', { name: /应用设置/ }))

    expect(onApply).toHaveBeenCalledWith({ memoriesEnabled: false })
  })

  it('hides 清除记忆 when onResetMemory is absent', () => {
    render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /清除记忆/ })).toBeNull()
  })

  it('清除记忆 requires a two-step confirm before calling onResetMemory', async () => {
    const onResetMemory = vi.fn().mockResolvedValue({ ok: true })
    render(
      <CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} onResetMemory={onResetMemory} />,
    )

    // First click only arms the confirm — no RPC yet.
    fireEvent.click(screen.getByRole('button', { name: /清除记忆/ }))
    expect(onResetMemory).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /确认清除/ }))
    expect(onResetMemory).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/记忆已清除/)).toBeTruthy()
  })

  it('清除记忆 confirm can be cancelled without firing the RPC', () => {
    const onResetMemory = vi.fn().mockResolvedValue({ ok: true })
    render(
      <CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} onResetMemory={onResetMemory} />,
    )

    fireEvent.click(screen.getByRole('button', { name: /清除记忆/ }))
    fireEvent.click(screen.getByRole('button', { name: /取消/ }))

    expect(onResetMemory).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /清除记忆/ })).toBeTruthy()
  })

  it('keeps unsaved edits when the parent re-renders an equivalent status snapshot', () => {
    const { rerender } = render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} />)

    fireEvent.click(screen.getByRole('radio', { name: /danger-full-access/ }))

    // A parent re-render that rebuilds the snapshot object without changing any
    // value must not throw away what the user just picked.
    rerender(<CodexPermissionsPanel status={{ ...baseStatus }} onApply={vi.fn()} />)

    expect(screen.getByRole('radio', { name: /danger-full-access/ })).toHaveProperty('checked', true)
    expect(screen.getByRole('button', { name: /应用设置/ })).toHaveProperty('disabled', false)
  })

  it('resyncs the draft when the status actually changes', () => {
    const { rerender } = render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} />)

    fireEvent.click(screen.getByRole('radio', { name: /danger-full-access/ }))
    rerender(
      <CodexPermissionsPanel status={{ ...baseStatus, sandboxMode: 'read-only' }} onApply={vi.fn()} />,
    )

    expect(screen.getByRole('radio', { name: /read-only/ })).toHaveProperty('checked', true)
    expect(screen.getByRole('button', { name: /应用设置/ })).toHaveProperty('disabled', true)
  })

  it('清除记忆 surfaces the error when the RPC fails', async () => {
    const onResetMemory = vi.fn().mockResolvedValue({ ok: false, error: 'Memory reset API unavailable' })
    render(
      <CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} onResetMemory={onResetMemory} />,
    )

    fireEvent.click(screen.getByRole('button', { name: /清除记忆/ }))
    fireEvent.click(screen.getByRole('button', { name: /确认清除/ }))

    expect(await screen.findByText(/Memory reset API unavailable/)).toBeTruthy()
  })
})

describe('CodexPermissionsPanel · Grok 服务端工具', () => {
  const mcpBox = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: /远程 MCP/ }) as HTMLTextAreaElement
  const xSearch = (): HTMLInputElement => screen.getByRole('checkbox', { name: /x_search/ }) as HTMLInputElement
  const codeExec = (): HTMLInputElement => screen.getByRole('checkbox', { name: /code_interpreter/ }) as HTMLInputElement
  const applyButton = (): HTMLButtonElement => screen.getByRole('button', { name: /应用设置/ }) as HTMLButtonElement
  const type = (text: string): void => { fireEvent.change(mcpBox(), { target: { value: text } }) }

  it('ships everything off when the status omits the fields (older main process)', () => {
    render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} />)

    expect(xSearch().checked).toBe(false)
    expect(codeExec().checked).toBe(false)
    expect(mcpBox().value).toBe('')
    expect(applyButton().disabled).toBe(true)
  })

  it('reflects the saved values from the status snapshot', () => {
    render(
      <CodexPermissionsPanel
        status={{
          ...baseStatus,
          grokXSearch: true,
          grokCodeInterpreter: true,
          grokRemoteMcp: [{ label: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' }],
        }}
        onApply={vi.fn()}
      />,
    )

    expect(xSearch().checked).toBe(true)
    expect(codeExec().checked).toBe(true)
    expect(mcpBox().value).toBe('deepwiki https://mcp.deepwiki.com/mcp')
    expect(applyButton().disabled).toBe(true)
  })

  it('puts only the toggled switch in the patch', () => {
    const onApply = vi.fn()
    render(<CodexPermissionsPanel status={baseStatus} onApply={onApply} />)

    fireEvent.click(xSearch())
    fireEvent.click(applyButton())
    expect(onApply).toHaveBeenLastCalledWith({ grokXSearch: true })

    cleanup()
    const second = vi.fn()
    render(<CodexPermissionsPanel status={baseStatus} onApply={second} />)
    fireEvent.click(codeExec())
    fireEvent.click(applyButton())
    expect(second).toHaveBeenCalledWith({ grokCodeInterpreter: true })
  })

  it('does not call the two switches "unsafe" (no confirmation banner)', () => {
    render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} />)

    fireEvent.click(xSearch())
    fireEvent.click(codeExec())

    expect(screen.queryByText(/高权限配置/)).toBeNull()
  })

  it('warns that X search will not be sent while web search is off', () => {
    render(<CodexPermissionsPanel status={{ ...baseStatus, webSearch: 'disabled' }} onApply={vi.fn()} />)
    expect(screen.queryByText(/X 搜索不会被发送/)).toBeNull()

    fireEvent.click(xSearch())
    expect(screen.getByText(/X 搜索不会被发送/)).toBeTruthy()
  })

  it('turns typed lines into a remote MCP list in the patch, and flags the confirm dialog', () => {
    const onApply = vi.fn()
    render(<CodexPermissionsPanel status={baseStatus} onApply={onApply} />)

    type('deepwiki https://mcp.deepwiki.com/mcp\nhttps://docs.example.com/mcp')

    expect(screen.getByText(/高权限配置/)).toBeTruthy()
    fireEvent.click(applyButton())
    expect(onApply).toHaveBeenCalledWith({
      grokRemoteMcp: [
        { label: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' },
        { label: 'docs_example_com', url: 'https://docs.example.com/mcp' },
      ],
    })
  })

  it('blocks Apply and names the bad line while the box has invalid content', () => {
    const onApply = vi.fn()
    render(<CodexPermissionsPanel status={baseStatus} onApply={onApply} />)

    // 别的改动是合法的,但文本框有写错的行 → 整个「应用」被拦住,不能悄悄丢掉那一框
    fireEvent.click(xSearch())
    type('ok https://ok.example.com/mcp\nbad http://plain.example.com/mcp')

    const errors = screen.getByTestId('grok-remote-mcp-errors')
    expect(errors.textContent).toMatch(/第 2 行/)
    expect(applyButton().disabled).toBe(true)
    fireEvent.click(applyButton())
    expect(onApply).not.toHaveBeenCalled()

    // 改对之后放行,而且两处改动一起提交
    type('ok https://ok.example.com/mcp')
    expect(screen.queryByTestId('grok-remote-mcp-errors')).toBeNull()
    expect(applyButton().disabled).toBe(false)
    fireEvent.click(applyButton())
    expect(onApply).toHaveBeenCalledWith({
      grokXSearch: true,
      grokRemoteMcp: [{ label: 'ok', url: 'https://ok.example.com/mcp' }],
    })
  })

  it('rejects internal and credentialed addresses right in the box', () => {
    render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} />)

    for (const line of [
      'a https://localhost/mcp',
      'a https://192.168.1.5/mcp',
      'a https://169.254.169.254/latest',
      'a https://user:pw@example.com/mcp',
    ]) {
      type(line)
      expect(screen.getByTestId('grok-remote-mcp-errors')).toBeTruthy()
      expect(applyButton().disabled).toBe(true)
    }
  })

  it('clearing a saved list applies as an empty array and does not trigger the confirm flag', () => {
    const onApply = vi.fn()
    render(
      <CodexPermissionsPanel
        status={{ ...baseStatus, grokRemoteMcp: [{ label: 'a', url: 'https://a.example.com/mcp' }] }}
        onApply={onApply}
      />,
    )

    type('')

    expect(screen.queryByText(/高权限配置/)).toBeNull()
    fireEvent.click(applyButton())
    expect(onApply).toHaveBeenCalledWith({ grokRemoteMcp: [] })
  })

  it('only flags the confirm dialog for addresses that are new relative to the saved list', () => {
    render(
      <CodexPermissionsPanel
        status={{ ...baseStatus, grokRemoteMcp: [{ label: 'a', url: 'https://a.example.com/mcp' }] }}
        onApply={vi.fn()}
      />,
    )

    // 改标签、加注释:地址没变 → 不弹
    type('# 备注\nrenamed https://a.example.com/mcp')
    expect(screen.queryByText(/高权限配置/)).toBeNull()

    // 多一个新地址 → 弹
    type('renamed https://a.example.com/mcp\nb https://b.example.com/mcp')
    expect(screen.getByText(/高权限配置/)).toBeTruthy()
  })

  it('treats comment-only / reformatted text as "no change" (Apply stays disabled)', () => {
    render(
      <CodexPermissionsPanel
        status={{ ...baseStatus, grokRemoteMcp: [{ label: 'a', url: 'https://a.example.com/mcp' }] }}
        onApply={vi.fn()}
      />,
    )

    type('# 注释\n\n   a     https://a.example.com/mcp   ')
    expect(applyButton().disabled).toBe(true)
  })

  it('keeps half-typed text when the parent re-renders with a value-identical snapshot', () => {
    const { rerender } = render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} />)
    type('half https://half')

    rerender(<CodexPermissionsPanel status={{ ...baseStatus }} onApply={vi.fn()} />)

    expect(mcpBox().value).toBe('half https://half')
  })

  it('adopts the new saved list (and resets the box) once the status changes', () => {
    const { rerender } = render(<CodexPermissionsPanel status={baseStatus} onApply={vi.fn()} />)
    type('a https://a.example.com/mcp')

    rerender(
      <CodexPermissionsPanel
        status={{ ...baseStatus, grokRemoteMcp: [{ label: 'a', url: 'https://a.example.com/mcp' }] }}
        onApply={vi.fn()}
      />,
    )

    expect(mcpBox().value).toBe('a https://a.example.com/mcp')
    expect(applyButton().disabled).toBe(true)
  })
})

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useTabStore } from '../../../stores'
import { TabBar } from '../TabBar'

describe('TabBar', () => {
  afterEach(() => {
    cleanup()
    useTabStore.setState({ activeTab: 'generate', previousTab: null })
  })

  it('renders Agent Workspace tab between 模板 and 设置', () => {
    render(<TabBar />)

    const labels = Array.from(document.querySelectorAll('nav button')).map((b) => b.textContent)
    const aw = labels.findIndex((l) => l?.includes('Agent Workspace'))
    const settings = labels.findIndex((l) => l?.includes('设置'))
    const tpl = labels.findIndex((l) => l?.includes('模板'))

    expect(tpl).toBeGreaterThanOrEqual(0)
    expect(aw).toBeGreaterThan(tpl)
    expect(aw).toBeLessThan(settings)
  })

  it('switches activeTab when Agent Workspace clicked', () => {
    render(<TabBar />)

    fireEvent.click(screen.getByText(/Agent Workspace/))

    expect(useTabStore.getState().activeTab).toBe('agentWorkspace')
  })

  it('renders the right-aligned AgentStatusButton slot', () => {
    render(<TabBar />)

    expect(document.querySelector('[data-testid="agent-status-button"]')).toBeTruthy()
  })
})

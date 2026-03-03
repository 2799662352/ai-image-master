import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LayoutSelector } from '../LayoutSelector'
import { useDirectorStore } from '../../stores/useDirectorStore'

describe('LayoutSelector', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    window.localStorage.clear()
    useDirectorStore.getState().reset()
  })

  it('shows keep-orientation hint when ratio is auto in auto mode', () => {
    const store = useDirectorStore.getState()
    store.setRatio('9:16')
    store.setRatio('auto')

    render(<LayoutSelector />)

    expect(screen.getByText('跟随比例：auto（保持当前方向）')).toBeTruthy()
  })

  it('shows manual override hint and can restore auto mode', () => {
    const store = useDirectorStore.getState()
    store.setRatio('16:9')
    store.setLayoutOrientation('portrait')

    render(<LayoutSelector />)

    expect(screen.getAllByText('手动覆盖方向中').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: '恢复跟随比例' }))
    expect(screen.getByText('跟随比例：16:9')).toBeTruthy()
  })

  it('clicking orientation button drives both layout and semantic orientation', () => {
    const store = useDirectorStore.getState()
    store.setRatio('16:9')

    render(<LayoutSelector />)
    fireEvent.click(screen.getByRole('button', { name: /竖屏/ }))

    const state = useDirectorStore.getState()
    expect(state.currentLayoutOrientation).toBe('portrait')
    expect(state.currentSemanticOrientation).toBe('portrait')
  })

  it('shows topology-unchanged hint for square grids', () => {
    const store = useDirectorStore.getState()
    store.setLayout('9grid')
    store.setLayoutOrientation('portrait')

    render(<LayoutSelector />)
    expect(screen.getByText(/拓扑不变/)).toBeTruthy()
  })

  it('does not show topology-unchanged hint for non-square grids', () => {
    const store = useDirectorStore.getState()
    store.setLayout('6grid')
    store.setLayoutOrientation('portrait')

    render(<LayoutSelector />)
    expect(screen.queryByText(/拓扑不变/)).toBeNull()
  })

  it('restoring auto mode restores both layout and semantic auto flags', () => {
    const store = useDirectorStore.getState()
    store.setRatio('16:9')
    store.setLayoutOrientation('portrait')
    store.setSemanticOrientation('portrait')

    render(<LayoutSelector />)
    fireEvent.click(screen.getByRole('button', { name: '恢复跟随比例' }))

    const state = useDirectorStore.getState()
    expect(state.isLayoutOrientationAuto).toBe(true)
    expect(state.isSemanticOrientationAuto).toBe(true)
    expect(state.currentLayoutOrientation).toBe('landscape')
    expect(state.currentSemanticOrientation).toBe('landscape')
  })
})

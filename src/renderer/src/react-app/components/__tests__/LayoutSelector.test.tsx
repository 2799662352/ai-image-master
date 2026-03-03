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
})

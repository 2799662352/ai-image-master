import { act } from 'react'
import { cleanup, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { mountStoryboardReact, unmountStoryboardReact, useStoryboardStore } from '../main'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('mountStoryboardReact', () => {
  afterEach(() => {
    cleanup()
    act(() => {
      unmountStoryboardReact()
    })
    useStoryboardStore.getState().resetProgress()
    document.body.innerHTML = ''
  })

  it('recreates the root when the container DOM node is replaced', () => {
    document.body.innerHTML = '<div id="storyboard-react-root"></div>'
    const first = document.getElementById('storyboard-react-root')
    if (!first) throw new Error('missing first container')

    act(() => {
      mountStoryboardReact(first)
    })

    document.body.innerHTML = '<div id="storyboard-react-root"></div>'
    const second = document.getElementById('storyboard-react-root')
    if (!second) throw new Error('missing second container')

    act(() => {
      mountStoryboardReact(second)
    })

    expect(second.textContent).toContain('启动中')
  })

  it('preserves storyboard state when remounting without reset', () => {
    useStoryboardStore.getState().setResult('formatted storyboard', '{\n  "ok": true\n}', { ok: true })

    document.body.innerHTML = '<div id="storyboard-react-root"></div>'
    const first = document.getElementById('storyboard-react-root')
    if (!first) throw new Error('missing first container')

    act(() => {
      mountStoryboardReact(first, { reset: false })
    })

    expect(screen.getByText('分镜数据')).toBeTruthy()
    expect(screen.getByText('formatted storyboard')).toBeTruthy()

    document.body.innerHTML = '<div id="storyboard-react-root"></div>'
    const second = document.getElementById('storyboard-react-root')
    if (!second) throw new Error('missing second container')

    act(() => {
      mountStoryboardReact(second, { reset: false })
    })

    expect(screen.getByText('分镜数据')).toBeTruthy()
    expect(screen.getByText('formatted storyboard')).toBeTruthy()
  })
})

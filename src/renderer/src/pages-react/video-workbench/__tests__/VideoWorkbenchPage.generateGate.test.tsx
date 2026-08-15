// 顶部工具条的两道闸:
//   ① 批量生成要二次确认 —— 一次误点烧掉的是整批额度,而这排按钮挨得很近;
//   ② 「允许 AI 自动生成」总开关 —— 关掉后 agent 不准替用户按生成。
//
// 用两步内联确认而不是 window.confirm:jsdom 里 window.confirm 被禁用,
// 与 BoardTabs 的删除确认保持同一套做法。

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_AUTO_START_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import VideoWorkbenchPage from '../../VideoWorkbenchPage'

function mockSubmit() {
  const submit = vi.fn(async () => ({ success: true, taskId: 'task-1' }))
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    videoWorkbench: { submit },
  }
  return submit
}

beforeEach(() => {
  localStorage.removeItem(AGENT_AUTO_START_KEY)
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('批量生成二次确认', () => {
  it('第一次点只是进入确认态,不提交', async () => {
    const submit = mockSubmit()
    act(() => {
      useVideoWorkbenchStore.getState().addCards([{ prompt: '猫' }, { prompt: '狗' }])
    })
    render(<VideoWorkbenchPage />)

    fireEvent.click(await screen.findByRole('button', { name: /全部生成/ }))

    expect(submit).not.toHaveBeenCalled()
    // 确认态要说清楚「要生成几张」——用户凭这个数字判断自己是不是点错了
    expect(await screen.findByRole('button', { name: /确认生成 2 张/ })).toBeTruthy()
  })

  it('再点一次才真的提交', async () => {
    const submit = mockSubmit()
    act(() => {
      useVideoWorkbenchStore.getState().addCards([{ prompt: '猫' }])
    })
    render(<VideoWorkbenchPage />)

    fireEvent.click(await screen.findByRole('button', { name: /全部生成/ }))
    fireEvent.click(await screen.findByRole('button', { name: /确认生成 1 张/ }))

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
  })

  it('确认态下卡片集合变了就撤销确认 —— 不能拿旧数字骗人', async () => {
    const submit = mockSubmit()
    act(() => {
      useVideoWorkbenchStore.getState().addCards([{ prompt: '猫' }])
    })
    render(<VideoWorkbenchPage />)

    fireEvent.click(await screen.findByRole('button', { name: /全部生成/ }))
    expect(await screen.findByRole('button', { name: /确认生成 1 张/ })).toBeTruthy()

    // agent 在这 3.5s 里又填了几张(人机同一块看板,这是常态)
    act(() => {
      useVideoWorkbenchStore.getState().addCards([{ prompt: '狗' }, { prompt: '鸟' }])
    })

    await waitFor(() => expect(screen.queryByRole('button', { name: /确认生成/ })).toBeNull())
    expect(submit).not.toHaveBeenCalled()
  })

  it('确认后按钮回到未确认态,不会连点两批', async () => {
    mockSubmit()
    act(() => {
      useVideoWorkbenchStore.getState().addCards([{ prompt: '猫' }])
    })
    render(<VideoWorkbenchPage />)

    fireEvent.click(await screen.findByRole('button', { name: /全部生成/ }))
    fireEvent.click(await screen.findByRole('button', { name: /确认生成 1 张/ }))

    await waitFor(() => expect(screen.queryByRole('button', { name: /确认生成/ })).toBeNull())
  })
})

describe('「允许 AI 自动生成」总开关', () => {
  it('默认开启;点击关闭并写 localStorage;再点开启', async () => {
    render(<VideoWorkbenchPage />)
    const toggle = await screen.findByRole('button', { name: /允许 AI 自动生成/ })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('false'))
    expect(useVideoWorkbenchStore.getState().agentAutoStart).toBe(false)
    expect(localStorage.getItem(AGENT_AUTO_START_KEY)).toBe('0')

    fireEvent.click(toggle)
    await waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('true'))
    expect(localStorage.getItem(AGENT_AUTO_START_KEY)).toBe('1')
  })
})

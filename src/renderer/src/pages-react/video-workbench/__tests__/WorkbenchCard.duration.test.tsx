// 时长下拉必须列出上游真正接受的每一个秒数。
//
// 此前只列了 4/5/6/8/10/12/15,而 `normalizeDuration` 收敛的是连续的 4–15,
// 于是 7/9/11/13/14 明明合法却选不到 —— 看起来像上游不支持,其实是选项表漏了。

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import VideoWorkbenchPage from '../../VideoWorkbenchPage'

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('卡片时长下拉', () => {
  it('列出 4–15 每一秒,外加智能时长', async () => {
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'x' }])
    useVideoWorkbenchStore.setState({ hydrated: true })
    render(<VideoWorkbenchPage />)

    const select = await screen.findByLabelText('时长')
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.value)

    expect(values).toEqual(['-1', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'])
  })

  // 上游 taskMode="edit" 的时长固定为 -1,列出来的每个秒数都是提交必被拒的。
  // 这条曾经真的发生过:界面给选 25s,点生成才收到「不能指定固定秒数」。
  it('编辑视频锁死智能时长:下拉只剩「智能」且禁用', async () => {
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'x', model: '2.5', mode: 'edit_video' }])
    useVideoWorkbenchStore.setState({ hydrated: true })
    render(<VideoWorkbenchPage />)

    const select = await screen.findByLabelText('时长')
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.value)

    expect(values).toEqual(['-1'])
    expect((select as HTMLSelectElement).disabled).toBe(true)
  })
})

// 工具条「已花费」读数:空看板不显示、可估算的卡累加、估不出的卡必须如实说出来
// (不说就等于给用户报一个偏低的数字)、跨页总额进 tooltip、口径与单卡同源。

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { VideoWorkbenchCard } from '../../../../../types/videoWorkbench'
import {
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import VideoWorkbenchPage from '../../VideoWorkbenchPage'

/**
 * 直接塞 store:绕开生成链路,只喂「已带 completionTokens 的终态卡」。
 *
 * `hydrated: true` 是必需的。addCards 会 persistNow 把**打补丁之前**的卡写进库,
 * 而页面挂载时的 ensureHydrated 会从库里读回来覆盖内存 —— completionTokens 就没了。
 * ensureHydrated 开头是 `if (get().hydrated) return`,置 true 即短路。
 */
function seed(patches: Array<Partial<VideoWorkbenchCard>>): void {
  const boardId = useVideoWorkbenchStore.getState().activeBoardId
  const ids = useVideoWorkbenchStore.getState().addCards(patches.map(() => ({ prompt: 'x' })))
  useVideoWorkbenchStore.setState({
    hydrated: true,
    cards: useVideoWorkbenchStore.getState().cards.map((c) => {
      const i = ids.indexOf(c.id)
      return i === -1 ? c : { ...c, boardId, status: 'succeeded', ...patches[i] }
    }),
  })
}

const readout = () => screen.queryByText(/已花费/)

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('工具条已花费读数', () => {
  it('没有可估算的卡时整块不出现 —— 不给空看板挂 $0.000', async () => {
    render(<VideoWorkbenchPage />)
    await screen.findByText(/张卡片/)
    expect(readout()).toBeNull()
  })

  it('draft / running 的卡不产生读数(还没花钱)', async () => {
    seed([{ status: 'draft' }, { status: 'running' }])
    render(<VideoWorkbenchPage />)
    await screen.findByText(/张卡片/)
    expect(readout()).toBeNull()
  })

  it('可估算的卡累加,口径与单卡一致(fast 720p 无视频 10k tokens = $0.056)', async () => {
    seed([
      { model: '2.0-fast', resolution: '720p', completionTokens: 10_000 },
      { model: '2.0-fast', resolution: '720p', completionTokens: 10_000 },
    ])
    render(<VideoWorkbenchPage />)
    await waitFor(() => expect(readout()).not.toBeNull())
    expect(readout()!.textContent).toContain('$0.112')
    expect(readout()!.textContent).not.toContain('未计入')
  })

  it('出了片但估不出价的卡必须如实计数,否则报的是偏低的数字', async () => {
    seed([
      { model: '2.0-fast', resolution: '720p', completionTokens: 10_000 },
      // 价目表没有 mini + 1080p 这个组合
      { model: '2.0-mini', resolution: '1080p', completionTokens: 10_000 },
      // 出片但上游没回传 token
      { model: '2.0', resolution: '720p', completionTokens: undefined },
    ])
    render(<VideoWorkbenchPage />)
    await waitFor(() => expect(readout()).not.toBeNull())
    const text = readout()!.textContent ?? ''
    expect(text).toContain('$0.056')
    expect(text).toContain('2 张未计入')
    expect(readout()!.getAttribute('title')).toContain('这是下限')
  })

  it('全部估不出时仍然出现读数(只是合计为 0),不能静默', async () => {
    seed([{ model: '2.0', resolution: '720p', completionTokens: undefined }])
    render(<VideoWorkbenchPage />)
    await waitFor(() => expect(readout()).not.toBeNull())
    expect(readout()!.textContent).toContain('1 张未计入')
  })

  it('别页的卡不进本页读数,但进 tooltip 的跨页总额', async () => {
    seed([{ model: '2.0-fast', resolution: '720p', completionTokens: 10_000 }])
    const other = useVideoWorkbenchStore.getState().addBoard('第二页')
    seed([{ model: '2.0-fast', resolution: '720p', completionTokens: 10_000 }])
    expect(useVideoWorkbenchStore.getState().activeBoardId).toBe(other)

    render(<VideoWorkbenchPage />)
    await waitFor(() => expect(readout()).not.toBeNull())
    // 本页只有一张
    expect(readout()!.textContent).toContain('$0.056')
    // tooltip 报两张的合计
    expect(readout()!.getAttribute('title')).toContain('$0.112')
  })

  it('含视频输入走更低单价(与单卡显示同源的 hasVideoInput 推导)', async () => {
    seed([
      {
        model: '2.0-fast',
        resolution: '720p',
        completionTokens: 10_000,
        mode: 'multimodal_ref',
        referenceVideos: [{ name: 'v.mp4', src: 'https://x/v.mp4' }],
      },
    ])
    render(<VideoWorkbenchPage />)
    await waitFor(() => expect(readout()).not.toBeNull())
    // 含视频 3.3 而非 5.6 → $0.033
    expect(readout()!.textContent).toContain('$0.033')
  })
})

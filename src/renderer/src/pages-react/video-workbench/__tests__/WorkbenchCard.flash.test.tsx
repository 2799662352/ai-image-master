// Seedance 2.5 Flash 在工作台卡片上的呈现:下拉里有它、时长 / 分辨率按能力表、没有样片开关。
//
// 能力表驱动的好处是 Flash 不需要自己的分支;这里钉的是「确实吃到了表」,
// 以及从 2.5 换到 Flash 时越界的分辨率会被就地收敛(1080p 只有 2.5 平台余额才有)。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { useQuotaStore } from '../../../stores/useQuotaStore'
import VideoWorkbenchPage from '../../VideoWorkbenchPage'

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})

afterEach(() => {
  cleanup()
  useQuotaStore.setState({ billingSource: 'own-key' })
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

type CardPatch = Parameters<ReturnType<typeof useVideoWorkbenchStore.getState>['addCards']>[0][number]

function renderCardWith(patch: CardPatch): void {
  useVideoWorkbenchStore.getState().addCards([{ prompt: 'x', ...patch }])
  useVideoWorkbenchStore.setState({ hydrated: true })
  render(<VideoWorkbenchPage />)
}

const optionValues = (select: HTMLElement) =>
  Array.from(select.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value)

describe('Seedance 2.5 Flash 卡片', () => {
  it('模型下拉里有 Flash,标签是「Seedance 2.5 Flash」,紧跟 2.5', async () => {
    renderCardWith({ model: '2.5-flash' })
    const select = (await screen.findByLabelText('模型')) as HTMLSelectElement
    const values = optionValues(select)
    expect(values).toContain('2.5-flash')
    expect(values.indexOf('2.5-flash')).toBe(values.indexOf('2.5') + 1)
    const label = Array.from(select.querySelectorAll('option')).find((o) => o.value === '2.5-flash')?.textContent
    expect(label).toBe('Seedance 2.5 Flash')
    expect(select.value).toBe('2.5-flash')
  })

  it('时长下拉到 30 秒(智能时长 + 4–30),不是 2.0 家族的 4–15', async () => {
    renderCardWith({ model: '2.5-flash' })
    const values = optionValues(await screen.findByLabelText('时长'))
    expect(values).toContain('-1')
    expect(values).toContain('30')
    expect(values).not.toContain('31')
    expect(values).toContain('4')
  })

  it('分辨率只有 480p / 720p —— 平台余额下也没有 1080p / 4k', async () => {
    useQuotaStore.setState({ billingSource: 'platform' })
    renderCardWith({ model: '2.5-flash' })
    const values = optionValues(await screen.findByLabelText('分辨率'))
    expect(values).toEqual(['480p', '720p'])
  })

  it('没有样片开关;2.5 有(对照,证明开关消失是 Flash 的缘故而不是页面没渲染好)', async () => {
    renderCardWith({ model: '2.5' })
    await screen.findByLabelText('模型')
    expect(screen.queryByTestId('vw-draft-toggle')).not.toBeNull()

    fireEvent.change(screen.getByLabelText('模型'), { target: { value: '2.5-flash' } })
    expect((screen.getByLabelText('模型') as HTMLSelectElement).value).toBe('2.5-flash')
    expect(screen.queryByTestId('vw-draft-toggle')).toBeNull()
  })

  it('从 2.5 的 1080p(平台余额)换到 Flash:分辨率就地收敛到 720p,不留越界值', async () => {
    useQuotaStore.setState({ billingSource: 'platform' })
    renderCardWith({ model: '2.5', resolution: '1080p' })
    await screen.findByLabelText('模型')
    expect((screen.getByLabelText('分辨率') as HTMLSelectElement).value).toBe('1080p')

    fireEvent.change(screen.getByLabelText('模型'), { target: { value: '2.5-flash' } })

    const card = useVideoWorkbenchStore.getState().cards[0]
    expect(card.model).toBe('2.5-flash')
    expect(card.resolution).toBe('720p')
  })
})

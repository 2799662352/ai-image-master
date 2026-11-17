// Seedance 2.5 Flash 在工作台卡片上的呈现:选择器里有它、时长 / 分辨率按能力表、没有样片开关。
//
// 能力表驱动的好处是 Flash 不需要自己的分支;这里钉的是「确实吃到了表」,
// 以及从 2.5 换到 Flash 时越界的分辨率会被就地收敛(1080p 只有 2.5 平台余额才有)。
//
// 模型不再是一个 <select>:2026-11-17 起是「渠道 → 模型」两级选择器(VideoModelPicker)。
// 这里通过它换模型 —— 换完之后的收敛逻辑(分辨率 / 时长 / 画幅)还是卡片自己的那一段,没有动。

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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

/** 打开卡片上的模型选择器,返回弹出的面板。 */
async function openModelPicker(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByTestId('vw-model-picker'))
  return screen.getByTestId('vw-model-panel')
}

/** 面板右栏当前列出的模型别名(按显示顺序)。 */
const listedModels = (panel: HTMLElement): string[] =>
  Array.from(panel.querySelectorAll<HTMLElement>('[data-vw-mp-option]')).map((el) => el.dataset.model ?? '')

/** 经选择器换模型:切到那个渠道,再点那一行。 */
async function pickModel(channel: string, model: string): Promise<void> {
  const panel = await openModelPicker()
  fireEvent.click(panel.querySelector<HTMLElement>(`[role="tab"][data-channel="${channel}"]`) as HTMLElement)
  fireEvent.click(panel.querySelector<HTMLElement>(`[data-vw-mp-option][data-model="${model}"]`) as HTMLElement)
}

describe('Seedance 2.5 Flash 卡片', () => {
  it('模型选择器里有 Flash,叫「Seedance 2.5 Flash」,在火山方舟一栏里紧跟 2.5', async () => {
    renderCardWith({ model: '2.5-flash' })
    // 按钮上写的就是当前模型。
    const trigger = await screen.findByTestId('vw-model-picker')
    expect(trigger.getAttribute('aria-label')).toBe('模型：Seedance 2.5 Flash')
    expect(trigger.textContent).toContain('Seedance 2.5 Flash')

    const panel = await openModelPicker()
    // 打开时停在当前模型所在的渠道。
    expect(within(panel).getByRole('tab', { selected: true }).dataset.channel).toBe('volcengine')
    const models = listedModels(panel)
    expect(models).toContain('2.5-flash')
    expect(models.indexOf('2.5-flash')).toBe(models.indexOf('2.5') + 1)
    const row = panel.querySelector<HTMLElement>('[data-vw-mp-option][data-model="2.5-flash"]') as HTMLElement
    expect(row.querySelector('.vw-mp-opt__name')?.textContent).toBe('Seedance 2.5 Flash')
    expect(row.getAttribute('aria-current')).toBe('true')
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
    await screen.findByTestId('vw-model-picker')
    expect(screen.queryByTestId('vw-draft-toggle')).not.toBeNull()

    await pickModel('volcengine', '2.5-flash')
    expect(screen.getByTestId('vw-model-picker').getAttribute('aria-label')).toBe('模型：Seedance 2.5 Flash')
    expect(screen.queryByTestId('vw-draft-toggle')).toBeNull()
  })

  it('从 2.5 的 1080p(平台余额)换到 Flash:分辨率就地收敛到 720p,不留越界值', async () => {
    useQuotaStore.setState({ billingSource: 'platform' })
    renderCardWith({ model: '2.5', resolution: '1080p' })
    await screen.findByTestId('vw-model-picker')
    expect((screen.getByLabelText('分辨率') as HTMLSelectElement).value).toBe('1080p')

    await pickModel('volcengine', '2.5-flash')

    const card = useVideoWorkbenchStore.getState().cards[0]
    expect(card.model).toBe('2.5-flash')
    expect(card.resolution).toBe('720p')
  })
})

/**
 * Roneyun-cn 渠道(`cn-seedance-*`)在卡片上:与火山同名模型同一套规格,样片开关也在。
 * 这里只钉「卡片吃到了能力表」的几处 —— 选择器本身的交互在 VideoModelPicker.test.tsx。
 */
describe('Roneyun-cn 渠道的卡片', () => {
  it('从火山 2.0 换到 Roneyun-cn 的 2.5:卡上记的是 cn-seedance-2.5,按钮带渠道名', async () => {
    renderCardWith({ model: '2.0' })
    await pickModel('roneyun-cn', 'cn-seedance-2.5')

    expect(useVideoWorkbenchStore.getState().cards[0].model).toBe('cn-seedance-2.5')
    expect(screen.getByTestId('vw-model-picker').getAttribute('aria-label')).toBe('模型：Seedance 2.5 · Roneyun-cn')
    // 选完面板就收起。
    expect(screen.queryByTestId('vw-model-panel')).toBeNull()
  })

  /**
   * 样片开关:火山 2.5 有,Roneyun-cn 的 2.5 没有 —— 网关(new-api #203)在预扣前就拒 draft。
   * 联网开关同理:卡片的联网默认是开的,这条渠道的卡片上不该出现那个开关(也不会带 tools)。
   */
  it('cn-seedance-2.5 与火山 2.5 同规格(时长 30 秒、平台余额下 1080p / 4k),但没有样片开关、没有联网开关', async () => {
    useQuotaStore.setState({ billingSource: 'platform' })
    renderCardWith({ model: 'cn-seedance-2.5' })

    const durations = optionValues(await screen.findByLabelText('时长'))
    expect(durations).toContain('30')
    expect(durations).not.toContain('31')
    expect(optionValues(screen.getByLabelText('分辨率'))).toEqual(['480p', '720p', '1080p', '4k'])
    expect(screen.queryByTestId('vw-draft-toggle')).toBeNull()
    expect(screen.queryByLabelText(/联网/)).toBeNull()
  })

  it('对照:火山 2.5 的卡片有样片开关与联网开关(证明上一条的「没有」不是页面没渲染好)', async () => {
    useQuotaStore.setState({ billingSource: 'platform' })
    renderCardWith({ model: '2.5' })

    await screen.findByTestId('vw-model-picker')
    expect(screen.queryByTestId('vw-draft-toggle')).not.toBeNull()
    expect(screen.queryByLabelText(/联网/)).not.toBeNull()
  })

  it('cn-seedance-2.0-fast 与火山 2.0 Fast 同规格:时长到 15 秒,只有 480p / 720p,没有样片开关', async () => {
    useQuotaStore.setState({ billingSource: 'platform' })
    renderCardWith({ model: 'cn-seedance-2.0-fast' })

    const durations = optionValues(await screen.findByLabelText('时长'))
    expect(durations).toContain('15')
    expect(durations).not.toContain('16')
    expect(optionValues(screen.getByLabelText('分辨率'))).toEqual(['480p', '720p'])
    expect(screen.queryByTestId('vw-draft-toggle')).toBeNull()
  })

  it('从 cn-seedance-2.5 的 30 秒换回火山 2.0:时长就地收敛到 15 秒', async () => {
    renderCardWith({ model: 'cn-seedance-2.5', duration: 30 })
    await pickModel('volcengine', '2.0')

    const card = useVideoWorkbenchStore.getState().cards[0]
    expect(card.model).toBe('2.0')
    expect(card.duration).toBe(15)
  })
})

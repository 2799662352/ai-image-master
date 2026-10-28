// 可灵分镜编辑器:三态切换、镜头增删、时长对账提示。组件只管把状态画出来并把改动交给 onChange,
// 规则(镜头数 / 描述长度 / 时长之和)由 types/klingMultiShot 负责,这里不重测。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KlingMultiShot } from '../../../../../types/klingMultiShot'
import { KlingMultiShotEditor } from '../KlingMultiShotEditor'
import VideoWorkbenchPage from '../../VideoWorkbenchPage'
import {
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

const SHOTS: KlingMultiShot = {
  type: 'customize',
  shots: [
    { prompt: '雨夜街头', duration: 2 },
    { prompt: '雨滴特写', duration: 3 },
  ],
}

function renderEditor(over: Partial<React.ComponentProps<typeof KlingMultiShotEditor>> = {}) {
  const onChange = vi.fn()
  render(<KlingMultiShotEditor multiShot={undefined} duration={5} busy={false} onChange={onChange} {...over} />)
  return onChange
}

describe('KlingMultiShotEditor · 模式切换', () => {
  it('默认是「单镜头」,不展开任何镜头', () => {
    renderEditor()
    expect((screen.getByLabelText('分镜') as HTMLSelectElement).value).toBe('single')
    expect(screen.queryByLabelText('镜头 1 描述')).toBeNull()
  })

  it('切到智能分镜:交出 {type:intelligence}', () => {
    const onChange = renderEditor()
    fireEvent.change(screen.getByLabelText('分镜'), { target: { value: 'intelligence' } })
    expect(onChange).toHaveBeenCalledWith({ type: 'intelligence' })
  })

  it('切到自定义分镜:两个镜头平分总时长,描述留空', () => {
    const onChange = renderEditor({ duration: 7 })
    fireEvent.change(screen.getByLabelText('分镜'), { target: { value: 'customize' } })
    expect(onChange).toHaveBeenCalledWith({
      type: 'customize',
      shots: [
        { prompt: '', duration: 4 },
        { prompt: '', duration: 3 },
      ],
    })
  })

  it('切回单镜头:交出 null(清除)', () => {
    const onChange = renderEditor({ multiShot: SHOTS })
    fireEvent.change(screen.getByLabelText('分镜'), { target: { value: 'single' } })
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('重复选当前模式不触发任何写入', () => {
    const onChange = renderEditor({ multiShot: { type: 'intelligence' } })
    fireEvent.change(screen.getByLabelText('分镜'), { target: { value: 'intelligence' } })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('生成中整块禁用', () => {
    renderEditor({ multiShot: SHOTS, busy: true })
    expect((screen.getByLabelText('分镜') as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByLabelText('镜头 1 描述') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByLabelText('镜头 1 时长(秒)') as HTMLInputElement).disabled).toBe(true)
  })
})

describe('KlingMultiShotEditor · 自定义镜头', () => {
  it('改描述 / 改时长:只改那一个镜头,其余原样', () => {
    const onChange = renderEditor({ multiShot: SHOTS })
    fireEvent.change(screen.getByLabelText('镜头 2 描述'), { target: { value: '改过的描述' } })
    expect(onChange).toHaveBeenLastCalledWith({
      type: 'customize',
      shots: [SHOTS.type === 'customize' ? SHOTS.shots[0] : { prompt: '', duration: 0 }, { prompt: '改过的描述', duration: 3 }],
    })
    fireEvent.change(screen.getByLabelText('镜头 1 时长(秒)'), { target: { value: '4' } })
    expect(onChange).toHaveBeenLastCalledWith({
      type: 'customize',
      shots: [{ prompt: '雨夜街头', duration: 4 }, { prompt: '雨滴特写', duration: 3 }],
    })
  })

  it('清空时长记 0(校验会如实说这一镜时长不对),小数取整', () => {
    const onChange = renderEditor({ multiShot: SHOTS })
    fireEvent.change(screen.getByLabelText('镜头 1 时长(秒)'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith({
      type: 'customize',
      shots: [{ prompt: '雨夜街头', duration: 0 }, { prompt: '雨滴特写', duration: 3 }],
    })
    fireEvent.change(screen.getByLabelText('镜头 1 时长(秒)'), { target: { value: '2.9' } })
    expect(onChange).toHaveBeenLastCalledWith({
      type: 'customize',
      shots: [{ prompt: '雨夜街头', duration: 2 }, { prompt: '雨滴特写', duration: 3 }],
    })
  })

  it('加一个镜头:从最长的镜头借 1 秒,合计不变', () => {
    const onChange = renderEditor({ multiShot: SHOTS })
    fireEvent.click(screen.getByText(/加一个镜头/))
    expect(onChange).toHaveBeenCalledWith({
      type: 'customize',
      shots: [
        { prompt: '雨夜街头', duration: 2 },
        { prompt: '雨滴特写', duration: 2 },
        { prompt: '', duration: 1 },
      ],
    })
  })

  it('满 6 个镜头:加号禁用', () => {
    const six: KlingMultiShot = {
      type: 'customize',
      shots: Array.from({ length: 6 }, (_, i) => ({ prompt: `镜头${i}`, duration: 1 })),
    }
    renderEditor({ multiShot: six, duration: 6 })
    expect((screen.getByText(/加一个镜头/).closest('button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('删镜头:时长并给前一个;只剩 1 个时删除键禁用', () => {
    const onChange = renderEditor({ multiShot: SHOTS })
    fireEvent.click(screen.getByLabelText('删除镜头 2'))
    expect(onChange).toHaveBeenCalledWith({ type: 'customize', shots: [{ prompt: '雨夜街头', duration: 5 }] })

    cleanup()
    renderEditor({ multiShot: { type: 'customize', shots: [{ prompt: 'a', duration: 5 }] } })
    expect((screen.getByLabelText('删除镜头 1') as HTMLButtonElement).disabled).toBe(true)
  })

  it('合计对得上总时长:不报差额;对不上:写明多 / 少几秒', () => {
    renderEditor({ multiShot: SHOTS, duration: 5 })
    expect(screen.getByTestId('vw-shot-sum').textContent).toBe('合计 5s / 总时长 5s')

    cleanup()
    renderEditor({ multiShot: SHOTS, duration: 8 })
    expect(screen.getByTestId('vw-shot-sum').textContent).toContain('少 3s')

    cleanup()
    renderEditor({ multiShot: SHOTS, duration: 4 })
    expect(screen.getByTestId('vw-shot-sum').textContent).toContain('多 1s')
  })

  it('描述接近 / 超过 512 字时才显示字数;不截断用户输入', () => {
    renderEditor({ multiShot: { type: 'customize', shots: [{ prompt: '短', duration: 5 }] } })
    expect(screen.queryByText(/\/ 512 字/)).toBeNull()

    cleanup()
    renderEditor({ multiShot: { type: 'customize', shots: [{ prompt: 'x'.repeat(513), duration: 5 }] } })
    expect(screen.getByText('513 / 512 字')).toBeTruthy()
    expect((screen.getByLabelText('镜头 1 描述') as HTMLTextAreaElement).value).toHaveLength(513)
  })
})

describe('卡片上的分镜入口(接进 WorkbenchCard)', () => {
  async function renderCard(model: string) {
    resetWorkbenchStoreForTest()
    resetWorkbenchDbForTest()
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'x', model: model as never }])
    useVideoWorkbenchStore.setState({ hydrated: true })
    render(<VideoWorkbenchPage />)
  }

  it('可灵卡有分镜下拉;选自定义分镜后卡片上长出镜头,且总提示词留空也能点「生成」', async () => {
    await renderCard('kling4')
    const select = await screen.findByLabelText('分镜')
    fireEvent.change(select, { target: { value: 'customize' } })
    const card = useVideoWorkbenchStore.getState().cards[0]
    expect(card.multiShot?.type).toBe('customize')
    expect(await screen.findByLabelText('镜头 1 描述')).toBeTruthy()
  })

  it('Seedance 卡没有分镜入口', async () => {
    await renderCard('2.0')
    await screen.findByLabelText('时长')
    expect(screen.queryByLabelText('分镜')).toBeNull()
  })
})

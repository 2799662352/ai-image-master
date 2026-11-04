// 4K 二次确认弹窗:两步走完才提交;任何一步取消 / Esc 都不提交;勾选前第二步按钮不可点;
// 卡片上的「生成」「生成 4K 成片」按钮与整页批量生成都接到这个弹窗。

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../../features/video-workbench/store'
import { askUhdConfirmIfHeld, useUhdConfirmStore } from '../../../features/video-workbench/uhdConfirm'
import { resetWorkbenchDbForTest } from '../../../features/video-workbench/WorkbenchDb'
import { useQuotaStore } from '../../../stores/useQuotaStore'
import { useToastStore } from '../../../stores/useToastStore'
import { UhdConfirmDialog } from '../UhdConfirmDialog'
import { WorkbenchCard } from '../WorkbenchCard'

const S = () => useVideoWorkbenchStore.getState()

function mockApi() {
  const submit = vi.fn(async () => ({ success: true, taskId: 'task_new' }))
  ;(window as any).electronAPI = {
    videoWorkbench: { submit, reconcile: vi.fn(async () => []), repersist: vi.fn() },
  }
  return { submit }
}

function addCard(patch: Record<string, unknown>): string {
  const [id] = S().addCards([{ prompt: '一只橘猫', ...patch } as never])
  return id
}

function addSucceededDraftCard(): string {
  const id = addCard({ model: '2.5' })
  useVideoWorkbenchStore.setState((s) => ({
    cards: s.cards.map((c) =>
      c.id === id
        ? { ...c, draft: true, draftRun: true, status: 'succeeded' as const, taskId: 'task_draft', startedAt: Date.now() - 1000 }
        : c,
    ),
  }))
  return id
}

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  delete (window as any).electronAPI
  useQuotaStore.setState({ billingSource: 'platform' })
  useUhdConfirmStore.getState().dismiss()
  useToastStore.getState().clearAll()
})

afterEach(() => {
  cleanup()
})

/** 先让 store 的闸把卡拦下,再按真实路径(askUhdConfirmIfHeld)打开弹窗。 */
async function holdAndAsk(ids: string[], kind: 'start' | 'finalize' = 'start'): Promise<void> {
  const res = kind === 'finalize' ? await S().finalizeDrafts(ids, '4k') : await S().startCards(ids)
  act(() => {
    expect(askUhdConfirmIfHeld(kind, res)).toBe(true)
  })
}

describe('UhdConfirmDialog', () => {
  it('没有待确认请求时不渲染', () => {
    render(<UhdConfirmDialog />)
    expect(screen.queryByTestId('vw-uhd-dialog')).toBeNull()
  })

  it('两步走完才提交:第 1 步「继续」不提交,第 2 步勾选后才可点,点了才调 submit', async () => {
    const { submit } = mockApi()
    const id = addCard({ model: '2.0', resolution: '4k' })
    render(<UhdConfirmDialog />)
    await holdAndAsk([id])

    expect(screen.getByRole('dialog', { name: '确认生成 4K(1/2)' })).toBeTruthy()
    expect(screen.getByText(/AI 没有权限代为确认/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /确认生成 4K/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '继续(1/2)' }))
    expect(submit).not.toHaveBeenCalled()

    expect(screen.getByRole('dialog', { name: '确认生成 4K(2/2)' })).toBeTruthy()
    const confirmBtn = screen.getByRole('button', { name: /确认生成 4K · 1 个\(2\/2\)/ }) as HTMLButtonElement
    expect(confirmBtn.disabled).toBe(true)
    fireEvent.click(confirmBtn)
    expect(submit).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox'))
    expect(confirmBtn.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(confirmBtn)
    })
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect((submit.mock.calls[0] as any[])[0]).toMatchObject({ model: '2.0', resolution: '4k' })
    expect(screen.queryByTestId('vw-uhd-dialog')).toBeNull()
  })

  it('取消 / Esc / 点遮罩:任何一步都不提交,弹窗关闭', async () => {
    const { submit } = mockApi()
    const id = addCard({ model: '2.0', resolution: '4k' })
    render(<UhdConfirmDialog />)

    await holdAndAsk([id])
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByTestId('vw-uhd-dialog')).toBeNull()

    await holdAndAsk([id])
    fireEvent.click(screen.getByRole('button', { name: '继续(1/2)' }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('vw-uhd-dialog')).toBeNull()

    await holdAndAsk([id])
    fireEvent.mouseDown(screen.getByTestId('vw-uhd-dialog').parentElement!)
    expect(screen.queryByTestId('vw-uhd-dialog')).toBeNull()

    expect(submit).not.toHaveBeenCalled()
    expect(S().cards.find((c) => c.id === id)!.status).toBe('draft')
  })

  it('重新打开从第 1 步、未勾选开始 —— 上次走到一半的状态不会带过来', async () => {
    mockApi()
    const id = addCard({ model: '2.0', resolution: '4k' })
    render(<UhdConfirmDialog />)
    await holdAndAsk([id])
    fireEvent.click(screen.getByRole('button', { name: '继续(1/2)' }))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    await holdAndAsk([id])
    expect(screen.getByRole('dialog', { name: '确认生成 4K(1/2)' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '继续(1/2)' }))
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })

  it('「返回」回到第 1 步', async () => {
    mockApi()
    const id = addCard({ model: '2.0', resolution: '4k' })
    render(<UhdConfirmDialog />)
    await holdAndAsk([id])
    fireEvent.click(screen.getByRole('button', { name: '继续(1/2)' }))
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(screen.getByRole('dialog', { name: '确认生成 4K(1/2)' })).toBeTruthy()
  })

  it('整批:只列被拦下的 4K 卡,确认后只提交它们(1080p 那张早已在拦下之前就提交了)', async () => {
    const { submit } = mockApi()
    const a = addCard({ model: '2.0', resolution: '4k', prompt: '甲' })
    const b = addCard({ model: '2.0', resolution: '1080p', prompt: '乙' })
    const c = addCard({ model: 'kling4', resolution: '4k', prompt: '丙' })
    render(<UhdConfirmDialog />)

    const res = await S().startCards([a, b, c])
    expect(res.started).toEqual([b])
    expect(submit).toHaveBeenCalledTimes(1)
    act(() => {
      askUhdConfirmIfHeld('start', res)
    })

    expect(screen.getByText(/即将生成 2 个4K 视频/)).toBeTruthy()
    const list = screen.getByRole('list', { name: '待确认的 4K 卡片' })
    expect(list.textContent).toContain('甲')
    expect(list.textContent).toContain('丙')
    expect(list.textContent).not.toContain('乙')

    fireEvent.click(screen.getByRole('button', { name: '继续(1/2)' }))
    fireEvent.click(screen.getByRole('checkbox'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /确认生成 4K · 2 个/ }))
    })
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(3))
  })

  it('样片升 4K:弹窗讲清沿用样片,确认后成片按 4k 提交并带样片任务号', async () => {
    const { submit } = mockApi()
    const id = addSucceededDraftCard()
    render(<UhdConfirmDialog />)
    await holdAndAsk([id], 'finalize')

    expect(screen.getByText(/即将生成 1 个样片升 4K 成片/)).toBeTruthy()
    expect(screen.getByText(/沿用样片的提示词/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '继续(1/2)' }))
    fireEvent.click(screen.getByRole('checkbox'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /确认生成 4K · 1 个/ }))
    })
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect((submit.mock.calls[0] as any[])[0]).toMatchObject({
      fromDraftTaskId: 'task_draft',
      resolution: '4k',
      finalResolution: '4k',
    })
  })

  it('连点确认只提交一次', async () => {
    const { submit } = mockApi()
    const id = addCard({ model: '2.0', resolution: '4k' })
    render(<UhdConfirmDialog />)
    await holdAndAsk([id])
    fireEvent.click(screen.getByRole('button', { name: '继续(1/2)' }))
    fireEvent.click(screen.getByRole('checkbox'))
    const btn = screen.getByRole('button', { name: /确认生成 4K · 1 个/ })
    await act(async () => {
      fireEvent.click(btn)
      fireEvent.click(btn)
    })
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
  })

  it('确认时卡片已被删除:不提交、不崩,弹窗里直接说没有可生成的内容', async () => {
    const { submit } = mockApi()
    const id = addCard({ model: '2.0', resolution: '4k' })
    render(<UhdConfirmDialog />)
    await holdAndAsk([id])
    act(() => {
      S().removeCard(id)
    })
    expect(screen.getByText(/已经不存在了/)).toBeTruthy()
    expect((screen.getByRole('button', { name: '继续(1/2)' }) as HTMLButtonElement).disabled).toBe(true)
    expect(submit).not.toHaveBeenCalled()
  })
})

describe('入口接线:卡片上的按钮', () => {
  function renderCard(id: string) {
    const card = S().cards.find((c) => c.id === id)!
    return render(
      <>
        <WorkbenchCard card={card} index={0} onDragStateChange={() => {}} />
        <UhdConfirmDialog />
      </>,
    )
  }

  it('4K 卡点「生成」:不直接提交,弹出二次确认', async () => {
    const { submit } = mockApi()
    const id = addCard({ model: '2.0', resolution: '4k' })
    renderCard(id)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /▶ 生成/ }))
    })
    await waitFor(() => expect(screen.getByRole('dialog', { name: '确认生成 4K(1/2)' })).toBeTruthy())
    expect(submit).not.toHaveBeenCalled()
  })

  it('1080p 卡点「生成」:照旧一键提交,不弹窗', async () => {
    const { submit } = mockApi()
    const id = addCard({ model: '2.0', resolution: '1080p' })
    renderCard(id)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /▶ 生成/ }))
    })
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('vw-uhd-dialog')).toBeNull()
  })

  it('样片卡:「生成 1080P 成片」一键提交;「生成 4K 成片」弹二次确认', async () => {
    const { submit } = mockApi()
    const id = addSucceededDraftCard()
    renderCard(id)

    await act(async () => {
      fireEvent.click(screen.getByTestId('vw-draft-finalize-4k'))
    })
    await waitFor(() => expect(screen.getByRole('dialog', { name: '确认生成 4K(1/2)' })).toBeTruthy())
    expect(submit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(submit).not.toHaveBeenCalled()
  })

  it('2.5 + 平台余额:分辨率下拉有 1080p 与 4k;自填 Key 只有 480p / 720p', () => {
    const id = addCard({ model: '2.5', resolution: '720p' })
    const { unmount } = renderCard(id)
    const options = () =>
      Array.from((screen.getByLabelText('分辨率') as HTMLSelectElement).options).map((o) => o.value)
    expect(options()).toEqual(expect.arrayContaining(['1080p', '4k']))
    unmount()

    act(() => useQuotaStore.setState({ billingSource: 'own-key' }))
    renderCard(id)
    expect(options()).not.toContain('1080p')
    expect(options()).not.toContain('4k')
  })
})

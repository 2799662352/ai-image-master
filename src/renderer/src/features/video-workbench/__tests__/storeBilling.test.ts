// 工作台提交把「这一次的钱从哪出」带给主进程。
//
// 这是整条链路的**源头**。主进程刻意不自己猜:它手上那份 activePool 只是渲染层
// `billingSource` 的镜像,而 `setBillingSource('own-key')` 先落本地状态、再尽力调
// `clearBillingPool()`,那一步失败时被吞掉 —— 于是存在一个窗口:渲染层已经是
// 自填 Key,主进程仍握着 activePool。此时让主进程去猜,猜出来的是平台余额,
// 用户在不知情的情况下花掉组织的钱。(见 seedanceGateway/credentials.ts。)
//
// 所以这里守两件事:提交载荷里有意向,以及卡片记住了它 —— 重启对账与「重新保存」
// 都要拿它去打回同一条通道,否则上游一律回「任务不存在」。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../store'
import { resetWorkbenchDbForTest } from '../WorkbenchDb'
import { useQuotaStore } from '../../../stores/useQuotaStore'

function mockApi() {
  const submit = vi.fn(async () => ({ success: true, taskId: 'task-1' }))
  const reconcile = vi.fn(async () => [])
  const repersist = vi.fn(async () => ({ ok: true, localPath: 'D:/v.mp4' }))
  ;(window as any).electronAPI = { videoWorkbench: { submit, reconcile, repersist } }
  return { submit, reconcile, repersist }
}

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  delete (window as any).electronAPI
  useQuotaStore.setState({ billingSource: 'own-key' })
})

describe('提交载荷带上渲染层的计费来源', () => {
  it('平台余额模式下提交带 billing: platform', async () => {
    const { submit } = mockApi()
    useQuotaStore.setState({ billingSource: 'platform' })
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: '一只橘猫' }])

    await useVideoWorkbenchStore.getState().startCards([id])

    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0][0]).toMatchObject({ billing: 'platform' })
  })

  it('自填 Key 模式下同样显式带 —— 不靠「不传 = 自填」的默契', async () => {
    // 缺省在主进程那头意味着「你自己猜」,而那正是我们要避开的。渲染层知道答案
    // 的时候就该把答案说出来。
    const { submit } = mockApi()
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: '一只橘猫' }])

    await useVideoWorkbenchStore.getState().startCards([id])

    expect(submit.mock.calls[0][0]).toMatchObject({ billing: 'own-key' })
  })

  it('提交那一刻现读,不是卡片创建时的旧值', async () => {
    const { submit } = mockApi()
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: '一只橘猫' }])
    // 卡片建好之后用户才去启用平台余额。
    useQuotaStore.setState({ billingSource: 'platform' })

    await useVideoWorkbenchStore.getState().startCards([id])

    expect(submit.mock.calls[0][0]).toMatchObject({ billing: 'platform' })
  })
})

describe('卡片记住这一轮用的计费模式', () => {
  it('提交后写进卡片', async () => {
    mockApi()
    useQuotaStore.setState({ billingSource: 'platform' })
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: '一只橘猫' }])

    await useVideoWorkbenchStore.getState().startCards([id])

    expect(useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)?.billing).toBe(
      'platform',
    )
  })

  it('重启对账把它送回主进程 —— 否则平台任务会被拿自填 Key 去问,当场错杀', async () => {
    const { reconcile } = mockApi()
    useQuotaStore.setState({ billingSource: 'platform' })
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: '一只橘猫' }])
    await useVideoWorkbenchStore.getState().startCards([id])

    await useVideoWorkbenchStore.getState().reconcileInFlight()

    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(reconcile.mock.calls[0][0][0]).toMatchObject({
      taskId: 'task-1',
      billing: 'platform',
    })
  })

  it('「重新保存」也带上 —— 重查地址是上游链接过期后唯一不花钱的补救', async () => {
    const { repersist } = mockApi()
    useQuotaStore.setState({ billingSource: 'platform' })
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: '一只橘猫' }])
    await useVideoWorkbenchStore.getState().startCards([id])

    await useVideoWorkbenchStore.getState().resaveCard(id)

    expect(repersist).toHaveBeenCalledTimes(1)
    expect(repersist.mock.calls[0][0]).toMatchObject({ billing: 'platform' })
  })

  it('重新生成时按当时的计费来源刷新,不留上一轮的旧值', async () => {
    const { submit } = mockApi()
    useQuotaStore.setState({ billingSource: 'platform' })
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: '一只橘猫' }])
    await useVideoWorkbenchStore.getState().startCards([id])

    // 「重新生成」只在终态卡片上可点(canStart 会挡住进行中的)。
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) => (c.id === id ? { ...c, status: 'failed' as const } : c)),
    }))
    useQuotaStore.setState({ billingSource: 'own-key' })
    await useVideoWorkbenchStore.getState().startCards([id])

    expect(submit.mock.calls[1][0]).toMatchObject({ billing: 'own-key' })
    expect(useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)?.billing).toBe(
      'own-key',
    )
  })
})

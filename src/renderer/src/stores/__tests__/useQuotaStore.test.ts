// 账号额度的渲染层状态。
//
// 这里刻意通过 mock 掉的 `window.electronAPI.auth` 断言,而不是 spy store 内部 ——
// 值全在「点了之后主进程收到了什么」和「信封错误有没有被正确摊开」,后者是最容易
// 写错的一层(主进程刻意回 { ok, error } 而不是裸抛,store 若不摊开就会把整个信封
// 当成数据渲染)。
//
// 三条最值得测的:
// - **池键是一对** `(projectId, producerProjectId)`,只比对一半会把两个池当成同一个;
// - 个人计费落点必须来自后端 payment config,不能硬编码;
// - 未加入的池(`joined: false`)不能被选中 —— 没有 allocation 行就没有影子账户可扣。

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { useQuotaStore, __resetQuotaStoreForTesting } from '../useQuotaStore'

const auth = {
  getOrganizations: vi.fn(),
  getBalance: vi.fn(),
  getQuota: vi.fn(),
  getPaymentConfig: vi.fn(),
}

const ORG_PERSONAL = {
  id: 342,
  name: '个人计费',
  studioName: null,
  balanceYuan: 0.26,
  joined: true,
}
/** 两个 producer 池**共用同一个 projectId** —— 这是池键必须成对的原因。 */
const ORG_PRODUCER_A = {
  id: 700,
  name: 'Seedance A',
  studioName: 'S',
  balanceYuan: 12,
  joined: true,
  producerProjectId: 5,
}
const ORG_PRODUCER_B = {
  id: 700,
  name: 'Seedance B',
  studioName: 'S',
  balanceYuan: 34,
  joined: true,
  producerProjectId: 6,
}
const ORG_NOT_JOINED = {
  id: 900,
  name: '未加入的池',
  studioName: 'S',
  balanceYuan: 0,
  joined: false,
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', { value: { auth }, configurable: true })
  Object.values(auth).forEach((m) => m.mockReset())
  auth.getOrganizations.mockResolvedValue({ ok: true, data: [ORG_PERSONAL] })
  auth.getBalance.mockResolvedValue({ ok: true, data: { balanceYuan: 0.26, balanceQuota: 130_000 } })
  auth.getQuota.mockResolvedValue({ ok: true, data: {} })
  auth.getPaymentConfig.mockResolvedValue({ ok: true, data: { personalBillingProjectId: 342 } })

  localStorage.clear()
  __resetQuotaStoreForTesting()
  useQuotaStore.setState(useQuotaStore.getInitialState(), true)
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  localStorage.clear()
})

describe('useQuotaStore', () => {
  // 🚨 抛出的异常绝不能逃出 store 变成未处理 rejection。
  //
  // 调用点是组件里的 `void loadQuota()` —— 没有 catch。任何 throw 都会成为一个
  // unhandled rejection:vitest 会因此**判整轮失败**(哪怕每条断言都过),而在生产里
  // 用户什么提示都看不到,只有控制台一行红字。
  //
  // 触发路径不止「网络挂了」:`getApi()` 只挡住「整个桥没挂上」,挡不住「桥在但某个
  // 方法不存在」—— 那时 `api.getOrganizations()` 是同步的 TypeError。实测撞到过:
  // 一个既有测试的假桥只 mock 了登录相关方法,于是 4 条 unhandled rejection 把整轮
  // 474 个通过的测试判成红的。
  describe('异常不许逃出去', () => {
    it('某个方法压根不存在时,落到 error 而不是 reject', async () => {
      Object.defineProperty(window, 'electronAPI', {
        // 故意只给一半:这正是那个既有测试的假桥形状。
        value: { auth: { getPaymentConfig: auth.getPaymentConfig } },
        configurable: true,
      })

      await expect(useQuotaStore.getState().load()).resolves.toBeUndefined()
      expect(useQuotaStore.getState().error).toBeTruthy()
      // loading 必须落回来,否则 UI 永远转圈。
      expect(useQuotaStore.getState().loading).toBe(false)
    })

    it('查询 reject 时也落到 error,不往上抛', async () => {
      auth.getOrganizations.mockRejectedValue(new Error('桥断了'))

      await expect(useQuotaStore.getState().load()).resolves.toBeUndefined()
      expect(useQuotaStore.getState().error).toBeTruthy()
      expect(useQuotaStore.getState().loading).toBe(false)
    })

    it('refreshBalance 抛出时保留旧余额,只写 error', async () => {
      useQuotaStore.setState({
        selectedPool: { projectId: 342, producerProjectId: null },
        balanceYuan: 7.5,
      })
      auth.getBalance.mockRejectedValue(new Error('超时'))

      await expect(useQuotaStore.getState().refreshBalance()).resolves.toBeUndefined()
      // 显示 0 会让用户以为余额空了 —— 比「旧值 + 报错」糟得多。
      expect(useQuotaStore.getState().balanceYuan).toBe(7.5)
      expect(useQuotaStore.getState().error).toBeTruthy()
    })
  })

  it('初始态什么都没加载,不假装有余额', () => {
    const s = useQuotaStore.getState()
    expect(s.organizations).toEqual([])
    expect(s.selectedPool).toBeNull()
    expect(s.balanceYuan).toBeNull()
    expect(s.error).toBeNull()
  })

  it('load 同时拉组织列表与支付配置', async () => {
    await useQuotaStore.getState().load()
    expect(auth.getOrganizations).toHaveBeenCalledTimes(1)
    expect(auth.getPaymentConfig).toHaveBeenCalledTimes(1)
    expect(useQuotaStore.getState().organizations).toHaveLength(1)
    expect(useQuotaStore.getState().personalBillingProjectId).toBe(342)
  })

  // 个人计费落点由后端 env 下发,且该 project 刻意不出现在组织列表里。
  // 硬编码会在后端换配置时静默指向错误的池。
  it('个人计费落点取自后端,不是列表里找出来的', async () => {
    auth.getOrganizations.mockResolvedValue({ ok: true, data: [] })
    auth.getPaymentConfig.mockResolvedValue({ ok: true, data: { personalBillingProjectId: 999 } })
    await useQuotaStore.getState().load()
    expect(useQuotaStore.getState().personalBillingProjectId).toBe(999)
  })

  it('后端未配置个人计费时为 null,不崩', async () => {
    auth.getPaymentConfig.mockResolvedValue({ ok: true, data: { personalBillingProjectId: null } })
    await useQuotaStore.getState().load()
    expect(useQuotaStore.getState().personalBillingProjectId).toBeNull()
  })

  // **主进程刻意回信封而不是裸抛。** store 不摊开的话,UI 会把整个 { ok:false, error }
  // 对象当成数据渲染 —— 表现是余额显示成空白而不是报错,查起来很费劲。
  it('信封错误被摊成 error 文案,而不是当成数据', async () => {
    auth.getOrganizations.mockResolvedValue({
      ok: false,
      error: { code: 'FORBIDDEN_PROJECT', message: '无权访问该项目' },
    })
    await useQuotaStore.getState().load()

    expect(useQuotaStore.getState().error).toBe('无权访问该项目')
    expect(useQuotaStore.getState().organizations).toEqual([])
  })

  it('选池后刷新余额,并把余额落到 store', async () => {
    await useQuotaStore.getState().load()
    auth.getBalance.mockResolvedValue({ ok: true, data: { balanceYuan: 7.5, balanceQuota: null } })

    await useQuotaStore.getState().selectPool({ projectId: 342, producerProjectId: null })

    expect(auth.getBalance).toHaveBeenCalledWith(342, undefined)
    expect(useQuotaStore.getState().balanceYuan).toBe(7.5)
  })

  it('producer 池把两半都传给主进程', async () => {
    auth.getOrganizations.mockResolvedValue({ ok: true, data: [ORG_PRODUCER_A] })
    await useQuotaStore.getState().load()
    await useQuotaStore.getState().selectPool({ projectId: 700, producerProjectId: 5 })
    expect(auth.getBalance).toHaveBeenCalledWith(700, 5)
  })

  // **池键是一对。** 两个 producer 池可以共用一个 projectId —— 只比对 projectId 会把
  // 它们当成同一个池,于是「已选中」的高亮打在错的那一行,而钱记到另一个池上。
  it('共用 projectId 的两个 producer 池不算同一个', async () => {
    auth.getOrganizations.mockResolvedValue({
      ok: true,
      data: [ORG_PRODUCER_A, ORG_PRODUCER_B],
    })
    await useQuotaStore.getState().load()

    await useQuotaStore.getState().selectPool({ projectId: 700, producerProjectId: 5 })
    expect(useQuotaStore.getState().isSelected({ projectId: 700, producerProjectId: 5 })).toBe(true)
    expect(useQuotaStore.getState().isSelected({ projectId: 700, producerProjectId: 6 })).toBe(false)
  })

  // 没有 allocation 行就没有影子账户可扣,选中它只会在出图时拿到一个看不懂的错误。
  it('未加入的池不能被选中', async () => {
    auth.getOrganizations.mockResolvedValue({ ok: true, data: [ORG_NOT_JOINED] })
    await useQuotaStore.getState().load()

    await useQuotaStore.getState().selectPool({ projectId: 900, producerProjectId: null })

    expect(useQuotaStore.getState().selectedPool).toBeNull()
    expect(auth.getBalance).not.toHaveBeenCalled()
    expect(useQuotaStore.getState().error).toMatch(/未加入|加入/)
  })

  // 个人计费落点刻意不在组织列表里(后端设计前提),所以「不在列表里」不能作为拒绝理由。
  it('个人计费落点可以被选中,尽管它不在组织列表里', async () => {
    auth.getOrganizations.mockResolvedValue({ ok: true, data: [] })
    await useQuotaStore.getState().load()

    await useQuotaStore.getState().selectPool({ projectId: 342, producerProjectId: null })

    expect(useQuotaStore.getState().selectedPool).toEqual({ projectId: 342, producerProjectId: null })
    expect(auth.getBalance).toHaveBeenCalledWith(342, undefined)
  })

  it('选中的池持久化,下次 load 能恢复', async () => {
    await useQuotaStore.getState().load()
    await useQuotaStore.getState().selectPool({ projectId: 342, producerProjectId: null })

    // 模拟重启:清 store 但保留 localStorage
    useQuotaStore.setState(useQuotaStore.getInitialState(), true)
    __resetQuotaStoreForTesting()
    await useQuotaStore.getState().load()

    expect(useQuotaStore.getState().selectedPool).toEqual({ projectId: 342, producerProjectId: null })
  })

  it('余额查询失败时保留旧余额并给出错误,不显示 0', async () => {
    await useQuotaStore.getState().load()
    await useQuotaStore.getState().selectPool({ projectId: 342, producerProjectId: null })
    expect(useQuotaStore.getState().balanceYuan).toBe(0.26)

    auth.getBalance.mockResolvedValue({
      ok: false,
      error: { code: 'QUERY_FAILED', message: '网络故障' },
    })
    await useQuotaStore.getState().refreshBalance()

    // 显示 0 会让用户以为余额空了 —— 比显示旧值 + 报错糟得多。
    expect(useQuotaStore.getState().balanceYuan).toBe(0.26)
    expect(useQuotaStore.getState().error).toBe('网络故障')
  })

  it('没有 electronAPI 时不炸(浏览器端跑渲染层的场景)', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    await expect(useQuotaStore.getState().load()).resolves.toBeUndefined()
    expect(useQuotaStore.getState().organizations).toEqual([])
  })

  it('store 状态里不含 token 之类的机密字段', async () => {
    await useQuotaStore.getState().load()
    expect(JSON.stringify(useQuotaStore.getState())).not.toMatch(/token|jwt|verifier|sk-/i)
  })
})

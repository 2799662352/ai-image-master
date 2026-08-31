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
import type { BillingPoolRef } from '../../../../types/authApi'
import { useAuthStore } from '../useAuthStore'
import { useQuotaStore, __resetQuotaStoreForTesting, type Pool } from '../useQuotaStore'

/** 手搓的 deferred（`Promise.withResolvers` 要 Node 22+，这里不赌运行时版本）。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/**
 * 把已排队的微任务放干。
 *
 * 用宏任务而不是数微任务个数:被测路径里每个 `await` 落在哪一拍取决于实现细节
 * (`refreshBalance` 里有几层 await),数拍子的写法改一行实现就会假绿/假红。
 * 这里所有 mock 的 IPC 都是立即 resolve 的,让出一次宏任务就足够跑到底。
 */
async function settleQueuedWork(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((r) => setTimeout(r, 0))
  }
}

const auth = {
  getOrganizations: vi.fn(),
  getBalance: vi.fn(),
  getQuota: vi.fn(),
  getPaymentConfig: vi.fn(),
  setBillingPool: vi.fn(),
  clearBillingPool: vi.fn(),
  onBalanceStale: vi.fn(),
}

/**
 * 主进程推来的「刚花过平台余额」的订阅者。
 *
 * 攒成数组而不是单个:store 的订阅是幂等的(装过就不再装),而「装了几次」正是
 * 要断言的东西之一 —— 重复装的后果是一次消费刷 N 遍余额。
 */
let spendHandlers: Array<() => void> = []

/** 模拟主进程广播一次消费。 */
function emitSpend(): void {
  for (const h of [...spendHandlers]) h()
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
  auth.setBillingPool.mockResolvedValue({ ok: true, data: { ready: true } })
  auth.clearBillingPool.mockResolvedValue({ ok: true, data: null })
  spendHandlers = []
  auth.onBalanceStale.mockImplementation((handler: () => void) => {
    spendHandlers.push(handler)
    return () => {
      spendHandlers = spendHandlers.filter((h) => h !== handler)
    }
  })

  localStorage.clear()
  __resetQuotaStoreForTesting()
  useQuotaStore.setState(useQuotaStore.getInitialState(), true)
  // 计费模式要跟着登录态走,所以这两个 store 的重置必须成对 —— 只重置一半会让
  // 上一条用例留下的 `authenticated: false` 在下一条里立刻把平台模式踢掉。
  useAuthStore.setState(useAuthStore.getInitialState(), true)
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

  // 出图的钱从哪出。
  //
  // 这一组守的是整条链路上**唯一一个会静默把钱记到别处**的开关。渲染层永远拿不到
  // 网关凭据(那条 IPC 通道刻意不存在),它只能声明「这次走平台余额」;声明与主进程
  // 的实际状态一旦不同步,用户看到的是「开着平台余额」而账单上什么都没少。
  describe('计费来源', () => {
    async function pickPersonalPool(): Promise<void> {
      await useQuotaStore.getState().load()
      await useQuotaStore.getState().selectPool({ projectId: 342, producerProjectId: null })
    }

    // 平台余额是**新增的第二条路**,默认关闭 —— 老用户升级上来什么都不该变。
    it('默认走自有 Key', () => {
      expect(useQuotaStore.getState().billingSource).toBe('own-key')
    })

    it('切到平台余额时把选中的池递给主进程,拿到 ready 才真的切过去', async () => {
      await pickPersonalPool()
      await useQuotaStore.getState().setBillingSource('platform')

      expect(auth.setBillingPool).toHaveBeenCalledWith({ projectId: 342, producerProjectId: null })
      expect(useQuotaStore.getState().billingSource).toBe('platform')
      expect(useQuotaStore.getState().error).toBeNull()
    })

    // **池键是一对,递过去时两半都得在。** producer 那一半在组织列表里是
    // `number | undefined`,而主进程收的是 `number | null` —— 不显式补 `?? null`,
    // undefined 到那头会被 Number() 变成 NaN,arm 的就不是这个池。
    it('producer 池把两半都递过去', async () => {
      auth.getOrganizations.mockResolvedValue({ ok: true, data: [ORG_PRODUCER_A] })
      await useQuotaStore.getState().load()
      await useQuotaStore.getState().selectPool({ projectId: 700, producerProjectId: 5 })

      await useQuotaStore.getState().setBillingSource('platform')

      expect(auth.setBillingPool).toHaveBeenCalledWith({ projectId: 700, producerProjectId: 5 })
    })

    // 池键的另一半在 IPC 边界上**必须是 null,不能是 undefined**。
    //
    // 主进程那头收的是 `number | null`,拿到值就 `Number()` —— `Number(undefined)`
    // 是 NaN,arm 的就不是这个池(而且不会报错,只是悄悄记到别处)。类型上 `Pool` 已经
    // 写死了 `number | null`,但这个引用一路上会经过 `AccountOrganization`
    // (那半是 `number | undefined`)、localStorage 反序列化、以及各处 `setState` ——
    // 任何一处漏了归一,undefined 就会溜到这里。所以在**发出去之前**再兜一次底。
    //
    // 这里刻意绕开 `selectPool` 直接塞一个缺字段的池,就是为了让那个兜底成为
    // 唯一挡住它的东西 —— 走正常路径的话上游早就补好了,测不出这一层。
    it('产出的池引用里 producerProjectId 是 null,不是 undefined', async () => {
      await useQuotaStore.getState().load()
      useQuotaStore.setState({ selectedPool: { projectId: 342 } as unknown as Pool })

      await useQuotaStore.getState().setBillingSource('platform')

      const arg = auth.setBillingPool.mock.calls.at(-1)?.[0] as Record<string, unknown>
      // `toHaveBeenCalledWith` 认不出 `{a:1}` 与 `{a:1,b:undefined}` 的区别,
      // 而这恰恰就是会在 IPC 边界上变成 NaN 的那个差异 —— 只能显式断 null。
      expect(arg.producerProjectId).toBeNull()
      expect(Object.is(arg.producerProjectId, undefined)).toBe(false)
    })

    // 🚨 这一组是本文件最重要的三条。
    //
    // 切平台失败却静默留在 platform 态 = 渲染层继续打标记头,主进程收到标记后
    // **先无条件删掉 Authorization**(注入器刻意如此,免得静默花用户自己的钱),
    // 而它手上又没凭据可写 —— 于是每一个请求 401,用户只看到莫名其妙的网关错误。
    describe('切平台失败必须回落自有 Key', () => {
      it('信封报错时回落,并把错误摊出来', async () => {
        await pickPersonalPool()
        auth.setBillingPool.mockResolvedValue({
          ok: false,
          error: { code: 'UPSTREAM_UNREACHABLE', message: 'gateway down' },
        })

        await useQuotaStore.getState().setBillingSource('platform')

        expect(useQuotaStore.getState().billingSource).toBe('own-key')
        expect(useQuotaStore.getState().error).toBeTruthy()
      })

      // 「调用成功但凭据没到手」。主进程是先取凭据、成功了才置 active,
      // 所以 ready:false 与报错同等对待 —— 只看 ok 会漏掉这一支。
      it('ready:false 时也回落,不当成功', async () => {
        await pickPersonalPool()
        auth.setBillingPool.mockResolvedValue({ ok: true, data: { ready: false } })

        await useQuotaStore.getState().setBillingSource('platform')

        expect(useQuotaStore.getState().billingSource).toBe('own-key')
        expect(useQuotaStore.getState().error).toBeTruthy()
      })

      it('IPC 抛异常时回落,且异常不逃出去', async () => {
        await pickPersonalPool()
        auth.setBillingPool.mockRejectedValue(new Error('桥断了'))

        await expect(
          useQuotaStore.getState().setBillingSource('platform'),
        ).resolves.toBeUndefined()
        expect(useQuotaStore.getState().billingSource).toBe('own-key')
        expect(useQuotaStore.getState().error).toBeTruthy()
      })

      // 桥在但方法不存在(老版本 preload)。直接调是一个**同步** TypeError。
      //
      // 光靠外面那圈 try/catch 也能回落,但摊给用户的会是
      // 「额度查询失败:api.setBillingPool is not a function」—— 一句他既看不懂、
      // 也无法据此做任何事的话。所以这里额外断**文案是给人看的**,让前置守卫成为
      // 真正被测到的东西,而不是一段删了也照样绿的摆设。
      it('主进程没有这个方法时回落,给的是人话不是 TypeError', async () => {
        await pickPersonalPool()
        Object.defineProperty(window, 'electronAPI', {
          value: { auth: { ...auth, setBillingPool: undefined } },
          configurable: true,
        })

        await expect(
          useQuotaStore.getState().setBillingSource('platform'),
        ).resolves.toBeUndefined()
        expect(useQuotaStore.getState().billingSource).toBe('own-key')
        expect(useQuotaStore.getState().error).toMatch(/不支持|通道/)
        expect(useQuotaStore.getState().error).not.toMatch(/is not a function|undefined/)
      })
    })

    // 没选池就没有影子账户可扣。本地就知道的事,不必发一趟 IPC 去换一个 400。
    //
    // 文案同样要断:少了前置守卫的话,`pool.projectId` 会抛,外圈 try/catch 一样能把
    // 状态收回 own-key —— 但摊给用户的是「Cannot read properties of null」。
    // 回落对了、提示废了,等于用户点一下什么也没发生。
    it('没选池时拒绝切平台,不发 IPC,并告诉用户去选池', async () => {
      await useQuotaStore.getState().load()
      expect(useQuotaStore.getState().selectedPool).toBeNull()

      await useQuotaStore.getState().setBillingSource('platform')

      expect(auth.setBillingPool).not.toHaveBeenCalled()
      expect(useQuotaStore.getState().billingSource).toBe('own-key')
      expect(useQuotaStore.getState().error).toMatch(/计费池/)
      expect(useQuotaStore.getState().error).not.toMatch(/null|undefined|Cannot read/)
    })

    // UI 至少要把「换组织」和「稍后重试」分开:前者要用户去上面换一行,
    // 后者原地再点一次就行。只把 message 原样摊出来,用户看到「无权访问该项目」
    // 也不知道该往哪点。
    it('按 error code 给出不同的下一步动作', async () => {
      await pickPersonalPool()

      auth.setBillingPool.mockResolvedValue({
        ok: false,
        error: { code: 'PROJECT_NOT_ALLOCATED', message: 'not a member' },
      })
      await useQuotaStore.getState().setBillingSource('platform')
      const notAllocated = useQuotaStore.getState().error ?? ''

      auth.setBillingPool.mockResolvedValue({
        ok: false,
        error: { code: 'UPSTREAM_UNREACHABLE', message: 'gateway down' },
      })
      await useQuotaStore.getState().setBillingSource('platform')
      const unreachable = useQuotaStore.getState().error ?? ''

      expect(notAllocated).toMatch(/换.*组织|组织/)
      expect(unreachable).toMatch(/稍后重试|重试/)
      expect(notAllocated).not.toBe(unreachable)
    })

    it('切回自有 Key 时通知主进程把凭据清掉', async () => {
      await pickPersonalPool()
      await useQuotaStore.getState().setBillingSource('platform')

      await useQuotaStore.getState().setBillingSource('own-key')

      expect(auth.clearBillingPool).toHaveBeenCalledTimes(1)
      expect(useQuotaStore.getState().billingSource).toBe('own-key')
    })

    // 清不掉不影响「已经切回自有 Key」这个事实 —— 不打标记,注入器根本不会被触发。
    it('清凭据失败也照样切回自有 Key', async () => {
      await pickPersonalPool()
      await useQuotaStore.getState().setBillingSource('platform')
      auth.clearBillingPool.mockRejectedValue(new Error('桥断了'))

      await expect(
        useQuotaStore.getState().setBillingSource('own-key'),
      ).resolves.toBeUndefined()
      expect(useQuotaStore.getState().billingSource).toBe('own-key')
    })

    // **换池必须重新 arm。** 不重新 arm 的话主进程还揣着上一个池的凭据,而 UI 已经
    // 把高亮打在新池上 —— 钱继续从旧池扣。这就是「池键是一对」那条教训的动态版本:
    // 换掉一半也算换了池。
    it('平台模式下换池会重新 arm 主进程', async () => {
      auth.getOrganizations.mockResolvedValue({
        ok: true,
        data: [ORG_PRODUCER_A, ORG_PRODUCER_B],
      })
      await useQuotaStore.getState().load()
      await useQuotaStore.getState().selectPool({ projectId: 700, producerProjectId: 5 })
      await useQuotaStore.getState().setBillingSource('platform')
      auth.setBillingPool.mockClear()

      await useQuotaStore.getState().selectPool({ projectId: 700, producerProjectId: 6 })

      expect(auth.setBillingPool).toHaveBeenCalledWith({ projectId: 700, producerProjectId: 6 })
      expect(useQuotaStore.getState().billingSource).toBe('platform')
    })

    // 🚨 换池的重新 arm 必须**串行**,否则它自己就是一个新的错账通道。
    //
    // 池选择器是个原生 `<select>`,键盘方向键每翻一格就触发一次 `change` —— 在 5 个池
    // 里翻一遍就是 5 趟并发的 setBillingPool。主进程是**异步取到凭据之后**才写下它们的,
    // 所以并发发出去时最后落地的是最后**返回**的那趟,而 UI 高亮的一定是最后**选中**
    // 的那个。两者不同池时,症状恰好就是重新 arm 这件事本身要消灭的 bug:
    // 界面在新池、钱从旧池扣。
    //
    // 用例刻意让**先发的那趟后返回**。不这么摆的话调用顺序恰好等于返回顺序,断言
    // `mock.calls` 的最后一项永远是对的 —— 守卫删掉照样绿,等于没测。
    // 同理,`landed` 记的是 **resolve 的那一刻**而不是被调用的那一刻:后者是渲染层的
    // 发送顺序,前者才是主进程真正写下凭据的顺序。
    it('连续换池时最终落地的是最后选中的池,不是最后返回的那趟 IPC', async () => {
      auth.getOrganizations.mockResolvedValue({
        ok: true,
        data: [ORG_PERSONAL, ORG_PRODUCER_A, ORG_PRODUCER_B],
      })
      await useQuotaStore.getState().load()
      await useQuotaStore.getState().selectPool({ projectId: 342, producerProjectId: null })
      await useQuotaStore.getState().setBillingSource('platform')
      expect(useQuotaStore.getState().billingSource).toBe('platform')

      const landed: Array<number | null> = []
      const firstArmSent = deferred()
      const firstArmGate = deferred()
      let armCount = 0

      auth.setBillingPool.mockReset()
      auth.setBillingPool.mockImplementation(async (p: BillingPoolRef) => {
        armCount += 1
        if (armCount === 1) {
          // 先发的这趟卡在半路,好让第二次换池发生在它**在途**时 —— 方向键连按
          // 就是这个时序:第一趟 IPC 已经出门,用户又按了一下。
          firstArmSent.resolve()
          await firstArmGate.promise
        }
        landed.push(p.producerProjectId)
        return { ok: true, data: { ready: true } }
      })

      const first = useQuotaStore.getState().selectPool({ projectId: 700, producerProjectId: 5 })
      await firstArmSent.promise

      const second = useQuotaStore.getState().selectPool({ projectId: 700, producerProjectId: 6 })
      // 不加闸的实现会在这里就把 6 号池 arm 完:它不必等在途的 5 号。
      await settleQueuedWork()

      firstArmGate.resolve()
      await Promise.all([first, second])

      // 用户最后停在 6 号池,主进程最后写下的凭据就必须是 6 号池的。
      expect(landed.at(-1)).toBe(6)
      expect(useQuotaStore.getState().selectedPool).toEqual({ projectId: 700, producerProjectId: 6 })
      expect(useQuotaStore.getState().billingSource).toBe('platform')
    })

    // 🚨 本文件最重要的一条:**换池的瞬间钱还从旧池扣**。
    //
    // UI 在 `set({ selectedPool })` 那一行就宣称「你现在用新池」,而主进程要到重新 arm
    // 落地之后才真的换过去。中间隔着一次余额刷新往返 + 整个 `armChain` 队列 —— 期间
    // 主进程的 activePool 仍是旧池、旧 token 仍在缓存里,`getActivePoolToken()` 交给
    // 注入器的是**旧池的凭据**,网关扣的是旧池的钱。
    //
    // 更糟的是 `armChain` 在它本该保护的那个场景里**拉长了**这个窗口:用方向键连翻
    // 五个池会串行五次往返,全程活跃的是**第一个**池。
    //
    // 这是静默的、跨组织的、事后从桌面端查不出来的 —— 正是平台余额这个功能本身要防的
    // 失效类别。修法是在宣称换池**之前**先让主进程的旧池失效,把窗口从「扣错池」变成
    // fail-closed:没有 activePool → 注入器删掉 Authorization 又写不回 → 401,响亮、
    // 且一分钱不花。
    //
    // 断言记的是**调用顺序 + 调用当时的 selectedPool**,而不是「两个都调过」。三种变异
    // 各自杀得掉:删掉 clear → 少一项;clear 挪到 set 之后 → 记下的池变成新池;
    // clear 挪到 arm 之后 → 顺序反了。
    it('换池时先让主进程的旧池失效,再宣称换到新池', async () => {
      auth.getOrganizations.mockResolvedValue({
        ok: true,
        data: [ORG_PRODUCER_A, ORG_PRODUCER_B],
      })
      await useQuotaStore.getState().load()
      await useQuotaStore.getState().selectPool({ projectId: 700, producerProjectId: 5 })
      await useQuotaStore.getState().setBillingSource('platform')

      const order: string[] = []
      auth.clearBillingPool.mockImplementation(async () => {
        // 记下**清的那一刻** store 认为自己在哪个池上。必须还是旧池 5 ——
        // 若这里读到 6,说明 UI 已经先宣称换过去了,窗口依然存在。
        order.push(`clear@${useQuotaStore.getState().selectedPool?.producerProjectId}`)
        return { ok: true, data: null }
      })
      auth.setBillingPool.mockImplementation(async (p: BillingPoolRef) => {
        order.push(`arm@${p.producerProjectId}`)
        return { ok: true, data: { ready: true } }
      })

      await useQuotaStore.getState().selectPool({ projectId: 700, producerProjectId: 6 })

      expect(order).toEqual(['clear@5', 'arm@6'])
      expect(useQuotaStore.getState().billingSource).toBe('platform')
    })

    // 清不掉就**不能**宣称换池成功:那正是「UI 在新池、钱从旧池扣」的那个窗口。
    // 退回 own-key 是本地就成立的事实(不打标记 → 注入器根本不会被触发),并且要留下
    // 文案 —— 静默退回等于用户以为在花平台余额、实际在花自己的钱。
    it('旧池清不掉时退回自有 Key,不硬着头皮换过去', async () => {
      auth.getOrganizations.mockResolvedValue({
        ok: true,
        data: [ORG_PRODUCER_A, ORG_PRODUCER_B],
      })
      await useQuotaStore.getState().load()
      await useQuotaStore.getState().selectPool({ projectId: 700, producerProjectId: 5 })
      await useQuotaStore.getState().setBillingSource('platform')

      auth.setBillingPool.mockClear()
      auth.clearBillingPool.mockRejectedValue(new Error('桥断了'))

      await expect(
        useQuotaStore.getState().selectPool({ projectId: 700, producerProjectId: 6 }),
      ).resolves.toBeUndefined()

      expect(useQuotaStore.getState().billingSource).toBe('own-key')
      expect(useQuotaStore.getState().error).toBeTruthy()
      // 退回了就不该再去 arm —— 那会把刚判定为不安全的平台模式又接回去。
      expect(auth.setBillingPool).not.toHaveBeenCalled()
    })

    it('自有 Key 模式下换池不去打扰主进程', async () => {
      auth.getOrganizations.mockResolvedValue({ ok: true, data: [ORG_PRODUCER_A] })
      await useQuotaStore.getState().load()

      await useQuotaStore.getState().selectPool({ projectId: 700, producerProjectId: 5 })

      expect(auth.setBillingPool).not.toHaveBeenCalled()
      // 自有 Key 模式下主进程本来就没有 activePool,清它只是白发一趟 IPC。
      // 这条同时钉住上面那个 clear 是**带条件**的,不是无脑每次换池都发。
      expect(auth.clearBillingPool).not.toHaveBeenCalled()
    })

    // 🚨 登出后渲染层不能被钉在平台模式。
    //
    // 主进程一登出就清了缓存与 activePool,渲染层若仍返回 'platform',每个 Miau 请求
    // 都会带着标记头出去 —— 注入器**先无条件删掉 Authorization**,而它手上已经没有
    // token 可写,于是**每一次出图都 401**。
    //
    // 而 `AccountSection` 里那两个计费来源按钮**只在已登录分支渲染**,所以登出之后
    // 会话内没有任何路径能切回自有 Key:用户只能重启应用。
    it('登出后自动切回自有 Key,不把用户钉在平台模式', async () => {
      await pickPersonalPool()
      await useAuthStore.setState({ authenticated: true })
      await useQuotaStore.getState().setBillingSource('platform')
      expect(useQuotaStore.getState().billingSource).toBe('platform')

      // 真实触发源是主进程推来的 `auth:state-changed`,`useAuthStore` 把它落到这里。
      useAuthStore.setState({ authenticated: false, username: null, displayName: null })

      expect(useQuotaStore.getState().billingSource).toBe('own-key')
    })

    // 订阅是模块级单例,装第二份就是一次登出触发 N 次复位、以及 N 份永不释放的引用。
    //
    // 断言**订阅次数**而不是「复位了几次」:后者杀不掉这个变异。装三份的话,第一份就把
    // billingSource 写成 own-key 了,另外两份撞上「已经是 own-key 就别写」那道幂等闸
    // 直接返回 —— 可观测的复位次数仍然是 1,测试照样绿。只有盯 `subscribe` 本身才算数。
    it('反复切平台不会把登出订阅装多份', async () => {
      const subscribeSpy = vi.spyOn(useAuthStore, 'subscribe')
      await pickPersonalPool()
      useAuthStore.setState({ authenticated: true })

      await useQuotaStore.getState().setBillingSource('platform')
      await useQuotaStore.getState().setBillingSource('own-key')
      await useQuotaStore.getState().setBillingSource('platform')

      expect(subscribeSpy).toHaveBeenCalledTimes(1)
      subscribeSpy.mockRestore()
    })

    // 已登录状态下的其它状态推送(改了 displayName、刷新了 role)不该顺手把计费模式踢掉。
    it('仍登录时的状态推送不影响平台模式', async () => {
      await pickPersonalPool()
      useAuthStore.setState({ authenticated: true })
      await useQuotaStore.getState().setBillingSource('platform')

      useAuthStore.setState({ authenticated: true, displayName: '改了个名' })

      expect(useQuotaStore.getState().billingSource).toBe('platform')
    })

    // ⚠️ 真正要守的不变量是「**平台模式绝不能在主进程没 arm 的情况下为真**」。
    //
    // 这条最初写成「load() 之后必须是 own-key」,守的是「裸持久化」那种实现:
    // 把 'platform' 记进 localStorage、下次启动直接恢复 —— 渲染层一上来就打标记而
    // 主进程还没 arm,每个请求 401,用户以为是网关坏了。
    //
    // 现在 `load()` 会主动开平台模式,但走的是 `setBillingSource('platform')`,
    // 那个动作**先 arm 再置位、arm 失败自己回落**。所以旧断言的字面已经不成立,
    // 它的精神反而被更好地满足了。改成直接钉不变量本身。
    it('重启后自动开平台模式,但必须先 arm 过主进程', async () => {
      await pickPersonalPool()
      await useQuotaStore.getState().setBillingSource('platform')

      // 模拟重启:清 store 但保留 localStorage
      useQuotaStore.setState(useQuotaStore.getInitialState(), true)
      __resetQuotaStoreForTesting()
      auth.setBillingPool.mockClear()
      await useQuotaStore.getState().load()

      expect(useQuotaStore.getState().billingSource).toBe('platform')
      // 关键:置位之前 arm 过。少了这条,一个「直接 set platform 不 arm」的实现照样绿,
      // 而那正是这条用例最初要防的东西。
      expect(auth.setBillingPool).toHaveBeenCalled()
    })

    // arm 失败时绝不能停在 platform —— 否则用户以为在花平台余额,实际每个请求都 401。
    it('自动开启失败时留在 own-key,并给出原因', async () => {
      await pickPersonalPool()
      useQuotaStore.setState(useQuotaStore.getInitialState(), true)
      __resetQuotaStoreForTesting()
      auth.setBillingPool.mockResolvedValue({
        ok: false,
        error: { code: 'PROJECT_NOT_ALLOCATED', message: '该项目没有配额' },
      })

      await useQuotaStore.getState().load()

      expect(useQuotaStore.getState().billingSource).toBe('own-key')
      expect(useQuotaStore.getState().error).toBeTruthy()
    })

    /**
     * 契约在 2026-08-31 被**刻意反转**:已经是 platform 时**照样要 arm**。
     *
     * 旧行为(已是 platform 就跳过)在 `billingSource` 还不持久化的年代是对的 ——
     * 那时启动必然是 `own-key`,能走到这里就说明本会话已经 arm 过了。
     *
     * 现在 `initialBillingSource()` 会在「上次选过池 + 没显式关过」时直接以
     * `'platform'` 起手。若这里仍然跳过,渲染层就会自称平台、而主进程从没被
     * `setBillingPool` 调过。主进程能自愈的前提是它盘上已有 v2 信封(带池);
     * 刚从旧版本升上来的用户盘上是 v1(只有 token、没有池),那一整个会话都会
     * 每次提交撞「平台余额未就绪」。
     *
     * arm 幂等:多发一次只是一次缓存命中的 IPC,漏发一次是整个会话用不了平台余额。
     */
    it('已经是 platform 也要 arm 一次 —— 主进程可能还没被告知池', async () => {
      await pickPersonalPool()
      await useQuotaStore.getState().setBillingSource('platform')
      auth.setBillingPool.mockClear()

      await useQuotaStore.getState().load()

      expect(auth.setBillingPool).toHaveBeenCalledTimes(1)
      expect(useQuotaStore.getState().billingSource).toBe('platform')
    })

    /**
     * 「用户手动关掉过就别再自作主张打开」—— 这句话此前只存在于注释里。
     *
     * 🧬 变异点:把 `load()` 抬手条件里的 `!readAutoArmOptOut()` 去掉,这三条必红。
     *
     * `load()` 由设置页的 AccountSection 在挂载时触发,所以缺了这个标记的表现是:
     * 用户明确关掉平台余额、离开设置页再回来,它自己开回去,继续花组织的钱 ——
     * 而用户没做任何动作,也不会收到任何提示。
     *
     * 关键在于**只认用户的显式动作**:arm 失败时的内部回落走的是裸 `set()`,
     * 不该被记成「用户不想用平台余额」,否则一次网络抖动就把自动抬手永久关掉了。
     */
    describe('自动抬手要记住用户手动关过', () => {
      it('手动关掉后,load() 不再自作主张打开', async () => {
        await pickPersonalPool()
        await useQuotaStore.getState().setBillingSource('platform')
        await useQuotaStore.getState().setBillingSource('own-key')
        auth.setBillingPool.mockClear()

        await useQuotaStore.getState().load()

        expect(useQuotaStore.getState().billingSource).toBe('own-key')
        expect(auth.setBillingPool).not.toHaveBeenCalled()
      })

      it('标记跨重启有效 —— 它落在 localStorage,不是内存', async () => {
        await pickPersonalPool()
        await useQuotaStore.getState().setBillingSource('platform')
        await useQuotaStore.getState().setBillingSource('own-key')

        useQuotaStore.setState(useQuotaStore.getInitialState(), true)
        __resetQuotaStoreForTesting()
        auth.setBillingPool.mockClear()
        await useQuotaStore.getState().load()

        expect(useQuotaStore.getState().billingSource).toBe('own-key')
        expect(auth.setBillingPool).not.toHaveBeenCalled()
      })

      it('用户自己再开回来,标记就清掉', async () => {
        await pickPersonalPool()
        await useQuotaStore.getState().setBillingSource('own-key')
        await useQuotaStore.getState().setBillingSource('platform')

        useQuotaStore.setState(useQuotaStore.getInitialState(), true)
        __resetQuotaStoreForTesting()
        auth.setBillingPool.mockClear()
        await useQuotaStore.getState().load()

        expect(useQuotaStore.getState().billingSource).toBe('platform')
        expect(auth.setBillingPool).toHaveBeenCalled()
      })

      // 这一条把「用户意图」与「内部回落」分开。混在一起的话,一次 arm 失败
      // (网络抖动、后端 502)就等于替用户永久关掉了自动抬手,而他从未表达过这个意思。
      it('arm 失败的回落不算「手动关过」,下次 load 仍然会试', async () => {
        await pickPersonalPool()
        useQuotaStore.setState(useQuotaStore.getInitialState(), true)
        __resetQuotaStoreForTesting()
        auth.setBillingPool.mockResolvedValue({
          ok: false,
          error: { code: 'UPSTREAM_UNREACHABLE', message: '暂时连不上' },
        })

        await useQuotaStore.getState().load()
        expect(useQuotaStore.getState().billingSource).toBe('own-key')

        // 恢复正常后再来一次:不该被上一次失败挡住。
        useQuotaStore.setState(useQuotaStore.getInitialState(), true)
        __resetQuotaStoreForTesting()
        auth.setBillingPool.mockResolvedValue({ ok: true, data: { ready: true } })
        auth.setBillingPool.mockClear()

        await useQuotaStore.getState().load()

        expect(auth.setBillingPool).toHaveBeenCalled()
        expect(useQuotaStore.getState().billingSource).toBe('platform')
      })
    })

    /**
     * 扣费后自动刷余额。
     *
     * 在这之前余额只有两个刷新时机(设置页挂载、切池),出图 / 出视频 / 聊天扣完钱
     * 没有任何东西触发它 —— 数字停在旧值,用户要把设置页关掉重开才看得到。
     */
    describe('扣费后刷新余额', () => {
      async function armPlatform(): Promise<void> {
        await pickPersonalPool()
        await useQuotaStore.getState().setBillingSource('platform')
        auth.getBalance.mockClear()
      }

      it('收到消费信号就重新拉一次余额', async () => {
        await armPlatform()
        auth.getBalance.mockResolvedValue({
          ok: true,
          data: { balanceYuan: 0.11, balanceQuota: 55_000 },
        })

        emitSpend()
        await settleQueuedWork()

        expect(auth.getBalance).toHaveBeenCalledTimes(1)
        expect(useQuotaStore.getState().balanceYuan).toBe(0.11)
      })

      // 池键是一对。只带 projectId 的话,两个共用 id 的 producer 池会互相顶掉,
      // 刷出来的是另一个池的余额。
      it('拉的是当前选中的那个池,两半都带', async () => {
        auth.getOrganizations.mockResolvedValue({ ok: true, data: [ORG_PRODUCER_A, ORG_PRODUCER_B] })
        await useQuotaStore.getState().load()
        await useQuotaStore.getState().selectPool({ projectId: 700, producerProjectId: 6 })
        await useQuotaStore.getState().setBillingSource('platform')
        auth.getBalance.mockClear()

        emitSpend()
        await settleQueuedWork()

        expect(auth.getBalance).toHaveBeenCalledWith(700, 6)
      })

      /**
       * 🧬 变异点:去掉订阅回调里的 `billingSource !== 'platform'` 早退,这条必红。
       *
       * 自有 Key 模式下花的是用户自己的钱,平台余额一分没动 —— 信号与模式切换之间
       * 有窗口,那个窗口里刷一次是纯浪费。
       */
      it('切回自有 Key 后不再刷', async () => {
        await armPlatform()
        await useQuotaStore.getState().setBillingSource('own-key')
        auth.getBalance.mockClear()

        emitSpend()
        await settleQueuedWork()

        expect(auth.getBalance).not.toHaveBeenCalled()
      })

      /**
       * 🧬 变异点:把 `ensureBalanceRefreshOnSpend` 里的 `if (unsubscribeSpend) return`
       * 删掉,这条必红 —— 每次切平台都装一个,一次消费就刷 N 遍余额。
       */
      it('反复切换平台模式只装一份订阅', async () => {
        await pickPersonalPool()
        await useQuotaStore.getState().setBillingSource('platform')
        await useQuotaStore.getState().setBillingSource('own-key')
        await useQuotaStore.getState().setBillingSource('platform')
        auth.getBalance.mockClear()

        expect(spendHandlers).toHaveLength(1)

        emitSpend()
        await settleQueuedWork()

        expect(auth.getBalance).toHaveBeenCalledTimes(1)
      })

      // 老 preload 没有这个方法。调用不存在的方法是同步 TypeError,会把整条
      // `setBillingSource` 带崩 —— 而它此刻正要把用户切进平台模式。
      it('主进程没有这个推送时,切换平台模式照样成功', async () => {
        await pickPersonalPool()
        Object.defineProperty(window, 'electronAPI', {
          value: { auth: { ...auth, onBalanceStale: undefined } },
          configurable: true,
        })

        await expect(
          useQuotaStore.getState().setBillingSource('platform'),
        ).resolves.toBeUndefined()
        expect(useQuotaStore.getState().billingSource).toBe('platform')
      })

      // 余额查询自己失败时,信号处理不该把异常抛成 unhandled rejection
      // (调用点是 `void state.refreshBalance()`,没有 catch)。
      it('刷新失败只落 error,不产生未处理 rejection', async () => {
        await armPlatform()
        auth.getBalance.mockRejectedValue(new Error('网络故障'))

        expect(() => emitSpend()).not.toThrow()
        await settleQueuedWork()

        expect(useQuotaStore.getState().error).toContain('网络故障')
      })
    })
  })
})

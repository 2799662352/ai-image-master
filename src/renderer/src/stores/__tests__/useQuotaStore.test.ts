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
import { useQuotaStore, __resetQuotaStoreForTesting, type Pool } from '../useQuotaStore'

const auth = {
  getOrganizations: vi.fn(),
  getBalance: vi.fn(),
  getQuota: vi.fn(),
  getPaymentConfig: vi.fn(),
  setBillingPool: vi.fn(),
  clearBillingPool: vi.fn(),
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

    it('自有 Key 模式下换池不去打扰主进程', async () => {
      auth.getOrganizations.mockResolvedValue({ ok: true, data: [ORG_PRODUCER_A] })
      await useQuotaStore.getState().load()

      await useQuotaStore.getState().selectPool({ projectId: 700, producerProjectId: 5 })

      expect(auth.setBillingPool).not.toHaveBeenCalled()
    })

    // ⚠️ 刻意不持久化。记住 'platform' 的话,下次启动渲染层一上来就打标记,
    // 而主进程还没 arm —— 每个请求 401,用户以为是网关坏了。
    it('平台模式不跨重启保留', async () => {
      await pickPersonalPool()
      await useQuotaStore.getState().setBillingSource('platform')

      // 模拟重启:清 store 但保留 localStorage
      useQuotaStore.setState(useQuotaStore.getInitialState(), true)
      __resetQuotaStoreForTesting()
      await useQuotaStore.getState().load()

      expect(useQuotaStore.getState().billingSource).toBe('own-key')
    })
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BILLING_MARKER_HEADER } from '../../../../../types/authApi'

/**
 * 「自定义网关」复用 Miau 的全部能力 —— 渲染端这一半。
 *
 * 选中自定义网关(站点键 `local`)后:
 *  - 钉在 Miau 站点的渠道(`requiredSiteKey`,出图 / 音频 / 理解类)改走用户填的地址,
 *    凭据是自定义网关自己那把 Key,不是 Miau 站点的那把;
 *  - 平台余额一律不参与(不打标记、前置门也不放行);
 *  - 开关 / 地址推给主进程(Codex 与视频 / 智能擦除通道要跟着走),**Key 先落地、状态后推**。
 */

const GW = 'https://gw.example.com'
const MIAU_ORIGIN = 'https://miauapi.13797248455.xyz'

type Json = Record<string, unknown>

let events: string[]
let setProviderApiKey: ReturnType<typeof vi.fn>
let setCustomGateway: ReturnType<typeof vi.fn>

const flush = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  vi.resetModules()
  events = []
  // Key 的落地故意慢一拍:状态若不等它就会先到,顺序断言才有意义。
  setProviderApiKey = vi.fn(async (id: string, key: string) => {
    await new Promise((r) => setTimeout(r, 5))
    events.push(`key:${id}=${key}`)
    return { ok: true }
  })
  setCustomGateway = vi.fn(async (state: { active: boolean; url: string }) => {
    events.push(`state:${state.active ? state.url : 'off'}`)
    return { ok: true, changed: true }
  })
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    agent: { setProviderApiKey, setCustomGateway },
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

async function makeService() {
  const { ApiService } = await import('../ApiService')
  const svc = new ApiService()
  await flush()
  return svc
}

function selectCustomGateway(opts: { url?: string; localKey?: string; miauKey?: string } = {}) {
  localStorage.setItem('current_site', 'local')
  localStorage.setItem('ai_image_local_url', opts.url ?? GW)
  if (opts.localKey !== undefined) localStorage.setItem('api_key_local', opts.localKey)
  if (opts.miauKey !== undefined) localStorage.setItem('api_key_antigravity', opts.miauKey)
}

function stubFetch(body: Json = { data: [{ url: 'https://example.test/out.png' }] }) {
  const calls: Array<{ url: string; headers: Record<string, string>; method?: string }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        method: init?.method,
      })
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  )
  return calls
}

async function setBillingSource(billingSource: 'platform' | 'own-key') {
  const { useQuotaStore } = await import('../../../stores/useQuotaStore')
  useQuotaStore.setState({ billingSource })
}

describe('钉在 Miau 站点的渠道:选中自定义网关后改走它', () => {
  it('出图(模型自己声明 requiredSiteKey):打用户的地址、用自定义网关那把 Key', async () => {
    selectCustomGateway({ localKey: 'key-local', miauKey: 'key-miau' })
    const calls = stubFetch()
    const svc = await makeService()

    await svc.generateImage({ prompt: 'x', model: 'doubao-seedream-5-0-pro-260628' }).catch(() => {})

    expect(calls[0].url).toContain(`${GW}/v1/images/generations`)
    expect(calls[0].url).not.toContain(MIAU_ORIGIN)
    expect(calls[0].headers.Authorization).toBe('Bearer key-local')
  })

  it('出图(调用方显式钉 antigravity,如 Codex 出图工具):同样改走自定义网关', async () => {
    selectCustomGateway({ localKey: 'key-local', miauKey: 'key-miau' })
    const calls = stubFetch()
    const svc = await makeService()

    await svc
      .generateImage({ prompt: 'x', model: 'doubao-seedream-5-0-pro-260628', siteKey: 'antigravity' })
      .catch(() => {})

    expect(calls[0].url).toContain(`${GW}/v1/images/generations`)
    expect(calls[0].headers.Authorization).toBe('Bearer key-local')
  })

  it('对照:没选自定义网关时,同一个模型仍打 Miau、用 Miau 站点的 Key', async () => {
    localStorage.setItem('current_site', 'antigravity')
    localStorage.setItem('api_key_antigravity', 'key-miau')
    localStorage.setItem('api_key_local', 'key-local')
    const calls = stubFetch()
    const svc = await makeService()

    await svc.generateImage({ prompt: 'x', model: 'doubao-seedream-5-0-pro-260628' }).catch(() => {})

    expect(calls[0].url).toContain(`${MIAU_ORIGIN}/v1/images/generations`)
    expect(calls[0].headers.Authorization).toBe('Bearer key-miau')
  })

  it('对照:当前站点是别的中转站时,点名 antigravity 的请求不被改道', async () => {
    localStorage.setItem('current_site', 'b-apiyi')
    localStorage.setItem('api_key_antigravity', 'key-miau')
    localStorage.setItem('ai_image_local_url', GW)
    localStorage.setItem('api_key_local', 'key-local')
    const calls = stubFetch()
    const svc = await makeService()

    await svc
      .generateImage({ prompt: 'x', model: 'doubao-seedream-5-0-pro-260628', siteKey: 'antigravity' })
      .catch(() => {})

    expect(calls[0].url).toContain(`${MIAU_ORIGIN}/v1/images/generations`)
  })

  it('只显式点名别的站点(如 apiyi)的渠道不被悄悄改道到自定义网关', async () => {
    selectCustomGateway({ localKey: 'key-local' })
    localStorage.setItem('api_key_b-apiyi', 'key-apiyi')
    const calls = stubFetch()
    const svc = await makeService()

    await svc
      .generateImage({ prompt: 'x', model: 'gemini-3-pro-image', siteKey: 'b-apiyi' })
      .catch(() => {})

    expect(calls[0].url).not.toContain(GW)
    expect(calls[0].headers.Authorization ?? calls[0].headers['x-api-key']).toContain('key-apiyi')
  })

  it('自定义网关没填 Key:出图前就拒,不会拿 Miau 站点的 Key 顶上', async () => {
    selectCustomGateway({ miauKey: 'key-miau' })
    const calls = stubFetch()
    const svc = await makeService()

    const r = await svc.generateImage({ prompt: 'x', model: 'doubao-seedream-5-0-pro-260628' })

    expect(r.success).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('音频(固定钉 Miau 站点):改打自定义网关,用它的 Key', async () => {
    selectCustomGateway({ localKey: 'key-local', miauKey: 'key-miau' })
    const calls = stubFetch({ data: {} })
    const svc = await makeService()
    const { SEED_AUDIO_SITE_KEY } = await import('../ApiService')

    await svc.generateAudio({ input: 'hello', siteKey: SEED_AUDIO_SITE_KEY }).catch(() => {})

    expect(calls[0].url).toBe(`${GW}/v1/audio/speech`)
    expect(calls[0].headers.Authorization).toBe('Bearer key-local')
  })

  it('理解类(understand):改打自定义网关的 chat/completions,用它的 Key', async () => {
    selectCustomGateway({ localKey: 'key-local', miauKey: 'key-miau' })
    const calls = stubFetch({ choices: [{ message: { content: 'ok' } }] })
    const svc = await makeService()

    await svc.understand({ kind: 'web', query: 'q' }, { retries: 0 }).catch(() => {})

    expect(calls[0].url).toBe(`${GW}/v1/chat/completions`)
    expect(calls[0].headers.Authorization).toBe('Bearer key-local')
  })

  it('理解类:自定义网关没填 Key → 报「未配置」,不发请求', async () => {
    selectCustomGateway({ miauKey: 'key-miau' })
    const calls = stubFetch()
    const svc = await makeService()

    const r = await svc.understand({ kind: 'web', query: 'q' }, { retries: 0 })

    expect(r.success).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe('平台余额在自定义网关下一律不参与', () => {
  it.each(['platform', 'own-key'] as const)('出图:计费来源是 %s 也不打平台标记', async (source) => {
    selectCustomGateway({ localKey: 'key-local' })
    const calls = stubFetch()
    await setBillingSource(source)
    const svc = await makeService()

    await svc.generateImage({ prompt: 'x', model: 'doubao-seedream-5-0-pro-260628' }).catch(() => {})

    expect(calls[0].headers[BILLING_MARKER_HEADER]).toBeUndefined()
    expect(calls[0].headers.Authorization).toBe('Bearer key-local')
  })

  it('用户把自定义地址填成官方域名也一样:不打平台标记、照常带自己的 Key', async () => {
    selectCustomGateway({ url: MIAU_ORIGIN, localKey: 'key-local' })
    const calls = stubFetch()
    await setBillingSource('platform')
    const svc = await makeService()

    await svc.generateImage({ prompt: 'x', model: 'doubao-seedream-5-0-pro-260628' }).catch(() => {})

    expect(calls[0].url).toContain(`${MIAU_ORIGIN}/v1/images/generations`)
    expect(calls[0].headers[BILLING_MARKER_HEADER]).toBeUndefined()
    expect(calls[0].headers.Authorization).toBe('Bearer key-local')
  })

  it('自定义地址恰好填成官方域名 + 没填 Key + 偏好平台余额:出图前就拒,不会以为能走平台', async () => {
    // 站点判据是「请求的 host 是不是网关」—— 这种填法下 host 恰好就是网关,前置门若只看
    // host 会放行,请求出网时既没有平台标记也没有自己的 Key,表现是一次莫名其妙的 401。
    selectCustomGateway({ url: MIAU_ORIGIN })
    const calls = stubFetch()
    await setBillingSource('platform')
    const svc = await makeService()

    const r = await svc.generateImage({ prompt: 'x', model: 'doubao-seedream-5-0-pro-260628' })

    expect(r.success).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('自定义地址填成官方域名时,UI 查到的平台资格仍是「不符合」', async () => {
    selectCustomGateway({ url: MIAU_ORIGIN, localKey: 'key-local' })
    const svc = await makeService()
    expect(svc.getPlatformBillingEligibility('doubao-seedream-5-0-pro-260628')).toEqual({
      eligible: false,
      blocker: 'site-not-gateway',
    })
  })

  it('没填 Key 时即使登录了平台也不放行(不会以为能走平台余额)', async () => {
    selectCustomGateway({})
    const calls = stubFetch()
    await setBillingSource('platform')
    const svc = await makeService()

    const r = await svc.generateImage({ prompt: 'x', model: 'doubao-seedream-5-0-pro-260628' })

    expect(r.success).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('getPlatformBillingEligibility:选中自定义网关时不符合(界面据此提示)', async () => {
    selectCustomGateway({ localKey: 'key-local' })
    const svc = await makeService()
    expect(svc.getPlatformBillingEligibility('doubao-seedream-5-0-pro-260628')).toEqual({
      eligible: false,
      blocker: 'site-not-gateway',
    })
  })

  it('对照:选 Miau 站点时同一个模型符合平台余额', async () => {
    localStorage.setItem('current_site', 'antigravity')
    const svc = await makeService()
    expect(svc.getPlatformBillingEligibility('doubao-seedream-5-0-pro-260628').eligible).toBe(true)
  })
})

describe('把开关 / 地址推给主进程', () => {
  it('启动时:选中自定义网关 → 先落 Key、再推状态', async () => {
    selectCustomGateway({ localKey: 'key-local', miauKey: 'key-miau' })
    await makeService()

    const stateAt = events.findIndex((e) => e.startsWith('state:'))
    expect(events[stateAt]).toBe(`state:${GW}`)
    const keyAt = events.findIndex((e) => e === 'key:qwen=key-local')
    expect(keyAt).toBeGreaterThanOrEqual(0)
    expect(keyAt).toBeLessThan(stateAt)
    // 镜像到主进程的是自定义网关那把,不是 Miau 站点那把。
    expect(events).not.toContain('key:qwen=key-miau')
  })

  it('启动时:没选自定义网关 → 状态是关,Key 是 Miau 站点那把', async () => {
    localStorage.setItem('current_site', 'antigravity')
    localStorage.setItem('api_key_antigravity', 'key-miau')
    localStorage.setItem('api_key_local', 'key-local')
    await makeService()

    expect(events).toContain('state:off')
    expect(events).toContain('key:qwen=key-miau')
    expect(events).not.toContain('key:qwen=key-local')
  })

  it('关闭时不会把用户填的地址一并推出去(只推 active:false + 空地址)', async () => {
    localStorage.setItem('current_site', 'antigravity')
    localStorage.setItem('ai_image_local_url', GW)
    await makeService()
    expect(setCustomGateway).toHaveBeenCalledWith({ active: false, url: '' })
  })

  it('切到自定义网关:Key 先落、状态后推', async () => {
    localStorage.setItem('current_site', 'antigravity')
    localStorage.setItem('ai_image_local_url', GW)
    localStorage.setItem('api_key_local', 'key-local')
    localStorage.setItem('api_key_antigravity', 'key-miau')
    const svc = await makeService()
    events.length = 0

    expect(svc.setSite('local')).toBe(true)
    await flush()

    expect(events).toEqual(['key:qwen=key-local', `state:${GW}`])
  })

  it('切回 Miau:Key 换回 Miau 的那把,状态关', async () => {
    selectCustomGateway({ localKey: 'key-local', miauKey: 'key-miau' })
    const svc = await makeService()
    events.length = 0

    svc.setSite('antigravity')
    await flush()

    expect(events).toEqual(['key:qwen=key-miau', 'state:off'])
  })

  it('在别的站点之间切换(不经过自定义网关):不推送', async () => {
    localStorage.setItem('current_site', 'antigravity')
    const svc = await makeService()
    events.length = 0
    setCustomGateway.mockClear()
    setProviderApiKey.mockClear()

    svc.setSite('b-apiyi')
    await flush()

    expect(setCustomGateway).not.toHaveBeenCalled()
    expect(setProviderApiKey).not.toHaveBeenCalled()
  })

  it('选中时改地址:把新地址推给主进程;没选中时改地址不推', async () => {
    selectCustomGateway({ localKey: 'key-local' })
    const svc = await makeService()
    events.length = 0

    svc.setLocalUrl('https://other.example.com/')
    await flush()
    expect(events).toContain('state:https://other.example.com')

    localStorage.setItem('current_site', 'antigravity')
    const svc2 = await makeService()
    events.length = 0
    setCustomGateway.mockClear()
    svc2.setLocalUrl('https://third.example.com')
    await flush()
    expect(setCustomGateway).not.toHaveBeenCalled()
  })

  it('不合法的地址不推送、也不改主进程的状态', async () => {
    selectCustomGateway({ localKey: 'key-local' })
    const svc = await makeService()
    events.length = 0
    setCustomGateway.mockClear()

    const r = svc.setLocalUrl('ftp://nope')
    await flush()

    expect(r.ok).toBe(false)
    expect(setCustomGateway).not.toHaveBeenCalled()
  })

  it('选中自定义网关时保存 Key:镜像给主进程(Codex 重启后读到的是这把)', async () => {
    selectCustomGateway({})
    const svc = await makeService()
    events.length = 0

    svc.saveApiKey('key-new')
    await flush()

    expect(events).toEqual(['key:qwen=key-new'])
  })

  it('选中自定义网关时清空地址框:回缺省地址,并把缺省地址推给主进程(没选中则不推)', async () => {
    selectCustomGateway({ localKey: 'key-local' })
    const svc = await makeService()
    events.length = 0

    svc.setLocalUrl('')
    await flush()
    expect(events).toContain('state:http://127.0.0.1:3000')

    localStorage.setItem('current_site', 'antigravity')
    const svc2 = await makeService()
    setCustomGateway.mockClear()
    svc2.setLocalUrl('')
    await flush()
    expect(setCustomGateway).not.toHaveBeenCalled()
  })

  it('选中自定义网关时只保存了视觉 Key:同样镜像给主进程(没有主 Key 时用它)', async () => {
    selectCustomGateway({})
    const svc = await makeService()
    events.length = 0

    svc.saveVisionApiKey('vision-new')
    await flush()

    expect(events).toEqual(['key:qwen=vision-new'])
  })

  it('旧 preload(没有 setCustomGateway):启动时 Miau Key 仍照旧镜像给主进程', async () => {
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = { agent: { setProviderApiKey } }
    localStorage.setItem('current_site', 'antigravity')
    localStorage.setItem('api_key_antigravity', 'key-miau')
    await makeService()

    expect(events).toContain('key:qwen=key-miau')
  })

  it('选中别的中转站时保存 Key:不动主进程里的 Miau 通道 Key', async () => {
    localStorage.setItem('current_site', 'b-apiyi')
    const svc = await makeService()
    events.length = 0
    setProviderApiKey.mockClear()

    svc.saveApiKey('key-apiyi')
    await flush()

    expect(setProviderApiKey).not.toHaveBeenCalled()
  })

  it('桥不存在(纯浏览器 / 旧 preload)时静默跳过,不抛', async () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    selectCustomGateway({ localKey: 'key-local' })
    const svc = await makeService()
    expect(() => svc.setSite('antigravity')).not.toThrow()
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = { agent: {} }
    await expect(svc.syncCustomGatewayToMain()).resolves.toBeUndefined()
  })

  it('推送失败(IPC 抛错)不外泄', async () => {
    selectCustomGateway({ localKey: 'key-local' })
    setCustomGateway.mockRejectedValue(new Error('ipc down'))
    const svc = await makeService()
    await expect(svc.syncCustomGatewayToMain()).resolves.toBeUndefined()
  })
})

describe('渲染端「有效计费来源」跟着当前站点走(视频工作台 / 智能擦除读它)', () => {
  async function effective() {
    return await import('../../../stores/effectiveBilling')
  }

  it('启动时已选中自定义网关:偏好是平台余额也读到自填 Key', async () => {
    selectCustomGateway({ localKey: 'key-local' })
    await makeService()
    await setBillingSource('platform')
    const { getEffectiveBillingSource, isCustomGatewaySelectedNow } = await effective()
    expect(isCustomGatewaySelectedNow()).toBe(true)
    expect(getEffectiveBillingSource()).toBe('own-key')
  })

  it('启动时没选自定义网关:跟着偏好走(平台余额照常有效)', async () => {
    localStorage.setItem('current_site', 'antigravity')
    await makeService()
    await setBillingSource('platform')
    const { getEffectiveBillingSource, isCustomGatewaySelectedNow } = await effective()
    expect(isCustomGatewaySelectedNow()).toBe(false)
    expect(getEffectiveBillingSource()).toBe('platform')
  })

  it('运行中 Miau → 自定义网关 → Miau:有效值同步翻转,偏好本身不被改写', async () => {
    localStorage.setItem('current_site', 'antigravity')
    localStorage.setItem('ai_image_local_url', GW)
    localStorage.setItem('api_key_local', 'key-local')
    const svc = await makeService()
    await setBillingSource('platform')
    const { getEffectiveBillingSource } = await effective()
    const { useQuotaStore } = await import('../../../stores/useQuotaStore')
    expect(getEffectiveBillingSource()).toBe('platform')

    expect(svc.setSite('local')).toBe(true)
    // 同步生效:不等推给主进程的异步往返,点击立刻就该按新口径提交。
    expect(getEffectiveBillingSource()).toBe('own-key')
    expect(useQuotaStore.getState().billingSource).toBe('platform')

    expect(svc.setSite('antigravity')).toBe(true)
    expect(getEffectiveBillingSource()).toBe('platform')
  })

  it('在别的中转站之间切换:不影响有效值', async () => {
    localStorage.setItem('current_site', 'antigravity')
    const svc = await makeService()
    await setBillingSource('platform')
    const { getEffectiveBillingSource } = await effective()
    svc.setSite('apiyi')
    expect(getEffectiveBillingSource()).toBe('platform')
  })
})

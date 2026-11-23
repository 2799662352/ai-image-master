import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 「自定义网关」在 AgentManager 这一层的行为:
 *
 *  - 状态(开关 / 地址)真变了才重启 Codex —— Miau 通道地址是拉起进程时烘进去的;幂等重推、
 *    非法状态都不能重启(渲染端启动 / 保存时会反复推,不能造成重启风暴);
 *  - 自定义网关生效期间,Miau 那个槽位的 Key 一变也要重启,否则对话继续拿旧 Key 打新地址;
 *    没生效时 Key 变化不重启(沿用原行为:下次拉起时才读);
 *  - 生效期间平台余额(登录后 arm 的池)不算「配好了」:钱包只有自填 Key 一种。
 */

let poolToken: string | null = null

vi.mock('../../services/auth/gatewayToken', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/auth/gatewayToken')>()
  return { ...actual, getActivePoolToken: () => poolToken }
})

import { AgentManager } from '../AgentManager'
import type { IAgentBackend } from '../types'
import {
  __resetCustomGatewayForTests,
  applyCustomGatewayState,
  getCustomGatewayState,
} from '../../services/customGateway'

let tmpDir: string
let restarts: number

function makeBackend(): IAgentBackend {
  return {
    async start() {},
    async stop() {},
    isHealthy: () => true,
    async cancel() {},
    async *send() {},
    async restartCodex() {
      restarts += 1
    },
  } as unknown as IAgentBackend
}

async function makeManager(): Promise<AgentManager> {
  const mgr = new AgentManager({ userDataDir: tmpDir, backend: makeBackend() })
  await settle(mgr)
  restarts = 0
  return mgr
}

/** 等重启链排空(`queueBackendRestart` 是 fire-and-forget,链本身可等)。 */
async function settle(mgr: AgentManager): Promise<void> {
  await (mgr as unknown as { restartChain: Promise<void> }).restartChain
  await new Promise((r) => setTimeout(r, 0))
  await (mgr as unknown as { restartChain: Promise<void> }).restartChain
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-custom-gw-'))
  __resetCustomGatewayForTests()
  poolToken = null
  restarts = 0
})

afterEach(async () => {
  __resetCustomGatewayForTests()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('AgentManager.setCustomGateway', () => {
  it('开启:返回 ok + changed,并重启 Codex 一次', async () => {
    const mgr = await makeManager()

    const r = mgr.setCustomGateway({ active: true, url: 'https://gw.example.com' })
    await settle(mgr)

    expect(r).toMatchObject({ ok: true, changed: true })
    expect(getCustomGatewayState()).toEqual({ active: true, url: 'https://gw.example.com' })
    expect(restarts).toBe(1)
  })

  it('同样的状态再推一次(渲染端启动 / 保存时的幂等重推):不重启', async () => {
    const mgr = await makeManager()
    mgr.setCustomGateway({ active: true, url: 'https://gw.example.com' })
    await settle(mgr)
    restarts = 0

    const r = mgr.setCustomGateway({ active: true, url: 'https://gw.example.com' })
    await settle(mgr)

    expect(r).toMatchObject({ ok: true, changed: false })
    expect(restarts).toBe(0)
  })

  it('一开始就是关的,再推「关」:不重启(渲染端每次启动都会推一次 off)', async () => {
    const mgr = await makeManager()

    const r = mgr.setCustomGateway({ active: false, url: '' })
    await settle(mgr)

    expect(r).toMatchObject({ ok: true, changed: false })
    expect(restarts).toBe(0)
  })

  it('改地址:重启;关闭:再重启', async () => {
    const mgr = await makeManager()
    mgr.setCustomGateway({ active: true, url: 'https://a.example.com' })
    await settle(mgr)
    restarts = 0

    mgr.setCustomGateway({ active: true, url: 'https://b.example.com' })
    await settle(mgr)
    expect(restarts).toBe(1)

    mgr.setCustomGateway({ active: false, url: '' })
    await settle(mgr)
    expect(restarts).toBe(2)
  })

  it('非法状态:整体拒绝、不改状态、不重启', async () => {
    const mgr = await makeManager()
    mgr.setCustomGateway({ active: true, url: 'https://gw.example.com' })
    await settle(mgr)
    restarts = 0

    const r = mgr.setCustomGateway({ active: true, url: 'ftp://nope' })
    await settle(mgr)

    expect(r.ok).toBe(false)
    expect(getCustomGatewayState()).toEqual({ active: true, url: 'https://gw.example.com' })
    expect(restarts).toBe(0)
  })
})

describe('AgentManager —— Miau 槽位 Key 变化与重启', () => {
  it('自定义网关生效:Key 变了 → 重启(对话要拿新 Key 打这个地址)', async () => {
    const mgr = await makeManager()
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })

    await mgr.setProviderApiKey('qwen', 'key-1')
    await settle(mgr)

    expect(restarts).toBe(1)
  })

  it('自定义网关生效:同一把 Key 重复推送 → 不重启', async () => {
    const mgr = await makeManager()
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })
    await mgr.setProviderApiKey('qwen', 'key-1')
    await settle(mgr)
    restarts = 0

    await mgr.setProviderApiKey('qwen', 'key-1')
    await settle(mgr)

    expect(restarts).toBe(0)
  })

  it('没生效:Key 变化不重启(保持原行为,下次拉起时才读)', async () => {
    const mgr = await makeManager()

    await mgr.setProviderApiKey('qwen', 'key-1')
    await settle(mgr)

    expect(restarts).toBe(0)
  })

  it('生效时别的槽位的 Key 变化不因此重启', async () => {
    const mgr = await makeManager()
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })

    await mgr.setProviderApiKey('rightcode', 'key-x')
    await settle(mgr)

    expect(restarts).toBe(0)
  })
})

describe('AgentManager —— 自定义网关下平台余额不算凭据', () => {
  function hasCredential(mgr: AgentManager, id: string): boolean {
    return (mgr as unknown as { hasCredentialFor(id: string): boolean }).hasCredentialFor(id)
  }
  function gapFor(mgr: AgentManager, gateway: string, model: string): string | null {
    return (
      mgr as unknown as { credentialGapForTurn(g: string, m: string): string | null }
    ).credentialGapForTurn(gateway, model)
  }

  it('对照:没生效、登录了(池已 arm)→ Miau 槽位算配好了,发消息不被拦', async () => {
    const mgr = await makeManager()
    poolToken = 'shadow-token'

    expect(hasCredential(mgr, 'qwen')).toBe(true)
    expect(gapFor(mgr, 'apiyi', 'qwen4-max')).toBeNull()
  })

  it('生效、只有平台池没有自填 Key → 不算配好,发消息被拦并提示填 Key', async () => {
    const mgr = await makeManager()
    poolToken = 'shadow-token'
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })

    expect(hasCredential(mgr, 'qwen')).toBe(false)
    expect(gapFor(mgr, 'apiyi', 'qwen4-max')).toMatch(/Miau API Key/)
  })

  it('生效、填了自己的 Key → 配好,不被拦', async () => {
    const mgr = await makeManager()
    poolToken = 'shadow-token'
    applyCustomGatewayState({ active: true, url: 'https://gw.example.com' })
    await mgr.setProviderApiKey('qwen', 'key-mine')

    expect(hasCredential(mgr, 'qwen')).toBe(true)
    expect(gapFor(mgr, 'apiyi', 'qwen4-max')).toBeNull()
  })
})

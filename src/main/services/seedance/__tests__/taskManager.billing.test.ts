// 「这一次的钱从哪出」在 taskManager 里的落点。
//
// 三件事各自都会**静默**出错,而且事后从桌面端一件也查不出来:
//
// 1. 调用方的意向没走到 `transportFor` —— 用户点的是平台余额,扣的是他自己的
//    vvdance key;
// 2. 平台通道缺席时悄悄回落 vvdance 直连 —— 同一种失效,只是换个成因;
// 3. 提交走平台、轮询走自填 —— 一个 shadow 账号建的任务换一枚 token 去查,上游
//    回「任务不存在」,而卡片会把它报成「生成失败」,用户以为片子没出来。
//
// 所以这三条都按变异测试写:把传递链上任意一段删掉都必须变红。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SeedanceTaskManager } from '../taskManager'
import type { SeedanceClient, SeedanceQueryResult } from '../client'
import type { CreateVideoTaskInput, SeedanceTaskUpdate, VideoBillingSource } from '../types'
import type { VideoTransport } from '../../videoTransport'
import { setSeedanceRegionMemory } from '../region'

const INPUT: CreateVideoTaskInput = { prompt: '一只猫在雨里跳舞' }

function makeClient(statuses: SeedanceQueryResult[]): SeedanceClient {
  let i = 0
  return {
    createTask: vi.fn(async () => ({ id: 'task-1' })),
    queryTask: vi.fn(async () => statuses[Math.min(i++, statuses.length - 1)]),
    downloadVideo: vi.fn(async (_url: string, destPath: string) => destPath),
    deleteTask: vi.fn(async () => {}),
  }
}

/**
 * 假网关 transport。**刻意不给 `deleteTask`** —— 真实的
 * `createSeedanceGatewayTransport` 也没有(网关侧取消接口未经证实),取消那条
 * 用例正是靠这个差异来分辨「取消问的是哪条路」。
 */
function makeGatewayTransport(statuses: SeedanceQueryResult[] = [{ id: 'gw-1', status: 'running' }]) {
  let i = 0
  return {
    requireApiKey: vi.fn(() => {}),
    createTask: vi.fn(async () => ({ id: 'gw-1' })),
    queryTask: vi.fn(async () => statuses[Math.min(i++, statuses.length - 1)]),
  } satisfies VideoTransport
}

describe('taskManager × 计费模式', () => {
  let broadcasts: SeedanceTaskUpdate[]
  let persistVideo: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    broadcasts = []
    persistVideo = vi.fn(async () => ({ localPath: 'D:/save/v.mp4', remoteUrl: 'https://cos/v.mp4' }))
    setSeedanceRegionMemory('global')
  })

  afterEach(() => {
    vi.useRealTimers()
    setSeedanceRegionMemory('global')
  })

  function makeManager(
    client: SeedanceClient,
    extra: {
      seedanceGatewayTransport?: VideoTransport
      resolveBilling?: (prefer?: VideoBillingSource) => VideoBillingSource
    } = {},
  ) {
    return new SeedanceTaskManager({
      client,
      getApiKey: () => 'sk-test',
      persistVideo,
      broadcast: (u) => broadcasts.push(u),
      ...extra,
    })
  }

  // 🧬 变异靶心 1:意向的最后一段。把 `submit` 里传给 `this.transport(...)` 的
  // billing 删掉(或写死 undefined),这一条必红 —— 症状是 vvdance 直连被调用。
  describe('提交:意向决定走哪条上游', () => {
    it('billing=platform 时走网关,vvdance 直连一次都不碰', async () => {
      const client = makeClient([])
      const gateway = makeGatewayTransport()
      const mgr = makeManager(client, { seedanceGatewayTransport: gateway })

      const state = await mgr.submit({ input: INPUT, content: [], billing: 'platform' })

      expect(gateway.createTask).toHaveBeenCalledTimes(1)
      expect(client.createTask).not.toHaveBeenCalled()
      expect(state.taskId).toBe('gw-1')
      mgr.dispose()
    })

    it('密钥检查也问的是同一条路 —— 平台缺凭据时不该报「请填火山密钥」', async () => {
      const client = makeClient([])
      const gateway = makeGatewayTransport()
      gateway.requireApiKey.mockImplementation(() => {
        throw new Error('平台余额未就绪：请先在账号设置里选择一个计费池并启用平台余额。')
      })
      const mgr = makeManager(client, { seedanceGatewayTransport: gateway })

      await expect(
        mgr.submit({ input: INPUT, content: [], billing: 'platform' }),
      ).rejects.toThrow(/计费池/)
      expect(client.createTask).not.toHaveBeenCalled()
      mgr.dispose()
    })

    it('billing=own-key 与不传意向都走 vvdance 直连 —— 线上行为一个字节不变', async () => {
      for (const billing of [undefined, 'own-key' as const]) {
        const client = makeClient([])
        const gateway = makeGatewayTransport()
        const mgr = makeManager(client, { seedanceGatewayTransport: gateway })

        await mgr.submit({ input: INPUT, content: [], ...(billing ? { billing } : {}) })

        expect(client.createTask, String(billing)).toHaveBeenCalledTimes(1)
        expect(gateway.createTask, String(billing)).not.toHaveBeenCalled()
        mgr.dispose()
      }
    })

    it('万相不受计费模式影响 —— 平台余额也不能把它劫到 Seedance 网关', async () => {
      const client = makeClient([])
      const gateway = makeGatewayTransport()
      const wan3Transport: VideoTransport = {
        requireApiKey: vi.fn(() => {}),
        createTask: vi.fn(async () => ({ id: 'wan-1' })),
        queryTask: vi.fn(async () => ({ id: 'wan-1', status: 'running' as const })),
      }
      const mgr = makeManager(client, { seedanceGatewayTransport: gateway, wan3Transport })

      await mgr.submit({ input: { ...INPUT, model: 'wan3' }, content: [], billing: 'platform' })

      expect(wan3Transport.createTask).toHaveBeenCalledTimes(1)
      expect(gateway.createTask).not.toHaveBeenCalled()
      mgr.dispose()
    })
  })

  // 🧬 变异靶心 2:把 `transportFor` 那条 throw 改回「回落 registry.seedance」,
  // 这一条必红 —— 症状是用户以为花平台余额、实际扣自己的 vvdance key。
  describe('平台模式下永远不会落到 vvdance 直连', () => {
    it('平台通道没注册时抛错,不悄悄改走自填 Key', async () => {
      const client = makeClient([])
      const mgr = makeManager(client) // 刻意不注入 seedanceGatewayTransport

      await expect(
        mgr.submit({ input: INPUT, content: [], billing: 'platform' }),
      ).rejects.toThrow(/平台余额/)
      expect(client.createTask).not.toHaveBeenCalled()
      mgr.dispose()
    })
  })

  // 🧬 变异靶心 3:把 `pollLoop` / `cancel` 里的 `task.billing` 删掉,这两条必红。
  // 症状最阴:提交成功、上游在跑,而轮询拿错 token 问,回一句「任务不存在」,
  // 卡片报「生成失败」—— 片子其实好好的,钱也已经花了。
  describe('轮询与取消:与提交同一条 transport', () => {
    it('平台任务的轮询走网关,不去问 vvdance', async () => {
      const client = makeClient([{ id: 'task-1', status: 'running' }])
      const gateway = makeGatewayTransport([
        { id: 'gw-1', status: 'succeeded', content: { video_url: 'https://cdn/v.mp4' } },
      ])
      const mgr = makeManager(client, { seedanceGatewayTransport: gateway })

      await mgr.submit({ input: INPUT, content: [], billing: 'platform' })
      await vi.advanceTimersByTimeAsync(6_000)

      expect(gateway.queryTask).toHaveBeenCalledWith('gw-1')
      expect(client.queryTask).not.toHaveBeenCalled()
      expect(mgr.get('gw-1')?.status).toBe('succeeded')
      mgr.dispose()
    })

    it('平台任务的取消问网关的能力 —— 网关没有取消接口,如实说仍会计费', async () => {
      const client = makeClient([{ id: 'task-1', status: 'queued' }])
      const gateway = makeGatewayTransport()
      const mgr = makeManager(client, { seedanceGatewayTransport: gateway })

      await mgr.submit({ input: INPUT, content: [], billing: 'platform' })
      const res = await mgr.cancel('gw-1')

      // vvdance 的 deleteTask 有实现,拿它去删一个网关任务只会删错东西/白删。
      expect(client.deleteTask).not.toHaveBeenCalled()
      expect(res).toMatchObject({ ok: true, billed: true })
      expect(res.reason).toMatch(/不支持取消/)
      mgr.dispose()
    })

    it('任务状态记住了自己是哪种计费模式建的,并随广播带出去', async () => {
      const client = makeClient([])
      const gateway = makeGatewayTransport()
      const mgr = makeManager(client, { seedanceGatewayTransport: gateway })

      const state = await mgr.submit({ input: INPUT, content: [], billing: 'platform' })

      expect(state.billing).toBe('platform')
      expect(broadcasts[0]?.billing).toBe('platform')
      mgr.dispose()
    })

    it('重启接管也带计费模式 —— 否则重启后的轮询会换一条路去问', async () => {
      const client = makeClient([{ id: 'task-1', status: 'running' }])
      const gateway = makeGatewayTransport()
      const mgr = makeManager(client, { seedanceGatewayTransport: gateway })

      mgr.adopt({
        taskId: 'gw-9',
        prompt: 'p',
        model: '2.0',
        resolution: '720p',
        ratio: '16:9',
        duration: 5,
        billing: 'platform',
      })
      await vi.advanceTimersByTimeAsync(6_000)

      expect(gateway.queryTask).toHaveBeenCalledWith('gw-9')
      expect(client.queryTask).not.toHaveBeenCalled()
      mgr.dispose()
    })
  })

  // MCP 那条路没有渲染层,拿不到用户的意向。兜底的判据与
  // `seedanceGateway/credentials.ts` 是同一个函数,所以这里只钉「有没有被问」。
  describe('没有意向时的兜底(MCP 那条路)', () => {
    it('注入了 resolveBilling 就听它的', async () => {
      const client = makeClient([])
      const gateway = makeGatewayTransport()
      const mgr = makeManager(client, {
        seedanceGatewayTransport: gateway,
        resolveBilling: () => 'platform',
      })

      await mgr.submit({ input: INPUT, content: [] })

      expect(gateway.createTask).toHaveBeenCalledTimes(1)
      expect(client.createTask).not.toHaveBeenCalled()
      mgr.dispose()
    })

    it('显式意向优先于兜底 —— 兜底只在缺省时说话', async () => {
      const client = makeClient([])
      const gateway = makeGatewayTransport()
      const resolveBilling = vi.fn((prefer?: VideoBillingSource) => prefer ?? 'platform')
      const mgr = makeManager(client, { seedanceGatewayTransport: gateway, resolveBilling })

      await mgr.submit({ input: INPUT, content: [], billing: 'own-key' })

      expect(resolveBilling).toHaveBeenCalledWith('own-key')
      expect(client.createTask).toHaveBeenCalledTimes(1)
      expect(gateway.createTask).not.toHaveBeenCalled()
      mgr.dispose()
    })

    it('没注入 resolveBilling 时缺省 = 自填 Key,与接网关之前逐字节相同', async () => {
      const client = makeClient([])
      const gateway = makeGatewayTransport()
      const mgr = makeManager(client, { seedanceGatewayTransport: gateway })

      await mgr.submit({ input: INPUT, content: [] })

      expect(client.createTask).toHaveBeenCalledTimes(1)
      expect(gateway.createTask).not.toHaveBeenCalled()
      mgr.dispose()
    })
  })
})

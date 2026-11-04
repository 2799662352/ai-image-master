// 4K 只能由用户本人二次确认 —— MCP(AI)这一侧的三条入口都不能提交 4K:
//   - video_workbench_start:4K 卡被拦下,回包带 UHD_CONFIRM_REQUIRED 与转告用户的话;
//   - video_workbench_add_tasks + autoStart:卡照样填好,4K 那张留给用户点;
//   - video_workbench_finalize_draft:永远只出 1080p,参数里塞 resolution / uhdConfirmed 都不认。

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { AgentToolExecutor } from '../AgentToolExecutor'
import { useTabStore } from '../../../stores/useTabStore'
import { useQuotaStore } from '../../../stores/useQuotaStore'
import { resetAssetPreviewCacheForTest } from '../../video-workbench/assetPreview'
import {
  AGENT_AUTO_START_KEY,
  UHD_CONFIRM_REQUIRED,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../video-workbench/store'
import { resetWorkbenchDbForTest } from '../../video-workbench/WorkbenchDb'

function callTool(toolName: string, params: Record<string, unknown>): Promise<any> {
  return (
    new AgentToolExecutor() as unknown as {
      callVideoWorkbench: (n: string, p: Record<string, unknown>) => Promise<any>
    }
  ).callVideoWorkbench(toolName, params)
}

function mockSubmit() {
  const submit = vi.fn(async () => ({ success: true, taskId: 'task_new' }))
  ;(window as any).electronAPI = {
    videoWorkbench: { submit, reconcile: vi.fn(async () => []), repersist: vi.fn() },
  }
  return submit
}

const store = () => useVideoWorkbenchStore.getState()

beforeEach(() => {
  try {
    globalThis.localStorage?.removeItem(AGENT_AUTO_START_KEY)
  } catch {
    /* localStorage 不可用时用内存默认值 */
  }
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  resetAssetPreviewCacheForTest()
  useTabStore.setState({ activeTab: 'generate', previousTab: null })
  useQuotaStore.setState({ billingSource: 'platform' })
})

afterEach(() => {
  delete (window as any).electronAPI
})

describe('AI 不能提交 4K', () => {
  it('video_workbench_start:4K 卡被拦下、一次都不提交,同批 1080p 照常', async () => {
    const submit = mockSubmit()
    const [hd, uhd] = store().addCards([
      { prompt: '猫', model: '2.0', resolution: '1080p' },
      { prompt: '狗', model: '2.0', resolution: '4k' },
    ] as never)

    const res = await callTool('video_workbench_start', { cardIds: [hd, uhd] })

    expect(res.started).toEqual([hd])
    expect(res.skipped).toEqual([expect.objectContaining({ cardId: uhd, code: UHD_CONFIRM_REQUIRED })])
    expect(typeof res.hint).toBe('string')
    expect(submit).toHaveBeenCalledTimes(1)
    expect((submit.mock.calls[0] as unknown[])[0]).toMatchObject({ resolution: '1080p' })
  })

  it('参数里塞 uhdConfirmed:true 也不认', async () => {
    const submit = mockSubmit()
    const [uhd] = store().addCards([{ prompt: '狗', model: '2.0', resolution: '4k' }] as never)

    const res = await callTool('video_workbench_start', { cardIds: [uhd], uhdConfirmed: true })

    expect(submit).not.toHaveBeenCalled()
    expect(res.skipped).toEqual([expect.objectContaining({ cardId: uhd, code: UHD_CONFIRM_REQUIRED })])
  })

  it('add_tasks + autoStart:4K 卡照样填好,但留给用户点', async () => {
    const submit = mockSubmit()

    const res = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '赛博猫', model: '2.0', resolution: '4k' }],
      autoStart: true,
      navigate: false,
    })

    expect(submit).not.toHaveBeenCalled()
    expect(res.cardIds).toHaveLength(1)
    expect(store().cards[0]).toMatchObject({ prompt: '赛博猫', resolution: '4k', status: 'draft' })
    expect(res.start.skipped).toEqual([expect.objectContaining({ code: UHD_CONFIRM_REQUIRED })])
  })

  it('video_workbench_finalize_draft:永远 1080p,塞 resolution / uhdConfirmed 都不认', async () => {
    const submit = mockSubmit()
    // 先水合:工具入口会先 ensureHydrated,它会用库里的卡覆盖内存里手工改过的状态。
    await store().ensureHydrated()
    const [id] = store().addCards([{ prompt: '一只橘猫', model: '2.5' }] as never)
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) =>
        c.id === id
          ? {
              ...c,
              draft: true,
              draftRun: true,
              status: 'succeeded' as const,
              taskId: 'task_draft',
              startedAt: Date.now() - 1000,
            }
          : c,
      ),
    }))

    const res = await callTool('video_workbench_finalize_draft', {
      cardIds: [id],
      resolution: '4k',
      finalResolution: '4k',
      uhdConfirmed: true,
    })

    expect(res.started).toEqual([id])
    expect(submit).toHaveBeenCalledTimes(1)
    expect((submit.mock.calls[0] as unknown[])[0]).toMatchObject({
      fromDraftTaskId: 'task_draft',
      resolution: '1080p',
      finalResolution: '1080p',
    })
  })
})

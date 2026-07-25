// @vitest-environment node
//
// 轮询期间的暂时性失败不得让已付费任务永久失败。
//
// runProcessAndPoll 的轮询循环原先对 getMpsClient() / DescribeTaskDetail() 不设
// try/catch：一次网络抖动、STS 换票失败或 MPS 5xx 就会抛穿循环，而 JobQueue 没有
// 任何重试（runner 一抛就 onFailed），任务在界面上永久失败——可腾讯侧的任务还在
// 跑、钱已经付了，产物落在 COS 里没人要。
//
// 函数自己的注释只列了四个退出口（取消 / SUCCESS / FAIL / 其他终态），"接口暂时
// 抖动"不在其中，所以这是实现违背了自己声明的契约。设计上还特意支持长任务
// （>25min 要换 STS 票据），轮询轮次多，抖动累积概率不低。
//
// 这里不引入任务级超时——用户明确要过「我不需要超时失败」。持续失败仍会在有限
// 次数后如实失败，避免真正的永久错误无声地转圈。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const processMediaMock = vi.fn<(req: any) => Promise<any>>()
const describeTaskDetailMock = vi.fn<(req: any) => Promise<any>>()
const getMpsClientMock = vi.fn(async () => ({
  ProcessMedia: processMediaMock,
  DescribeTaskDetail: describeTaskDetailMock,
}))

vi.mock('../../tencent/cosClient', () => ({
  uploadStream: vi.fn(),
  getPresignedUrl: vi.fn(),
  cancelUpload: vi.fn(),
}))

vi.mock('../../tencent/mpsClient', () => ({
  getMpsClient: () => getMpsClientMock(),
}))

vi.mock('../../tencent/credentials', () => ({
  getCredentials: () => ({
    secretId: 'AKIDtestpermanent0001',
    secretKey: 'k',
    bucket: 'demo-1300000000',
    region: 'ap-shanghai',
  }),
  isLikelyValidSecretId: (id: string) =>
    typeof id === 'string' && id.startsWith('AKID') && id.length >= 20,
}))

import { runProcessAndPoll, POLL_MAX_CONSECUTIVE_FAILURES } from '../runner'

function processJob() {
  return {
    taskId: 'task-abc',
    filename: 'clip.mp4',
    durationSeconds: 30,
    config: { mode: 'definition' as const, definitionId: 303, autoCleanupRemoteAfterDays: 7 },
    inputCosKey: 'smart-erase/in/clip.mp4',
  }
}

const FINISH_SUCCESS = {
  Status: 'FINISH',
  WorkflowTask: {
    ErrCode: 0,
    SmartEraseTaskResult: { Status: 'SUCCESS', Output: { Path: '/smart-erase/abc/out.mp4' } },
  },
}

/** 轮询里的 sleep 用真实 setTimeout；用假时钟推进，并让微任务有机会跑完。 */
async function drain(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('runProcessAndPoll 轮询容错', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    processMediaMock.mockReset()
    describeTaskDetailMock.mockReset()
    getMpsClientMock.mockReset()
    getMpsClientMock.mockImplementation(async () => ({
      ProcessMedia: processMediaMock,
      DescribeTaskDetail: describeTaskDetailMock,
    }))
    processMediaMock.mockResolvedValue({ TaskId: 'mps-1' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('DescribeTaskDetail 单次网络抖动不判死刑，恢复后照常出结果', async () => {
    describeTaskDetailMock
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValue(FINISH_SUCCESS)

    const promise = runProcessAndPoll(processJob(), new AbortController().signal)
    await drain(120_000)

    await expect(promise).resolves.toMatchObject({ outputCosKey: expect.any(String) })
    expect(describeTaskDetailMock.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('getMpsClient 换票失败（STS 抖动）同样不判死刑', async () => {
    // 第 1 次取 client 是提交阶段（ProcessMedia），第 2 次起才是轮询 —— 要打中
    // 的是轮询那次换票，否则失败会落在 MPS_SUBMIT_FAILED 上。
    let clientCalls = 0
    getMpsClientMock.mockImplementation(async () => {
      clientCalls++
      if (clientCalls === 2) throw new Error('STS token refresh failed')
      return { ProcessMedia: processMediaMock, DescribeTaskDetail: describeTaskDetailMock }
    })
    describeTaskDetailMock.mockResolvedValue(FINISH_SUCCESS)

    const promise = runProcessAndPoll(processJob(), new AbortController().signal)
    await drain(120_000)

    await expect(promise).resolves.toMatchObject({ outputCosKey: expect.any(String) })
  })

  it('连续多次抖动仍能恢复（不是只容忍一次）', async () => {
    for (let i = 0; i < 4; i++) describeTaskDetailMock.mockRejectedValueOnce(new Error('ECONNRESET'))
    describeTaskDetailMock.mockResolvedValue(FINISH_SUCCESS)

    const promise = runProcessAndPoll(processJob(), new AbortController().signal)
    await drain(600_000)

    await expect(promise).resolves.toMatchObject({ outputCosKey: expect.any(String) })
  })

  it('持续失败到上限后如实失败，不无声转圈', async () => {
    describeTaskDetailMock.mockRejectedValue(new Error('AuthFailure.SignatureFailure'))

    const promise = runProcessAndPoll(processJob(), new AbortController().signal)
    const assertion = expect(promise).rejects.toMatchObject({
      stage: 'poll',
      message: expect.stringContaining('AuthFailure'),
    })
    await drain(30 * 60_000)
    await assertion

    expect(describeTaskDetailMock).toHaveBeenCalledTimes(POLL_MAX_CONSECUTIVE_FAILURES)
  })

  it('中途成功会重置失败计数（长任务里零星抖动不累积成失败）', async () => {
    const processing = { Status: 'PROCESSING' }
    // 抖 3 次 → 成功一轮（PROCESSING）→ 再抖 3 次 → 出结果。
    // 若失败计数不重置，6 次累积会在上限为 5 时误判失败。
    describeTaskDetailMock
      .mockRejectedValueOnce(new Error('blip-1'))
      .mockRejectedValueOnce(new Error('blip-2'))
      .mockRejectedValueOnce(new Error('blip-3'))
      .mockResolvedValueOnce(processing)
      .mockRejectedValueOnce(new Error('blip-4'))
      .mockRejectedValueOnce(new Error('blip-5'))
      .mockRejectedValueOnce(new Error('blip-6'))
      .mockResolvedValue(FINISH_SUCCESS)

    const promise = runProcessAndPoll(processJob(), new AbortController().signal)
    await drain(900_000)

    await expect(promise).resolves.toMatchObject({ outputCosKey: expect.any(String) })
  })

  it('抖动期间用户取消仍立即生效', async () => {
    describeTaskDetailMock.mockRejectedValue(new Error('ETIMEDOUT'))
    const controller = new AbortController()

    const promise = runProcessAndPoll(processJob(), controller.signal)
    const assertion = expect(promise).rejects.toMatchObject({ code: 'TASK_CANCELLED' })
    await drain(20_000)
    controller.abort()
    await drain(120_000)
    await assertion
  })

  it('终态失败（MPS 明确 FAIL）不受容错影响，仍立刻失败', async () => {
    describeTaskDetailMock.mockResolvedValue({
      Status: 'FINISH',
      WorkflowTask: {
        ErrCode: 0,
        SmartEraseTaskResult: { Status: 'FAIL', ErrCodeExt: 'InvalidInput', Message: '源文件损坏' },
      },
    })

    const promise = runProcessAndPoll(processJob(), new AbortController().signal)
    const assertion = expect(promise).rejects.toMatchObject({ code: 'MPS_TASK_FAILED' })
    await drain(60_000)
    await assertion
  })
})

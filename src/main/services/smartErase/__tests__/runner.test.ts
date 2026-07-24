// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const uploadStreamMock = vi.fn<(opts: any) => Promise<void>>()
const getPresignedUrlMock = vi.fn<(opts: any) => Promise<string>>()
const cancelUploadMock = vi.fn<(taskId: string) => void>()

const processMediaMock = vi.fn<(req: any) => Promise<any>>()
const describeTaskDetailMock = vi.fn<(req: any) => Promise<any>>()

vi.mock('../../tencent/cosClient', () => ({
  uploadStream: uploadStreamMock,
  getPresignedUrl: getPresignedUrlMock,
  cancelUpload: cancelUploadMock,
}))

vi.mock('../../tencent/mpsClient', () => ({
  getMpsClient: () => ({
    ProcessMedia: processMediaMock,
    DescribeTaskDetail: describeTaskDetailMock,
  }),
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

function freshJob(overrides: Record<string, any> = {}) {
  return {
    taskId: 'task-abc',
    filePath: '/local/videos/clip.mp4',
    filename: 'clip.mp4',
    durationSeconds: 30,
    posterDataUrl: 'data:image/jpeg;base64,POSTER',
    config: { mode: 'definition' as const, definitionId: 303, autoCleanupRemoteAfterDays: 7 },
    ...overrides,
  }
}

function buildFinishSuccess(outputPath = '/smart-erase/abc/output.mp4') {
  return {
    Status: 'FINISH',
    WorkflowTask: {
      ErrCode: 0,
      SmartEraseTaskResult: {
        Status: 'SUCCESS',
        Output: { Path: outputPath },
      },
    },
  }
}

describe('smartErase/runner.runEraseJob', () => {
  beforeEach(() => {
    vi.resetModules()
    uploadStreamMock.mockReset()
    getPresignedUrlMock.mockReset()
    cancelUploadMock.mockReset()
    processMediaMock.mockReset()
    describeTaskDetailMock.mockReset()

    uploadStreamMock.mockResolvedValue(undefined)
    getPresignedUrlMock.mockResolvedValue('https://cos.example/presigned')
    processMediaMock.mockResolvedValue({ TaskId: 'mps-task-1' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('Test 1: happy path uploads, submits ProcessMedia with SmartEraseTask at TOP LEVEL, polls, returns presigned URL', async () => {
    vi.useFakeTimers()
    let polls = 0
    describeTaskDetailMock.mockImplementation(() => {
      polls++
      if (polls === 1) return Promise.resolve({ Status: 'PROCESSING' })
      return Promise.resolve(buildFinishSuccess('/smart-erase/abc/output.mp4'))
    })

    const { runEraseJob } = await import('../runner')
    const ctrl = new AbortController()
    const job = freshJob()
    const promise = runEraseJob(job, ctrl.signal)

    await vi.advanceTimersByTimeAsync(6_000) // 5s wait between poll 1 and 2

    const result = await promise

    // upload
    expect(uploadStreamMock).toHaveBeenCalledTimes(1)
    expect(uploadStreamMock.mock.calls[0][0]).toMatchObject({
      key: 'smart-erase/task-abc/input/clip.mp4',
      filePath: '/local/videos/clip.mp4',
    })

    // submit
    expect(processMediaMock).toHaveBeenCalledTimes(1)
    const submitArg = processMediaMock.mock.calls[0][0]
    expect(submitArg.InputInfo).toEqual({
      Type: 'COS',
      CosInputInfo: { Bucket: 'demo-1300000000', Region: 'ap-shanghai', Object: '/smart-erase/task-abc/input/clip.mp4' },
    })
    expect(submitArg.OutputStorage).toEqual({
      Type: 'COS',
      CosOutputStorage: { Bucket: 'demo-1300000000', Region: 'ap-shanghai' },
    })
    expect(submitArg.OutputDir).toBe('/smart-erase/task-abc/output/')
    // CRITICAL: SmartEraseTask is TOP-LEVEL on the request, single object, NOT nested in MediaProcessTask, NOT a *Set array.
    expect(submitArg.SmartEraseTask).toEqual({ Definition: 303 })
    expect('MediaProcessTask' in submitArg).toBe(false)

    // poll resolved + presigned
    expect(describeTaskDetailMock).toHaveBeenCalledTimes(2)
    expect(describeTaskDetailMock.mock.calls[0][0]).toEqual({ TaskId: 'mps-task-1' })
    expect(getPresignedUrlMock).toHaveBeenCalledWith({
      key: 'smart-erase/abc/output.mp4',
      expireSeconds: 7 * 86400,
    })

    expect(result).toMatchObject({
      videoUrl: 'https://cos.example/presigned',
      outputCosKey: 'smart-erase/abc/output.mp4',
      inputCosKey: 'smart-erase/task-abc/input/clip.mp4',
      posterDataUrl: 'data:image/jpeg;base64,POSTER',
      mpsTaskId: 'mps-task-1',
    })
    expect(result.videoExpiresAt).toBeGreaterThan(Date.now())
  })

  it('Test 2: leading-slash on Output.Path is stripped from outputCosKey', async () => {
    describeTaskDetailMock.mockResolvedValueOnce(buildFinishSuccess('/smart-erase/abc/output.mp4'))

    const { runEraseJob } = await import('../runner')
    const result = await runEraseJob(freshJob(), new AbortController().signal)
    expect(result.outputCosKey).toBe('smart-erase/abc/output.mp4')
    expect(result.outputCosKey.startsWith('/')).toBe(false)
  })

  it('Test 3: SmartEraseTaskResult.Status === FAIL throws MPS_TASK_FAILED with ErrCodeExt + Message', async () => {
    describeTaskDetailMock.mockResolvedValueOnce({
      Status: 'FINISH',
      WorkflowTask: {
        ErrCode: 0,
        SmartEraseTaskResult: { Status: 'FAIL', ErrCodeExt: 'X', Message: 'msg' },
      },
    })

    const { runEraseJob } = await import('../runner')
    await expect(runEraseJob(freshJob(), new AbortController().signal)).rejects.toMatchObject({
      code: 'MPS_TASK_FAILED',
      message: expect.stringContaining('X: msg'),
    })
  })

  it('Test 4: WorkflowTask.ErrCode != 0 throws MPS_SOURCE_ERROR (and check happens BEFORE SmartEraseTaskResult lookup)', async () => {
    // No SmartEraseTaskResult here — ErrCode check must run first; otherwise we'd OUTPUT_NOT_FOUND instead.
    describeTaskDetailMock.mockResolvedValueOnce({
      Status: 'FINISH',
      WorkflowTask: { ErrCode: 1234, Message: 'source corrupt' },
    })

    const { runEraseJob } = await import('../runner')
    await expect(runEraseJob(freshJob(), new AbortController().signal)).rejects.toMatchObject({
      code: 'MPS_SOURCE_ERROR',
      message: expect.stringContaining('1234: source corrupt'),
    })
  })

  it('Test 5: Status === FINISH but WorkflowTask missing → OUTPUT_NOT_FOUND', async () => {
    describeTaskDetailMock.mockResolvedValueOnce({ Status: 'FINISH' })
    const { runEraseJob } = await import('../runner')
    await expect(runEraseJob(freshJob(), new AbortController().signal)).rejects.toMatchObject({
      code: 'OUTPUT_NOT_FOUND',
    })
  })

  it('Test 6: ErrCode == 0 + SmartEraseTaskResult missing → OUTPUT_NOT_FOUND', async () => {
    describeTaskDetailMock.mockResolvedValueOnce({
      Status: 'FINISH',
      WorkflowTask: { ErrCode: 0 }, // no SmartEraseTaskResult
    })
    const { runEraseJob } = await import('../runner')
    await expect(runEraseJob(freshJob(), new AbortController().signal)).rejects.toMatchObject({
      code: 'OUTPUT_NOT_FOUND',
    })
  })

  it('Test 7: SUCCESS but Output.Path empty string → OUTPUT_NOT_FOUND', async () => {
    describeTaskDetailMock.mockResolvedValueOnce({
      Status: 'FINISH',
      WorkflowTask: {
        ErrCode: 0,
        SmartEraseTaskResult: { Status: 'SUCCESS', Output: { Path: '' } },
      },
    })
    const { runEraseJob } = await import('../runner')
    await expect(runEraseJob(freshJob(), new AbortController().signal)).rejects.toMatchObject({
      code: 'OUTPUT_NOT_FOUND',
    })
  })

  it('Test 8: SUCCESS but Output undefined → OUTPUT_NOT_FOUND', async () => {
    describeTaskDetailMock.mockResolvedValueOnce({
      Status: 'FINISH',
      WorkflowTask: {
        ErrCode: 0,
        SmartEraseTaskResult: { Status: 'SUCCESS' /* no Output */ },
      },
    })
    const { runEraseJob } = await import('../runner')
    await expect(runEraseJob(freshJob(), new AbortController().signal)).rejects.toMatchObject({
      code: 'OUTPUT_NOT_FOUND',
    })
  })

  it('Test 9: top-level Status === WAITING continues polling (does not throw)', async () => {
    vi.useFakeTimers()
    let polls = 0
    describeTaskDetailMock.mockImplementation(() => {
      polls++
      if (polls === 1) return Promise.resolve({ Status: 'WAITING' })
      return Promise.resolve(buildFinishSuccess())
    })

    const { runEraseJob } = await import('../runner')
    const promise = runEraseJob(freshJob(), new AbortController().signal)
    await vi.advanceTimersByTimeAsync(6_000)
    await promise // resolves without throwing
    expect(describeTaskDetailMock).toHaveBeenCalledTimes(2)
  })

  it('Test 10: SmartEraseTaskResult.Status === PROCESSING continues even when Status === FINISH', async () => {
    vi.useFakeTimers()
    let polls = 0
    describeTaskDetailMock.mockImplementation(() => {
      polls++
      if (polls === 1) {
        return Promise.resolve({
          Status: 'FINISH',
          WorkflowTask: { ErrCode: 0, SmartEraseTaskResult: { Status: 'PROCESSING' } },
        })
      }
      return Promise.resolve(buildFinishSuccess())
    })

    const { runEraseJob } = await import('../runner')
    const promise = runEraseJob(freshJob(), new AbortController().signal)
    await vi.advanceTimersByTimeAsync(6_000)
    await promise
    expect(describeTaskDetailMock).toHaveBeenCalledTimes(2)
  })

  it('Test 11: 90-min source → poll deadline = 90*60*4*1000 ms (≈6h), not 60-min floor', async () => {
    const { calculatePollDeadline } = await import('../runner')
    const now = 1_000_000
    const result = calculatePollDeadline(90 * 60, now)
    expect(result - now).toBe(90 * 60 * 4 * 1000) // 6 hours = 21,600,000 ms
  })

  it('Test 12: 5-min source → poll deadline pinned to 60-min floor (because 5*60*4 = 1200s < 3600s)', async () => {
    const { calculatePollDeadline } = await import('../runner')
    const now = 1_000_000
    const result = calculatePollDeadline(5 * 60, now)
    expect(result - now).toBe(60 * 60 * 1000) // 60-min floor
  })

  it('Test 13: signal.aborted right after upload → throws TASK_CANCELLED BEFORE ProcessMedia is called', async () => {
    const ctrl = new AbortController()
    uploadStreamMock.mockImplementationOnce(async () => {
      ctrl.abort()
    })

    const { runEraseJob } = await import('../runner')
    await expect(runEraseJob(freshJob(), ctrl.signal)).rejects.toMatchObject({
      code: 'TASK_CANCELLED',
    })
    expect(processMediaMock).not.toHaveBeenCalled()
  })

  it('Test 14: signal.aborted mid-poll → throws TASK_CANCELLED, no further DescribeTaskDetail calls', async () => {
    vi.useFakeTimers()
    const ctrl = new AbortController()
    let polls = 0
    describeTaskDetailMock.mockImplementation(() => {
      polls++
      if (polls === 1) return Promise.resolve({ Status: 'PROCESSING' })
      throw new Error('Should not be called after abort')
    })

    const { runEraseJob } = await import('../runner')
    const promise = runEraseJob(freshJob(), ctrl.signal)
    promise.catch(() => {})

    // Let poll 1 happen + start the 5s wait
    await vi.advanceTimersByTimeAsync(0)
    // Abort during the wait
    ctrl.abort()
    await vi.advanceTimersByTimeAsync(6_000)

    await expect(promise).rejects.toMatchObject({ code: 'TASK_CANCELLED' })
    expect(describeTaskDetailMock).toHaveBeenCalledTimes(1) // only the first poll
  })

  it('Test 15: ProcessMedia rejects with InvalidParameterValue.Definition → TEMPLATE_NOT_FOUND', async () => {
    const sdkErr: any = new Error('Definition 303 not found')
    sdkErr.code = 'InvalidParameterValue.Definition'
    processMediaMock.mockRejectedValueOnce(sdkErr)

    const { runEraseJob } = await import('../runner')
    await expect(runEraseJob(freshJob(), new AbortController().signal)).rejects.toMatchObject({
      code: 'TEMPLATE_NOT_FOUND',
    })
  })

  it('Test 16: NaN/Infinity/negative durationSeconds → calculatePollDeadline falls back to 60-min floor (not NaN)', async () => {
    const { calculatePollDeadline } = await import('../runner')
    const now = 1_000_000
    expect(calculatePollDeadline(NaN, now) - now).toBe(60 * 60 * 1000)
    expect(calculatePollDeadline(Infinity, now) - now).toBe(60 * 60 * 1000)
    expect(calculatePollDeadline(-50, now) - now).toBe(60 * 60 * 1000)
    expect(calculatePollDeadline(0, now) - now).toBe(60 * 60 * 1000)
  })

  it('Test 17: Output.Path with multiple leading slashes is fully stripped', async () => {
    describeTaskDetailMock.mockResolvedValueOnce(buildFinishSuccess('//smart-erase/abc/output.mp4'))

    const { runEraseJob } = await import('../runner')
    const result = await runEraseJob(freshJob(), new AbortController().signal)
    expect(result.outputCosKey).toBe('smart-erase/abc/output.mp4')
    expect(result.outputCosKey.startsWith('/')).toBe(false)
  })

  // ──────────────────────────────────────────────────────────────────────
  // 2026-05-15 — user feedback "我不需要超时失败" + "这里明明有真实进度条 以及任务详情"
  // These tests lock in three behaviour changes shipped together:
  //   18: runner no longer throws POLL_TIMEOUT — it polls until cancel or
  //       terminal status, even past the legacy 60-min "deadline".
  //   19: each poll emits the real Tencent `SmartEraseTaskResult.Progress`
  //       value via onProgress.mpsProgress (so the UI bar matches the
  //       MPS console's "进行中 94%").
  //   20: each poll emits a curated task-detail snapshot so the renderer
  //       can render the "查看详情" panel without IPC-forwarding the whole
  //       SDK payload (codec metadata + audio streams etc).
  // ──────────────────────────────────────────────────────────────────────
  it('Test 18a: never throws POLL_TIMEOUT — polls way past the old 60-min deadline, then succeeds', async () => {
    vi.useFakeTimers()
    // The mock keeps the task in PROCESSING for the first 199 polls and
    // only flips to SUCCESS on poll 200. This 199-poll prefix is the test
    // scenario, NOT a production cap — production code has `while (true)`
    // with no `attempt < N` guard (see runner.ts:207). We just need a
    // finite number here so the test can eventually finish and assert.
    //
    // Total fake-time consumed: 199 * pollIntervalMs(attempt) which sits
    // at the 60s cap from attempt 10 onwards → roughly 199 * 60s ≈ 200min,
    // dwarfing the legacy 60-min POLL_TIMEOUT_FLOOR_MS that used to kill
    // the task. The promise resolves on poll 200 with the SUCCESS payload.
    let polls = 0
    describeTaskDetailMock.mockImplementation(() => {
      polls++
      if (polls < 200) return Promise.resolve({ Status: 'PROCESSING' })
      return Promise.resolve(buildFinishSuccess('/smart-erase/abc/long.mp4'))
    })

    const { runEraseJob } = await import('../runner')
    const promise = runEraseJob(freshJob({ durationSeconds: 5 }), new AbortController().signal)

    // 200 * 60s of fake time — more than 3× the old 60-min deadline.
    await vi.advanceTimersByTimeAsync(200 * 60_000)

    await expect(promise).resolves.toMatchObject({
      outputCosKey: 'smart-erase/abc/long.mp4',
    })
    expect(polls).toBe(200)
  })

  it('Test 18b: loop has no built-in attempt or time cap — promise stays pending forever on permanent PROCESSING', async () => {
    vi.useFakeTimers()
    // Counterpart to 18a: if MPS NEVER returns a terminal status, the
    // promise must NEVER reject on its own — only user cancel (signal)
    // or a terminal Status from Tencent can end it.
    //
    // We let the mock pin to PROCESSING forever, advance fake time by
    // three hours, and verify (a) the promise has not settled and
    // (b) the runner is still polling. This is the spec-level lock-in:
    // "不要限制 不要主动退出 不要有时间限制".
    describeTaskDetailMock.mockResolvedValue({ Status: 'PROCESSING' })

    const { runEraseJob } = await import('../runner')
    const ctrl = new AbortController()
    let settled = false
    const promise = runEraseJob(freshJob(), ctrl.signal)
    // Attach a swallow-catch so Node doesn't surface the eventual
    // TASK_CANCELLED rejection as an unhandled-promise warning before
    // the explicit `.rejects.toMatchObject` below awaits it.
    promise.catch(() => {})
    promise.then(
      () => { settled = true },
      () => { settled = true },
    )

    // Three hours is 3× the removed 60-minute deadline and yields over
    // 100 polls without forcing coverage runs through ~525,000 callbacks.
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000)

    expect(settled).toBe(false)
    // Lower bound: at least 100 polls — the actual count is much higher
    // (three hours / 60s cap ≈ 180) but we don't need to pin the exact value.
    expect(describeTaskDetailMock.mock.calls.length).toBeGreaterThan(100)

    // Only the user's cancel ends it — terminating cleanly so the test
    // doesn't leak a dangling promise.
    ctrl.abort()
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(promise).rejects.toMatchObject({ code: 'TASK_CANCELLED' })
  })

  it('Test 19: onProgress receives real mpsProgress on every poll while PROCESSING', async () => {
    vi.useFakeTimers()
    let polls = 0
    describeTaskDetailMock.mockImplementation(() => {
      polls++
      if (polls === 1) {
        return Promise.resolve({
          Status: 'PROCESSING',
          WorkflowTask: { ErrCode: 0, SmartEraseTaskResult: { Status: 'PROCESSING', Progress: 17 } },
        })
      }
      if (polls === 2) {
        return Promise.resolve({
          Status: 'PROCESSING',
          WorkflowTask: { ErrCode: 0, SmartEraseTaskResult: { Status: 'PROCESSING', Progress: 64 } },
        })
      }
      return Promise.resolve({
        Status: 'FINISH',
        WorkflowTask: {
          ErrCode: 0,
          SmartEraseTaskResult: { Status: 'SUCCESS', Progress: 100, Output: { Path: '/p.mp4' } },
        },
      })
    })

    const progressPatches: Array<Record<string, unknown>> = []
    const { runEraseJob } = await import('../runner')
    const promise = runEraseJob(freshJob(), new AbortController().signal, {
      onProgress: (p) => progressPatches.push({ ...p }),
    })

    // 2 inter-poll waits (~6s each after backoff math)
    await vi.advanceTimersByTimeAsync(15_000)
    await promise

    // Filter to only the processing-stage patches with mpsProgress —
    // there's also a 'submitting' + initial 'processing' (mpsTaskId only).
    const progressEmits = progressPatches
      .filter((p) => p.mpsProgress !== undefined)
      .map((p) => p.mpsProgress)
    expect(progressEmits).toEqual([17, 64, 100])
  })

  it('Test 20: onProgress carries a curated taskDetail snapshot on every poll', async () => {
    describeTaskDetailMock.mockResolvedValueOnce({
      Status: 'FINISH',
      WorkflowTask: {
        ErrCode: 0,
        Message: 'SUCCESS',
        SmartEraseTaskResult: {
          Status: 'SUCCESS',
          Progress: 100,
          ErrCodeExt: '',
          Message: 'SUCCESS',
          BeginProcessTime: '2026-05-15T13:20:30Z',
          FinishTime: '2026-05-15T13:20:56Z',
          Output: { Path: '/smart-erase/abc/out.mp4' },
        },
      },
    })

    const progressPatches: Array<Record<string, any>> = []
    const { runEraseJob } = await import('../runner')
    await runEraseJob(freshJob(), new AbortController().signal, {
      onProgress: (p) => progressPatches.push({ ...p }),
    })

    const withDetail = progressPatches.find((p) => p.taskDetail)
    expect(withDetail?.taskDetail).toMatchObject({
      workflowStatus: 'FINISH',
      smartEraseStatus: 'SUCCESS',
      progress: 100,
      workflowErrCode: 0,
      workflowMessage: 'SUCCESS',
      beginProcessTime: '2026-05-15T13:20:30Z',
      finishTime: '2026-05-15T13:20:56Z',
      outputPath: '/smart-erase/abc/out.mp4',
    })
    expect(typeof withDetail?.taskDetail.fetchedAt).toBe('number')
  })

  it('Test 21: summarizeTaskDetail clamps Progress to 0–100 and survives missing fields', async () => {
    const { summarizeTaskDetail } = await import('../runner')

    // Realistic in-flight payload — top-level PROCESSING, no WorkflowTask yet.
    expect(summarizeTaskDetail({ Status: 'WAITING' }, 1234)).toMatchObject({
      workflowStatus: 'WAITING',
      progress: undefined,
      fetchedAt: 1234,
    })

    // Out-of-range progress (e.g. SDK bug) gets clamped, not propagated raw.
    expect(
      summarizeTaskDetail({
        Status: 'PROCESSING',
        WorkflowTask: {
          ErrCode: 0,
          SmartEraseTaskResult: { Status: 'PROCESSING', Progress: 150 },
        },
      }, 5).progress,
    ).toBe(100)
    expect(
      summarizeTaskDetail({
        Status: 'PROCESSING',
        WorkflowTask: { SmartEraseTaskResult: { Progress: -10 } },
      }, 5).progress,
    ).toBe(0)

    // Garbage / undefined yields undefined progress (no NaN leakage).
    expect(summarizeTaskDetail({}, 0).progress).toBeUndefined()
    expect(summarizeTaskDetail(null, 0).progress).toBeUndefined()
  })
})

describe('pollIntervalMs (exponential backoff)', () => {
  it('attempt 1 → 5000ms', async () => {
    const { pollIntervalMs } = await import('../runner')
    expect(pollIntervalMs(1)).toBe(5000)
  })

  it('attempt 2 → 7000ms', async () => {
    const { pollIntervalMs } = await import('../runner')
    expect(pollIntervalMs(2)).toBe(7000)
  })

  it('attempt 3 → 9800ms', async () => {
    const { pollIntervalMs } = await import('../runner')
    expect(pollIntervalMs(3)).toBe(9800)
  })

  it('attempt 5 → 19208ms', async () => {
    const { pollIntervalMs } = await import('../runner')
    expect(pollIntervalMs(5)).toBe(19208)
  })

  it('attempt 10 → 60000ms (cap)', async () => {
    const { pollIntervalMs } = await import('../runner')
    expect(pollIntervalMs(10)).toBe(60000)
  })

  it('attempt 20 → still 60000ms (cap holds)', async () => {
    const { pollIntervalMs } = await import('../runner')
    expect(pollIntervalMs(20)).toBe(60000)
  })
})

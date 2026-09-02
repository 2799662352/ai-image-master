// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const runUploadMock = vi.fn()
const runProcessAndPollMock = vi.fn()
const trackForReapingMock = vi.fn()
const deleteObjectsMock = vi.fn()
const transferUrlToHistoryBucketMock = vi.fn()
const getCredentialsMock = vi.fn(() => ({
  secretId: 'sid',
  secretKey: 'sk',
  bucket: 'b-1',
  region: 'ap-shanghai',
}))
const getCredentialStateMock = vi.fn(() => ({ hasCredentials: true }))
const setCredentialsMock = vi.fn()

vi.mock('../runner', () => ({
  runUpload: runUploadMock,
  runProcessAndPoll: runProcessAndPollMock,
}))

vi.mock('../reaper', () => ({
  trackForReaping: trackForReapingMock,
}))

vi.mock('../../tencent/cosClient', () => ({
  deleteObjects: deleteObjectsMock,
}))

vi.mock('../../tencent/historyBucketTransfer', () => ({
  transferUrlToHistoryBucket: transferUrlToHistoryBucketMock,
}))

vi.mock('../../tencent/credentials', () => ({
  getCredentials: getCredentialsMock,
  getCredentialState: getCredentialStateMock,
  setCredentials: setCredentialsMock,
}))

// ── 高清那条路的替身 ──────────────────────────────────────────────────────
const runMediaKitUploadMock = vi.fn()
const runMediaKitProcessAndPollMock = vi.fn()
vi.mock('../../mediaKit/runner', () => ({
  runMediaKitUpload: runMediaKitUploadMock,
  runMediaKitProcessAndPoll: runMediaKitProcessAndPollMock,
}))
// 主进程里 `import { net } from 'electron'`;测试环境没有 electron 运行时。
vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))
// 平台池 token 与自填 Miau Key 的可控替身。只替换读值函数,其余保持真实现。
const poolTokenForTest = vi.hoisted(() => ({ value: null as string | null }))
const wan3KeyForTest = vi.hoisted(() => ({ value: '' }))
vi.mock('../../auth/gatewayToken', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../auth/gatewayToken')>()
  return {
    ...actual,
    getActivePoolToken: () => poolTokenForTest.value,
    // 真实现从模块内部的 activePool / credential 推归属头,这里没法喂;替身只要
    // 让「走了整份组头函数」与「手拼裸 Authorization」在断言上分得开就够了。
    gatewayPlatformHeaders: (token: string) => ({
      Authorization: `Bearer ${token}`,
      'X-Platform-User-Id': 'u-test',
      'X-Project-Id': '345',
    }),
  }
})
vi.mock('../../wan3/credentials', () => ({ getWan3ApiKey: () => wan3KeyForTest.value }))
vi.mock('../../auth/gatewayHeaderInjector', () => ({ resolveGatewayOrigin: () => 'https://gw.test' }))
vi.mock('../../auth/platformSpend', () => ({ notePlatformSpend: vi.fn() }))

// Window stub
const sendSpy = vi.fn()
const mockWin = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    send: sendSpy,
  },
}

// 这组用例测的是 MPS 去字幕那条路,所以显式点名 `tool: 'erase'`。
// 页面默认已经改成高清(2026-09-01),不带 tool 会走另一条完全不同的链路。
const SUBMIT_PAYLOAD = {
  filePath: '/tmp/test.mp4',
  filename: 'test.mp4',
  fileSize: 1024,
  durationSeconds: 30,
  tool: 'erase' as const,
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('smartErase service composer', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetModules()
    runUploadMock.mockReset()
    runProcessAndPollMock.mockReset()
    trackForReapingMock.mockReset()
    deleteObjectsMock.mockReset()
    transferUrlToHistoryBucketMock.mockReset()
    sendSpy.mockClear()

    runUploadMock.mockResolvedValue({ inputCosKey: 'smart-erase/x/input/test.mp4' })
    runProcessAndPollMock.mockResolvedValue({
      videoUrl: 'https://cos.example/output.mp4?sig=abc',
      videoExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      outputCosKey: 'smart-erase/x/output/done.mp4',
      mpsTaskId: 'mps-123',
    })
    transferUrlToHistoryBucketMock.mockResolvedValue(
      'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/smart-erase/x.mp4',
    )

    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('Test 1: submitErase invokes runner and reports activeCount', async () => {
    // runUpload pauses long enough for us to observe an active task.
    let resolveUpload: (v: any) => void = () => {}
    runUploadMock.mockReturnValueOnce(new Promise((r) => { resolveUpload = r }))

    const svc = await import('../index')
    svc.setMainWindow(mockWin as any)

    const ret = await svc.submitErase(SUBMIT_PAYLOAD)
    expect(ret.success).toBe(true)
    expect(ret.taskId).toBeDefined()

    // Active task is sitting in the upload queue, runUpload pending
    expect(svc.getActiveCount()).toBe(1)
    expect(runUploadMock).toHaveBeenCalledTimes(1)
    const [uploadArg, signalArg] = runUploadMock.mock.calls[0]
    expect(uploadArg.filePath).toBe('/tmp/test.mp4')
    expect(uploadArg.filename).toBe('test.mp4')
    expect(uploadArg.taskId).toBe(ret.taskId)
    expect(signalArg).toBeInstanceOf(AbortSignal)

    // Cleanup so the test doesn't leak an unresolved promise
    resolveUpload({ inputCosKey: 'smart-erase/x/input/test.mp4' })
    await flush()
    await flush()
  })

  it('Test 2: cancel during processing → reaper.trackForReaping called, status=cancelled emitted', async () => {
    // Make the process phase emit mpsTaskId then hang until aborted.
    runProcessAndPollMock.mockImplementationOnce(async (_job, signal, events) => {
      events?.onProgress?.({ stage: 'processing', mpsTaskId: 'mps-cancel-test' })
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('Cancelled'), { code: 'TASK_CANCELLED', stage: 'poll' }))
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort)
      })
      throw new Error('unreachable')
    })

    const svc = await import('../index')
    svc.setMainWindow(mockWin as any)

    const ret = await svc.submitErase(SUBMIT_PAYLOAD)
    const taskId = ret.taskId!

    // Let upload finish, processQueue picks up, runProcessAndPollMock fires onProgress
    await flush()
    await flush()
    await flush()

    // mpsTaskId should now be tracked
    const progressCalls = sendSpy.mock.calls.filter((c) => c[0] === 'erase:progress')
    expect(progressCalls.some((c) => c[1].mpsTaskId === 'mps-cancel-test')).toBe(true)

    // Cancel — should hit processing phase, route to reaper
    svc.cancelEraseTask(taskId)
    await flush()
    await flush()

    expect(trackForReapingMock).toHaveBeenCalledWith(
      'mps-cancel-test',
      'smart-erase/x/input/test.mp4',
    )

    const cancelledEvent = sendSpy.mock.calls
      .filter((c) => c[0] === 'erase:progress')
      .find((c) => c[1].status === 'cancelled')
    expect(cancelledEvent).toBeDefined()
    expect(cancelledEvent![1].taskId).toBe(taskId)
  })

  it('Test 3: cancelAllActiveSmartEraseTasks aborts all tasks; does NOT clear reaper', async () => {
    runUploadMock.mockImplementation(() => new Promise(() => { /* hang forever */ }))

    const svc = await import('../index')
    svc.setMainWindow(mockWin as any)

    await svc.submitErase({ ...SUBMIT_PAYLOAD, filename: 'a.mp4' })
    await svc.submitErase({ ...SUBMIT_PAYLOAD, filename: 'b.mp4' })
    await svc.submitErase({ ...SUBMIT_PAYLOAD, filename: 'c.mp4' })
    expect(svc.getActiveCount()).toBe(3)

    svc.cancelAllActiveSmartEraseTasks()
    await flush()
    await flush()

    expect(svc.getActiveCount()).toBe(0)
    // Reaper is NOT touched by cancelAll — only by individual cancels during processing
    // (these tasks are in upload phase, no MPS submitted yet, so trackForReaping should NOT fire)
    expect(trackForReapingMock).not.toHaveBeenCalled()
  })

  it('Test 4: 完成后转存历史桶 → erase:finished 带永久 URL 且 videoExpiresAt=0', async () => {
    const svc = await import('../index')
    svc.setMainWindow(mockWin as any)

    const ret = await svc.submitErase(SUBMIT_PAYLOAD)
    // upload → process → transfer 三段都是 microtask/immediate 链
    await flush(); await flush(); await flush(); await flush()

    expect(transferUrlToHistoryBucketMock).toHaveBeenCalledWith({
      sourceUrl: 'https://cos.example/output.mp4?sig=abc',
      key: `image-history/smart-erase/${ret.taskId}.mp4`,
      contentType: 'video/mp4',
    })

    const finished = sendSpy.mock.calls.find((c) => c[0] === 'erase:finished')
    expect(finished).toBeDefined()
    expect(finished![1].videoUrl).toBe(
      'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/smart-erase/x.mp4',
    )
    expect(finished![1].videoExpiresAt).toBe(0)
  })

  it('Test 5: 转存失败不影响任务成功 → 退回签名 URL + 原过期时间', async () => {
    transferUrlToHistoryBucketMock.mockRejectedValueOnce(new Error('bucket down'))

    const svc = await import('../index')
    svc.setMainWindow(mockWin as any)

    await svc.submitErase(SUBMIT_PAYLOAD)
    await flush(); await flush(); await flush(); await flush()

    const finished = sendSpy.mock.calls.find((c) => c[0] === 'erase:finished')
    expect(finished).toBeDefined()
    expect(finished![1].videoUrl).toBe('https://cos.example/output.mp4?sig=abc')
    expect(finished![1].videoExpiresAt).toBeGreaterThan(0)
  })

})

/**
 * 高清那条路。与去字幕共用页面壳与两条队列,但上传、上游、凭据三样全换:
 * 中转桶 URL → Miau 网关 MediaKit → 平台余额 / 自填 Miau Key。
 */
describe('smartErase service composer — enhance (高清) tool', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetModules()
    runUploadMock.mockReset()
    runProcessAndPollMock.mockReset()
    runMediaKitUploadMock.mockReset()
    runMediaKitProcessAndPollMock.mockReset()
    transferUrlToHistoryBucketMock.mockReset()
    sendSpy.mockClear()
    poolTokenForTest.value = 'sk-shadow'
    wan3KeyForTest.value = ''

    runMediaKitUploadMock.mockResolvedValue({ sourceUrl: 'https://relay.cos/v.mp4' })
    runMediaKitProcessAndPollMock.mockResolvedValue({ videoUrl: 'https://volc.tmp/out.mp4', taskId: 'task_abc' })
    transferUrlToHistoryBucketMock.mockResolvedValue('https://history.cos/image-history/video-enhance/x.mp4')
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
    poolTokenForTest.value = null
    wan3KeyForTest.value = ''
  })

  it('不带 tool 时默认走高清 —— 页面默认就是它', async () => {
    const svc = await import('../index')
    svc.setMainWindow(mockWin as any)
    const ret = await svc.submitErase({ filePath: '/tmp/a.mp4', filename: 'a.mp4', fileSize: 10, durationSeconds: 5 })
    expect(ret.success).toBe(true)
    expect(ret.taskId).toMatch(/^enhance-/)
    await flush(); await flush(); await flush(); await flush()
    expect(runMediaKitUploadMock).toHaveBeenCalledTimes(1)
    expect(runUploadMock).not.toHaveBeenCalled()
    expect(runProcessAndPollMock).not.toHaveBeenCalled()
  })

  it('上传走公共中转拿 URL,处理阶段把这个 URL 交给网关 —— 从不经手 base64', async () => {
    const svc = await import('../index')
    svc.setMainWindow(mockWin as any)
    await svc.submitErase({ filePath: '/tmp/a.mp4', filename: 'a.mp4', fileSize: 10, durationSeconds: 5, tool: 'enhance' })
    await flush(); await flush(); await flush(); await flush()

    const [uploadJob] = runMediaKitUploadMock.mock.calls[0]
    expect(uploadJob).toMatchObject({ filePath: '/tmp/a.mp4', filename: 'a.mp4', fileSize: 10 })

    expect(runMediaKitProcessAndPollMock).toHaveBeenCalledTimes(1)
    const [, , job] = runMediaKitProcessAndPollMock.mock.calls[0]
    expect(job).toMatchObject({ model: 'volc-enhance-video', sourceUrl: 'https://relay.cos/v.mp4' })
    // 传下去的是 https URL,不是 data:
    expect(String(job.sourceUrl).startsWith('https://')).toBe(true)
  })

  it('平台已登录:鉴权头是整份平台头(含归属),不是裸 Authorization', async () => {
    const svc = await import('../index')
    svc.setMainWindow(mockWin as any)
    await svc.submitErase({ filePath: '/tmp/a.mp4', filename: 'a.mp4', fileSize: 10, durationSeconds: 5, tool: 'enhance', billing: 'platform' })
    await flush(); await flush(); await flush(); await flush()
    const [, resolveAuth] = runMediaKitProcessAndPollMock.mock.calls[0]
    const headers = resolveAuth()
    expect(headers.Authorization).toBe('Bearer sk-shadow')
    expect(headers).toHaveProperty('X-Platform-User-Id')
  })

  it('自填 Miau Key(未登录):裸 Authorization,不带归属头', async () => {
    poolTokenForTest.value = null
    wan3KeyForTest.value = 'miau-own'
    const svc = await import('../index')
    svc.setMainWindow(mockWin as any)
    await svc.submitErase({ filePath: '/tmp/a.mp4', filename: 'a.mp4', fileSize: 10, durationSeconds: 5, tool: 'enhance' })
    await flush(); await flush(); await flush(); await flush()
    const [, resolveAuth] = runMediaKitProcessAndPollMock.mock.calls[0]
    const headers = resolveAuth()
    expect(headers).toEqual({ Authorization: 'Bearer miau-own' })
  })

  it('既没登录也没 Miau Key:入队前就拒,不先传几百 MB 再报', async () => {
    poolTokenForTest.value = null
    const svc = await import('../index')
    svc.setMainWindow(mockWin as any)
    const ret = await svc.submitErase({ filePath: '/tmp/a.mp4', filename: 'a.mp4', fileSize: 10, durationSeconds: 5, tool: 'enhance' })
    expect(ret.success).toBe(false)
    expect(ret.error).toContain('Miau')
    expect(runMediaKitUploadMock).not.toHaveBeenCalled()
  })

  it('DAMO 规格翻成对应 SKU 模型名;不带规格默认火山', async () => {
    const svc = await import('../index')
    svc.setMainWindow(mockWin as any)
    await svc.submitErase({
      filePath: '/tmp/a.mp4', filename: 'a.mp4', fileSize: 10, durationSeconds: 5, tool: 'enhance',
      enhance: { provider: 'damo', algo: 'pro', resolution: '4k', fps: 60 },
    })
    await flush(); await flush(); await flush(); await flush()
    expect(runMediaKitProcessAndPollMock.mock.calls[0][2].model).toBe('damo-aisr-pro-4k-60fps')

    runMediaKitProcessAndPollMock.mockClear()
    await svc.submitErase({ filePath: '/tmp/b.mp4', filename: 'b.mp4', fileSize: 10, durationSeconds: 5, tool: 'enhance' })
    await flush(); await flush(); await flush(); await flush()
    expect(runMediaKitProcessAndPollMock.mock.calls[0][2].model).toBe('volc-enhance-video')
  })

  it('非法的 DAMO 规格回落火山,不会误提交一个贵档', async () => {
    const svc = await import('../index')
    svc.setMainWindow(mockWin as any)
    await svc.submitErase({
      filePath: '/tmp/a.mp4', filename: 'a.mp4', fileSize: 10, durationSeconds: 5, tool: 'enhance',
      enhance: { provider: 'damo', algo: 'pro', resolution: '16k', fps: 30 } as any,
    })
    await flush(); await flush(); await flush(); await flush()
    expect(runMediaKitProcessAndPollMock.mock.calls[0][2].model).toBe('volc-enhance-video')
  })

  it('完成后转存历史桶(video-enhance 子目录),erase:finished 带永久 URL', async () => {
    const svc = await import('../index')
    svc.setMainWindow(mockWin as any)
    await svc.submitErase({ filePath: '/tmp/a.mp4', filename: 'a.mp4', fileSize: 10, durationSeconds: 5, tool: 'enhance' })
    await flush(); await flush(); await flush(); await flush()
    expect(transferUrlToHistoryBucketMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceUrl: 'https://volc.tmp/out.mp4', key: expect.stringMatching(/^image-history\/video-enhance\//) }),
    )
    const finished = sendSpy.mock.calls.find((c) => c[0] === 'erase:finished')
    expect(finished![1]).toMatchObject({ videoUrl: 'https://history.cos/image-history/video-enhance/x.mp4', videoExpiresAt: 0 })
  })
})

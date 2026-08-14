// 万相任务查询响应 → 我们内部的 SeedanceQueryResult。
//
// 为什么要两种取值路径都认:我们打的是 Miau 网关而不是 DashScope 直连。指南写的
// 网关回形是 `output.video_url`;而 DashScope 官方 Python SDK 读的是
// `output.results[0].url`(context7 查证)。网关有没有把这一层抹平,我们无法本地
// 实测 —— 少认一种的代价是「任务明明成功了却报 succeeded 但缺少 video_url」,
// 而多认一种没有任何代价。

import { describe, expect, it } from 'vitest'
import { parseWan3TaskResult } from '../response'

describe('parseWan3TaskResult · 状态映射', () => {
  it('DashScope 的大写状态映射到内部小写状态', () => {
    expect(parseWan3TaskResult({ output: { task_status: 'PENDING' } }).status).toBe('queued')
    expect(parseWan3TaskResult({ output: { task_status: 'RUNNING' } }).status).toBe('running')
    expect(parseWan3TaskResult({ output: { task_status: 'FAILED' } }).status).toBe('failed')
    expect(parseWan3TaskResult({ output: { task_status: 'CANCELED' } }).status).toBe('cancelled')
  })

  it('网关也可能直接回小写(它对 Seedance 就是这么回的)', () => {
    expect(parseWan3TaskResult({ status: 'running' }).status).toBe('running')
  })

  it('认不出的状态当 running —— 不能把一个还在跑的任务判成失败', () => {
    // 判成 failed 会让 pollLoop 停下并落一张失败卡片,而任务还在上游烧钱跑着。
    expect(parseWan3TaskResult({ output: { task_status: 'WHATEVER' } }).status).toBe('running')
    expect(parseWan3TaskResult({}).status).toBe('running')
  })
})

describe('parseWan3TaskResult · 视频地址', () => {
  it('认网关形状 output.video_url', () => {
    const r = parseWan3TaskResult({
      output: { task_status: 'SUCCEEDED', video_url: 'https://x/v.mp4' },
    })
    expect(r.status).toBe('succeeded')
    expect(r.content?.video_url).toBe('https://x/v.mp4')
  })

  it('认 DashScope SDK 形状 output.results[0].url', () => {
    const r = parseWan3TaskResult({
      output: { task_status: 'SUCCEEDED', results: [{ url: 'https://x/v.mp4' }] },
    })
    expect(r.content?.video_url).toBe('https://x/v.mp4')
  })

  it('两者都在时以 video_url 为准(网关是我们的直接对端)', () => {
    const r = parseWan3TaskResult({
      output: {
        task_status: 'SUCCEEDED',
        video_url: 'https://gateway/v.mp4',
        results: [{ url: 'https://dashscope/v.mp4' }],
      },
    })
    expect(r.content?.video_url).toBe('https://gateway/v.mp4')
  })

  it('成功但没有地址时不编造 content', () => {
    const r = parseWan3TaskResult({ output: { task_status: 'SUCCEEDED' } })
    expect(r.status).toBe('succeeded')
    expect(r.content?.video_url).toBeUndefined()
  })
})

describe('parseWan3TaskResult · 任务号与错误', () => {
  it('任务号认 output.task_id / task_id / id', () => {
    expect(parseWan3TaskResult({ output: { task_id: 'a' } }).id).toBe('a')
    expect(parseWan3TaskResult({ task_id: 'b' }).id).toBe('b')
    expect(parseWan3TaskResult({ id: 'c' }).id).toBe('c')
  })

  it('失败时带出上游的 code 与 message', () => {
    const r = parseWan3TaskResult({
      output: { task_status: 'FAILED', code: 'InvalidParameter', message: '时长超限' },
    })
    expect(r.status).toBe('failed')
    expect(r.error).toEqual({ code: 'InvalidParameter', message: '时长超限' })
  })

  it('错误字段也可能在顶层', () => {
    const r = parseWan3TaskResult({ status: 'failed', code: 'Throttling', message: '限流' })
    expect(r.error).toEqual({ code: 'Throttling', message: '限流' })
  })

  it('没有错误信息时不塞一个空对象', () => {
    expect(parseWan3TaskResult({ output: { task_status: 'FAILED' } }).error).toBeUndefined()
  })
})

describe('parseWan3TaskResult · Miau 查询信封（2026-08-14 真网关钉死）', () => {
  // GET /video/generations/{id} 的真实回形。组包指南写的是顶层 output.video_url,
  // 那是直连 DashScope / 另一套 BFF 的形状。我们打的 Miau 把任务记录包在 data 里,
  // DashScope 原文再套一层 data.data.output。按指南解析会把已完成的任务当成还在
  // 跑 —— pollLoop 空转到 30 分钟超时,而成片已经躺在 OSS 上没人认领。

  const queued = {
    code: 'success',
    data: {
      task_id: 'task_gw',
      status: 'QUEUED',
      progress: '20%',
      data: { output: { task_id: 'uuid-dashscope', task_status: 'PENDING' } },
    },
  }

  const running = {
    code: 'success',
    data: {
      task_id: 'task_gw',
      status: 'IN_PROGRESS',
      progress: '30%',
      data: {
        output: {
          task_id: 'uuid-dashscope',
          task_status: 'RUNNING',
          scheduled_time: '2026-08-14 14:20:23.043',
        },
      },
    },
  }

  const succeeded = {
    code: 'success',
    data: {
      task_id: 'task_gw',
      status: 'SUCCESS',
      result_url: 'https://oss.example/v.mp4',
      progress: '100%',
      fail_reason: '',
      data: {
        output: {
          task_id: 'uuid-dashscope',
          task_status: 'SUCCEEDED',
          video_url: 'https://oss.example/v.mp4',
        },
        usage: { duration: 5, output_video_duration: 5, SR: 720 },
      },
    },
  }

  it('排队 / 运行认网关 status 与内层 task_status', () => {
    expect(parseWan3TaskResult(queued).status).toBe('queued')
    expect(parseWan3TaskResult(running).status).toBe('running')
  })

  it('成功时取出 video_url,状态为 succeeded', () => {
    const r = parseWan3TaskResult(succeeded)
    expect(r.status).toBe('succeeded')
    expect(r.content?.video_url).toBe('https://oss.example/v.mp4')
    // 信封自己的 code:"success" 不是错误码,不能当成失败原因带出去。
    expect(r.error).toBeUndefined()
  })

  it('任务号用网关的 task_id,不用内层 DashScope uuid', () => {
    // 内层 uuid 拿去再查 GET /video/generations/{uuid} 会 400 task_not_exist。
    expect(parseWan3TaskResult(succeeded).id).toBe('task_gw')
    expect(parseWan3TaskResult(queued).id).toBe('task_gw')
  })

  it('网关 numeric id 不是任务号', () => {
    expect(
      parseWan3TaskResult({
        code: 'success',
        data: { id: 98866, task_id: 'task_gw', status: 'QUEUED' },
      }).id,
    ).toBe('task_gw')
  })

  it('result_url 作为 video_url 的兜底 —— 内层偶发缺字段时网关层仍有地址', () => {
    const r = parseWan3TaskResult({
      code: 'success',
      data: {
        task_id: 'task_gw',
        status: 'SUCCESS',
        result_url: 'https://gateway/v.mp4',
        data: { output: { task_status: 'SUCCEEDED' } },
      },
    })
    expect(r.content?.video_url).toBe('https://gateway/v.mp4')
  })

  it('失败时把 fail_reason 带出来', () => {
    const r = parseWan3TaskResult({
      code: 'success',
      data: {
        task_id: 'task_gw',
        status: 'FAILURE',
        fail_reason: 'InvalidParameter: duration',
        data: { output: { task_status: 'FAILED' } },
      },
    })
    expect(r.status).toBe('failed')
    expect(r.error?.message).toBe('InvalidParameter: duration')
  })
})

describe('parseWan3TaskResult · 健壮性', () => {
  it('null / 非对象不抛错', () => {
    expect(parseWan3TaskResult(null).status).toBe('running')
    expect(parseWan3TaskResult('nonsense').status).toBe('running')
  })

  it('不透传 completion_tokens —— 万相按秒计费,没有这个口径', () => {
    // 传了会让 pricing 以为能按 token 估价,算出一个凭空的数字。
    const r = parseWan3TaskResult({
      output: { task_status: 'SUCCEEDED', video_url: 'https://x/v.mp4' },
      usage: { completion_tokens: 12345 },
    }) as { completionTokens?: number }
    expect(r.completionTokens).toBeUndefined()
  })
})

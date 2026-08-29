// 网关任务查询响应的解析。这一组最重要的一句话:**完成判据是「URL 存在」,
// 不是 status 字符串** —— 与 vvdance 那条(`succeeded` 且有 URL,缺 URL 算失败)
// 方向相反。

import { describe, expect, it } from 'vitest'
import { parseSeedanceGatewayTaskResult } from '../response'

const URL_A = 'https://cdn.example.com/out/a.mp4'

/**
 * **真机抓到的响应**（2026-08-29，测试网关 `43.161.233.87:3000`，
 * `doubao-seedance-2-0-260128`，带一条平台人像库的 `asset://` 参考图）。
 *
 * 这一组是这个文件里唯一不是我编出来的载荷。它揪出的 bug：URL 落在 **`metadata.url`**，
 * 而兜底容器列表里没有 `metadata` —— 顶层没有任何 `url` 键，于是解析器一次都找不到。
 * 后果不是报错，是这条任务**永远拿不到成片**：完成判据就是「URL 存在」，
 * 于是卡片一路 running 到 30 分钟超时，而片子其实早就出好了、钱也早就扣了。
 *
 * 光看 status 是发现不了的 —— 它老老实实写着 `completed`。
 */
const REAL_COMPLETED = {
  id: 'task_Ppjzz9F8tsqkyqpJTKlXRTWIo7Vea1be',
  task_id: 'task_Ppjzz9F8tsqkyqpJTKlXRTWIo7Vea1be',
  object: 'video',
  model: 'doubao-seedance-2-0-260128',
  status: 'completed',
  progress: 100,
  created_at: 1787951646,
  completed_at: 1787951721,
  metadata: {
    upstream_task_id: 'cgt-20260829051406-bdkrp',
    url: 'https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/doubao-seedance-2-0/0217879516469440000.mp4',
  },
} as const

const REAL_RUNNING = {
  id: 'task_Ppjzz9F8tsqkyqpJTKlXRTWIo7Vea1be',
  task_id: 'task_Ppjzz9F8tsqkyqpJTKlXRTWIo7Vea1be',
  object: 'video',
  model: 'doubao-seedance-2-0-260128',
  status: 'in_progress',
  progress: 50,
  created_at: 1787951646,
  completed_at: 1787951650,
  metadata: { upstream_task_id: 'cgt-20260829051406-bdkrp', url: '' },
} as const

describe('真机响应（2026-08-29 实测）', () => {
  it('URL 在 metadata.url 里也要找得到', () => {
    const r = parseSeedanceGatewayTaskResult(REAL_COMPLETED)
    expect(r.content?.video_url).toBe(REAL_COMPLETED.metadata.url)
    expect(r.status).toBe('succeeded')
    expect(r.id).toBe(REAL_COMPLETED.task_id)
  })

  it('进行中那一版 metadata.url 是空串,不能被当成拿到了地址', () => {
    const r = parseSeedanceGatewayTaskResult(REAL_RUNNING)
    expect(r.content?.video_url).toBeUndefined()
    expect(r.status).not.toBe('succeeded')
  })
})

describe('完成判据 = URL 存在', () => {
  it('认不出的终态词也算成功 —— 网关中转多个上游,succeeded/completed/done 不统一', () => {
    for (const status of ['succeeded', 'completed', 'complete', 'done', 'finished', 'FINISH', '收工了']) {
      const r = parseSeedanceGatewayTaskResult({ id: 't', status, video_url: URL_A })
      expect(r.status, `status=${status}`).toBe('succeeded')
      expect(r.content?.video_url).toBe(URL_A)
    }
  })

  it('status 还写着 running,但 URL 已经在了 —— 照样收工', () => {
    const r = parseSeedanceGatewayTaskResult({ id: 't', status: 'running', video_url: URL_A })
    expect(r.status).toBe('succeeded')
  })

  it('完全没有 status 字段,只有 URL —— 照样收工', () => {
    const r = parseSeedanceGatewayTaskResult({ id: 't', video_url: URL_A })
    expect(r.status).toBe('succeeded')
  })

  it('URL 不是 http(s) 的不算数（避免把状态词、占位串当成地址）', () => {
    const r = parseSeedanceGatewayTaskResult({ id: 't', status: 'running', video_url: 'pending' })
    expect(r.status).toBe('running')
    expect(r.content).toBeUndefined()
  })
})

describe('多位置兜底找 URL', () => {
  const shapes: Array<[string, unknown]> = [
    ['顶层 video_url', { id: 't', video_url: URL_A }],
    ['content.video_url（Ark 同形）', { id: 't', content: { video_url: URL_A } }],
    ['output.video_url（DashScope 同形）', { id: 't', output: { video_url: URL_A } }],
    ['data.video_url（网关信封）', { id: 't', data: { task_id: 't', video_url: URL_A } }],
    ['data.content.video_url', { id: 't', data: { task_id: 't', content: { video_url: URL_A } } }],
    ['data.output.video_url', { id: 't', data: { task_id: 't', output: { video_url: URL_A } } }],
    ['result_url', { id: 't', result_url: URL_A }],
    ['output.results[].url', { id: 't', output: { results: [{ url: URL_A }] } }],
    ['data[].url（OpenAI 兼容层同形）', { id: 't', data: [{ url: URL_A }] }],
    ['videos[].url', { id: 't', videos: [{ url: URL_A }] }],
  ]

  for (const [name, body] of shapes) {
    it(`认得 ${name}`, () => {
      const r = parseSeedanceGatewayTaskResult(body)
      expect(r.content?.video_url).toBe(URL_A)
      expect(r.status).toBe('succeeded')
    })
  }

  it('results 里第一条没有 url 时接着往后找', () => {
    const r = parseSeedanceGatewayTaskResult({
      id: 't',
      output: { results: [{ cover: 'https://x/c.jpg' }, { url: URL_A }] },
    })
    expect(r.content?.video_url).toBe(URL_A)
  })
})

describe('taskId', () => {
  it('取 task_id,其次 id', () => {
    expect(parseSeedanceGatewayTaskResult({ task_id: 'a', id: 'b' }).id).toBe('a')
    expect(parseSeedanceGatewayTaskResult({ id: 'b' }).id).toBe('b')
  })

  it('网关信封里的 data.task_id 压过内层 output.task_id', () => {
    // 内层往往是上游自己的 uuid,拿去再查本网关会 task_not_exist。
    const r = parseSeedanceGatewayTaskResult({
      data: { task_id: 'gw-1', status: 'running', output: { task_id: 'upstream-uuid' } },
    })
    expect(r.id).toBe('gw-1')
  })

  it('一个都找不到时给空串（而不是 undefined,调用方按空串判）', () => {
    expect(parseSeedanceGatewayTaskResult({ status: 'running' }).id).toBe('')
  })
})

describe('状态归一', () => {
  it('排队词', () => {
    for (const s of ['queued', 'QUEUED', 'pending', 'PENDING', 'waiting', 'in_queue']) {
      expect(parseSeedanceGatewayTaskResult({ id: 't', status: s }).status, s).toBe('queued')
    }
  })

  it('运行词', () => {
    for (const s of ['running', 'RUNNING', 'in_progress', 'IN_PROGRESS', 'processing', 'generating']) {
      expect(parseSeedanceGatewayTaskResult({ id: 't', status: s }).status, s).toBe('running')
    }
  })

  it('失败词', () => {
    for (const s of ['failed', 'FAILED', 'failure', 'FAILURE', 'error']) {
      expect(parseSeedanceGatewayTaskResult({ id: 't', status: s }).status, s).toBe('failed')
    }
  })

  it('取消词', () => {
    for (const s of ['cancelled', 'canceled', 'CANCELLED']) {
      expect(parseSeedanceGatewayTaskResult({ id: 't', status: s }).status, s).toBe('cancelled')
    }
  })

  it('认不出且没有 URL 的一律当 running —— 判 failed 会杀掉一条还在烧钱的任务', () => {
    for (const s of ['weird', '', 'unknown', 'UNKNOWN']) {
      expect(parseSeedanceGatewayTaskResult({ id: 't', status: s }).status, s).toBe('running')
    }
    expect(parseSeedanceGatewayTaskResult({ id: 't' }).status).toBe('running')
  })

  it('终态失败词压过「找不到 URL 就当 running」', () => {
    expect(parseSeedanceGatewayTaskResult({ id: 't', status: 'failed' }).status).toBe('failed')
  })

  it('说成功却没有 URL —— 保留 succeeded,交给 taskManager 那句「缺少 video_url」大声报错', () => {
    // 改判 running 的话 pollLoop 会空转到 30 分钟超时,用户什么也看不到。
    const r = parseSeedanceGatewayTaskResult({ id: 't', status: 'succeeded' })
    expect(r.status).toBe('succeeded')
    expect(r.content).toBeUndefined()
  })
})

describe('错误信息', () => {
  it('认网关自身信封 error.code / error.message', () => {
    const r = parseSeedanceGatewayTaskResult({
      id: 't',
      status: 'failed',
      error: { code: 'content_policy', message: '提示词不合规' },
    })
    expect(r.error).toEqual({ code: 'content_policy', message: '提示词不合规' })
  })

  it('认上游透传的 fail_reason', () => {
    const r = parseSeedanceGatewayTaskResult({
      data: { task_id: 't', status: 'FAILURE', fail_reason: '上游超时' },
    })
    expect(r.error?.message).toBe('上游超时')
  })

  it('信封自己的 code: "success" 不是错误码', () => {
    const r = parseSeedanceGatewayTaskResult({ code: 'success', data: { task_id: 't', status: 'QUEUED' } })
    expect(r.error).toBeUndefined()
  })

  it('成功时不带 error 字段', () => {
    const r = parseSeedanceGatewayTaskResult({ id: 't', status: 'succeeded', video_url: URL_A })
    expect(r.error).toBeUndefined()
  })
})

describe('畸形输入不炸', () => {
  it('null / 字符串 / 数组都退化成一个 running 的空结果', () => {
    for (const raw of [null, undefined, 'oops', 42, []]) {
      const r = parseSeedanceGatewayTaskResult(raw)
      expect(r.status).toBe('running')
      expect(r.id).toBe('')
    }
  })
})

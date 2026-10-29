// 「效果问题反馈」网关客户端。fetch 与鉴权头都是注入的:请求塑形(URL / 头 / 体)、
// 两层回包解析(`{accepted, rejected}` 与状态码)、各类失败的归类,都能在没有 Electron、
// 不打网络的情况下断言。契约出处:new-api #188 / #189。

import { describe, expect, it, vi } from 'vitest'
import { MIAU_BASE_URL } from '../../../../shared/miau'
import {
  VIDEO_BADCASE_QUERY_PATH,
  VIDEO_BADCASE_REPORT_PATH,
  createVideoBadcaseClient,
} from '../client'

const AUTH = { Authorization: 'Bearer sk-test', 'X-Platform-User-Id': 'u1' }

function res(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function clientWith(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, over: { auth?: boolean } = {}) {
  return createVideoBadcaseClient({
    fetchImpl,
    authHeaders: () => (over.auth === false ? null : AUTH),
  })
}

const OK_REPORT = {
  total: 1,
  accepted: [{ task_id: 'task_1', case_id: 'case-9', submission_id: 's1', code: 0, message: 'ok' }],
  rejected: [],
}

const OK_QUERY = {
  total: 1,
  accepted: [
    {
      task_id: 'task_1',
      badcase_type: ['style_drift', 'other'],
      feedback: '风格飘了',
      problem_label: '风格',
      status: 'done',
      submit_time: '2026-10-29T08:00:00Z',
      solution_note: {
        text: '已修复',
        attachments: [
          { type: 'video', url: 'https://cos.example/a.mp4', mime_type: 'video/mp4', name: 'a.mp4' },
          { type: 'link', url: 'http://insecure.example/x', mime_type: '', name: 'x' },
          { type: 'link', url: 'javascript:alert(1)', mime_type: '', name: 'evil' },
        ],
      },
    },
  ],
  rejected: [],
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0][1] as RequestInit
  return JSON.parse(init.body as string) as Record<string, unknown>
}

describe('report · 请求塑形', () => {
  it('POST 到 {base}/video/badcase/report,带整份鉴权头,不带 model', async () => {
    const f = vi.fn(async () => res(OK_REPORT))
    await clientWith(f).report({ taskId: 'task_1', feedback: '角色变脸', badcaseTypes: ['character_id_drift'] })

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${MIAU_BASE_URL.replace(/\/+$/, '')}${VIDEO_BADCASE_REPORT_PATH}`)
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', ...AUTH })
    expect(bodyOf(f)).toEqual({ task_id: 'task_1', feedback: '角色变脸', badcase_type: ['character_id_drift'] })
    expect(bodyOf(f)).not.toHaveProperty('model')
  })

  it('没选类型 / 没填联系方式:对应字段整个不出现(不发空数组、空串)', async () => {
    const f = vi.fn(async () => res(OK_REPORT))
    await clientWith(f).report({ taskId: 'task_1', feedback: ' 水印 ', badcaseTypes: [], contactInfo: '   ' })
    expect(bodyOf(f)).toEqual({ task_id: 'task_1', feedback: '水印' })
  })

  it('联系方式 / 类型去重后原样带上', async () => {
    const f = vi.fn(async () => res(OK_REPORT))
    await clientWith(f).report({
      taskId: ' task_1 ',
      feedback: 'x',
      badcaseTypes: ['other', 'other', 'style_drift'],
      contactInfo: ' a@b.c ',
    })
    expect(bodyOf(f)).toEqual({
      task_id: 'task_1',
      feedback: 'x',
      badcase_type: ['other', 'style_drift'],
      contact_info: 'a@b.c',
    })
  })
})

describe('report · 入参校验(不该发出请求的就不发)', () => {
  const cases: Array<[string, Parameters<ReturnType<typeof clientWith>['report']>[0] | unknown]> = [
    ['缺任务号', { taskId: '', feedback: 'x', badcaseTypes: [] }],
    ['任务号带逗号(会被网关当批量)', { taskId: 'task_1,task_2', feedback: 'x', badcaseTypes: [] }],
    ['任务号带空白', { taskId: 'task_1 task_2', feedback: 'x', badcaseTypes: [] }],
    ['描述为空', { taskId: 'task_1', feedback: '   ', badcaseTypes: [] }],
    ['描述超 5000 字', { taskId: 'task_1', feedback: 'a'.repeat(5001), badcaseTypes: [] }],
    ['联系方式超 255 字', { taskId: 'task_1', feedback: 'x', badcaseTypes: [], contactInfo: 'a'.repeat(256) }],
    ['类型不在枚举里', { taskId: 'task_1', feedback: 'x', badcaseTypes: ['bogus'] }],
    ['类型不是数组', { taskId: 'task_1', feedback: 'x', badcaseTypes: 'other' }],
    ['整个入参不是对象', null],
  ]
  for (const [name, input] of cases) {
    it(name, async () => {
      const f = vi.fn(async () => res(OK_REPORT))
      const r = await clientWith(f).report(input as never)
      expect(r).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
      expect(f).not.toHaveBeenCalled()
    })
  }

  it('字数按字符(rune)算:5000 个 emoji 过,5001 个不过', async () => {
    const f = vi.fn(async () => res(OK_REPORT))
    const ok = await clientWith(f).report({ taskId: 'task_1', feedback: '😀'.repeat(5000), badcaseTypes: [] })
    expect(ok).toMatchObject({ ok: true, outcome: 'accepted' })
    const bad = await clientWith(f).report({ taskId: 'task_1', feedback: '😀'.repeat(5001), badcaseTypes: [] })
    expect(bad).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
  })
})

describe('report · 回包', () => {
  it('受理:带回 case_id', async () => {
    const r = await clientWith(async () => res(OK_REPORT)).report({ taskId: 'task_1', feedback: 'x', badcaseTypes: [] })
    expect(r).toEqual({ ok: true, outcome: 'accepted', caseId: 'case-9' })
  })

  it('受理但 case_id 为空:caseId = null', async () => {
    const body = { total: 1, accepted: [{ task_id: 'task_1', case_id: '' }], rejected: [] }
    const r = await clientWith(async () => res(body)).report({ taskId: 'task_1', feedback: 'x', badcaseTypes: [] })
    expect(r).toEqual({ ok: true, outcome: 'accepted', caseId: null })
  })

  it('被拒:原样交出 rejection(面板据此再查一次),不当失败', async () => {
    const body = { total: 1, accepted: [], rejected: [{ task_id: 'task_1', code: 40010, message: 'already submitted' }] }
    const r = await clientWith(async () => res(body)).report({ taskId: 'task_1', feedback: 'x', badcaseTypes: [] })
    expect(r).toEqual({ ok: true, outcome: 'rejected', rejection: { code: 40010, message: 'already submitted' } })
  })

  it('40002 只按 code 翻成「切换计费池」的中文,不看上游文案', async () => {
    const body = { total: 1, accepted: [], rejected: [{ task_id: 'task_1', code: 40002, message: 'whatever the upstream says' }] }
    const r = await clientWith(async () => res(body)).report({ taskId: 'task_1', feedback: 'x', badcaseTypes: [] })
    expect(r).toMatchObject({ ok: true, outcome: 'rejected', rejection: { code: 40002 } })
    if (r.ok && r.outcome === 'rejected') {
      expect(r.rejection.message).toMatch(/计费池/)
      expect(r.rejection.message).not.toMatch(/upstream/)
    }
  })

  it('502 + body 仍是 {accepted:[], rejected:[50200]}:是「上游不可用」,不是被拒', async () => {
    const body = { total: 1, accepted: [], rejected: [{ task_id: 'task_1', code: 50200, message: 'upstream down' }] }
    const r = await clientWith(async () => res(body, 502)).report({ taskId: 'task_1', feedback: 'x', badcaseTypes: [] })
    expect(r).toMatchObject({ ok: false, code: 'UPSTREAM_ERROR' })
  })

  it('既没受理也没拒绝:不能当成功', async () => {
    const r = await clientWith(async () => res({ total: 0, accepted: [], rejected: [] })).report({
      taskId: 'task_1',
      feedback: 'x',
      badcaseTypes: [],
    })
    expect(r).toMatchObject({ ok: false, code: 'BAD_RESPONSE' })
  })
})

describe('query', () => {
  it('POST 到 {base}/video/badcase/query,只带 task_id', async () => {
    const f = vi.fn(async () => res(OK_QUERY))
    await clientWith(f).query('task_1')
    const [url] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${MIAU_BASE_URL.replace(/\/+$/, '')}${VIDEO_BADCASE_QUERY_PATH}`)
    expect(bodyOf(f)).toEqual({ task_id: 'task_1' })
  })

  it('解析记录;附件只留 https', async () => {
    const r = await clientWith(async () => res(OK_QUERY)).query('task_1')
    expect(r).toEqual({
      ok: true,
      rejection: null,
      record: {
        badcaseTypes: ['style_drift', 'other'],
        feedback: '风格飘了',
        problemLabel: '风格',
        status: 'done',
        submitTime: '2026-10-29T08:00:00Z',
        solution: {
          text: '已修复',
          attachments: [{ type: 'video', url: 'https://cos.example/a.mp4', mimeType: 'video/mp4', name: 'a.mp4' }],
        },
      },
    })
  })

  it('没有 solution_note:solution = null', async () => {
    const body = { total: 1, accepted: [{ task_id: 'task_1', badcase_type: [], feedback: 'x', status: 'processing' }], rejected: [] }
    const r = await clientWith(async () => res(body)).query('task_1')
    expect(r).toMatchObject({ ok: true, record: { status: 'processing', solution: null, badcaseTypes: [] } })
  })

  it('没记录:record = null,并带上拒绝原因', async () => {
    const body = { total: 1, accepted: [], rejected: [{ task_id: 'task_1', code: 40404, message: 'no case' }] }
    const r = await clientWith(async () => res(body)).query('task_1')
    expect(r).toEqual({ ok: true, record: null, rejection: { code: 40404, message: 'no case' } })
  })

  it('任务不存在(40002):record = null + 中文提示', async () => {
    const body = { total: 1, accepted: [], rejected: [{ task_id: 'task_1', code: 40002, message: 'x' }] }
    const r = await clientWith(async () => res(body)).query('task_1')
    expect(r).toMatchObject({ ok: true, record: null, rejection: { code: 40002 } })
  })

  it('50200:必须是失败而不是「没记录」,否则面板会让人对着可能已提交的任务再交一次', async () => {
    const body = { total: 1, accepted: [], rejected: [{ task_id: 'task_1', code: 50200, message: 'down' }] }
    const r = await clientWith(async () => res(body, 502)).query('task_1')
    expect(r).toMatchObject({ ok: false, code: 'UPSTREAM_ERROR' })
  })

  it('任务号带分隔符:不发请求', async () => {
    const f = vi.fn(async () => res(OK_QUERY))
    expect(await clientWith(f).query('a,b')).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(await clientWith(f).query('')).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(f).not.toHaveBeenCalled()
  })
})

describe('失败归类(回包不是 {accepted, rejected} 时按状态码说人话)', () => {
  const envelope = (message: string, type = 'new_api_error', code = '') => ({ error: { message, type, ...(code ? { code } : {}) } })
  const run = (status: number, body: unknown) => clientWith(async () => res(body, status)).query('task_1')

  it('没有平台凭据:请求都不发', async () => {
    const f = vi.fn(async () => res(OK_QUERY))
    const r = await clientWith(f, { auth: false }).query('task_1')
    expect(r).toMatchObject({ ok: false, code: 'PLATFORM_NOT_READY' })
    expect(f).not.toHaveBeenCalled()
  })

  it('401 → UNAUTHORIZED', async () => {
    expect(await run(401, envelope('invalid token'))).toMatchObject({ ok: false, code: 'UNAUTHORIZED' })
  })

  it('没有渠道(503 + no available channel / model_not_found 码)→ CHANNEL_UNAVAILABLE', async () => {
    expect(await run(503, envelope('no available channel for model seedance-badcase'))).toMatchObject({
      ok: false,
      code: 'CHANNEL_UNAVAILABLE',
    })
    expect(await run(400, envelope('x', 'new_api_error', 'model_not_found'))).toMatchObject({
      ok: false,
      code: 'CHANNEL_UNAVAILABLE',
    })
  })

  it('老网关没有这两个路由(404)/ 令牌白名单拦了(403)→ CHANNEL_UNAVAILABLE', async () => {
    expect(await run(404, '<html>not found</html>')).toMatchObject({ ok: false, code: 'CHANNEL_UNAVAILABLE' })
    expect(await run(403, envelope('forbidden'))).toMatchObject({ ok: false, code: 'CHANNEL_UNAVAILABLE' })
  })

  it('400 → INVALID_REQUEST;429 / 5xx → UPSTREAM_ERROR;其余 → BAD_RESPONSE', async () => {
    expect(await run(400, envelope('bad'))).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    expect(await run(429, envelope('slow down'))).toMatchObject({ ok: false, code: 'UPSTREAM_ERROR' })
    expect(await run(500, envelope('boom'))).toMatchObject({ ok: false, code: 'UPSTREAM_ERROR' })
    expect(await run(418, envelope('teapot'))).toMatchObject({ ok: false, code: 'BAD_RESPONSE' })
  })

  it('body 不是 JSON 也不抛', async () => {
    const f = async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })
    expect(await clientWith(f).query('task_1')).toMatchObject({ ok: false, code: 'UPSTREAM_ERROR' })
  })

  it('网络错误 → NETWORK,不把底层错误串露给用户', async () => {
    const f = async () => {
      throw new Error('getaddrinfo ENOTFOUND secret.internal.host')
    }
    const r = await clientWith(f).query('task_1')
    expect(r).toMatchObject({ ok: false, code: 'NETWORK' })
    if (!r.ok) expect(r.message).not.toMatch(/secret\.internal/)
  })

  it('超时 → NETWORK「请求超时」', async () => {
    const f = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const client = createVideoBadcaseClient({ fetchImpl: f, authHeaders: () => AUTH, timeoutMs: 20 })
    const r = await client.query('task_1')
    expect(r).toMatchObject({ ok: false, code: 'NETWORK' })
    if (!r.ok) expect(r.message).toMatch(/超时/)
  })

  it('每次调用现取鉴权头(用户中途切池,下一次就记到新池上)', async () => {
    let token = 'a'
    const f = vi.fn(async () => res(OK_QUERY))
    const client = createVideoBadcaseClient({ fetchImpl: f, authHeaders: () => ({ Authorization: `Bearer ${token}` }) })
    await client.query('task_1')
    token = 'b'
    await client.query('task_1')
    const sent = f.mock.calls.map((c) => ((c as unknown as [string, RequestInit])[1].headers as Record<string, string>).Authorization)
    expect(sent).toEqual(['Bearer a', 'Bearer b'])
  })

  it('不重试:一次失败就只发一次', async () => {
    const f = vi.fn(async () => res({ error: { message: 'boom' } }, 500))
    await clientWith(f).report({ taskId: 'task_1', feedback: 'x', badcaseTypes: [] })
    expect(f).toHaveBeenCalledTimes(1)
  })
})

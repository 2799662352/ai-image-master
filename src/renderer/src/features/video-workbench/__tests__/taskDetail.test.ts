// 「任务详情」面板的数据层:把一张卡上散落的标识 / 请求参数 / 结果 / 版本
// 收成一份给人看、也能整份复制的文档。核心是**上游任务号**那一行 —— 找供应商
// 对账要的就是它;其余是让排障不必再翻 IndexedDB。

import { describe, expect, it } from 'vitest'
import type { VideoWorkbenchCard, VideoWorkbenchVersion } from '../../../../../types/videoWorkbench'
import { buildCard } from '../cardSpec'
import { buildTaskDetail, type TaskDetail, type TaskDetailField } from '../taskDetail'

const UPSTREAM = 'cgt-20260903172200-5n7rt'
const T0 = Date.UTC(2026, 8, 3, 9, 22, 0) // 2026-09-03 09:22:00Z

function card(patch: Partial<VideoWorkbenchCard> = {}): VideoWorkbenchCard {
  return {
    ...buildCard({ prompt: '一只赛博猫在雨夜奔跑', model: '2.5', resolution: '480p', duration: 6 }, 3),
    id: 'card0000aa',
    ...patch,
  }
}

function field(detail: TaskDetail, key: string): TaskDetailField {
  for (const section of detail.sections) {
    const hit = section.fields.find((f) => f.key === key)
    if (hit) return hit
  }
  throw new Error(`field ${key} not found; have: ${detail.sections.flatMap((s) => s.fields.map((f) => f.key)).join(',')}`)
}

describe('标识区', () => {
  it('走网关的卡:任务 ID(网关)+ 上游任务 ID(火山 cgt-)都可复制,标出供应商', () => {
    const d = buildTaskDetail(
      card({ status: 'running', taskId: 'task_aSOAy1', upstreamTaskId: UPSTREAM, clientId: 'wb-abc', billing: 'platform' }),
      { index: 3, now: T0 },
    )
    expect(d.title).toBe('#04 · 任务详情')
    expect(field(d, 'taskId')).toMatchObject({ value: 'task_aSOAy1', copy: true })
    expect(field(d, 'taskId').label).toMatch(/网关/)
    expect(field(d, 'upstreamTaskId')).toMatchObject({ value: UPSTREAM, copy: true })
    expect(field(d, 'upstreamTaskId').hint).toMatch(/火山/)
    expect(field(d, 'clientId')).toMatchObject({ value: 'wb-abc', copy: true })
    expect(field(d, 'cardId').value).toBe('card0000aa')
    expect(field(d, 'billing').value).toMatch(/平台/)
  })

  it('万相卡的上游供应商标成阿里云百炼', () => {
    const d = buildTaskDetail(
      card({ model: 'wan3', status: 'running', taskId: 'task_w', upstreamTaskId: '316bb68d-414d', billing: 'platform' }),
      { index: 0 },
    )
    expect(field(d, 'upstreamTaskId').hint).toMatch(/阿里|百炼|DashScope/)
  })

  /**
   * Roneyun-cn 的上游任务号是那条渠道签的(如 `task_97eb…`),拿去火山对账对不上 —— 标成火山就是
   * 把用户指去找错的供应商。
   *
   * 🧬 变异点:去掉 `upstreamVendor` 里按渠道判的那一行,这条必红(会落回「火山引擎 · Ark」)。
   */
  it('Roneyun-cn 卡的上游供应商标成 Roneyun-cn,不是火山', () => {
    for (const model of ['cn-seedance-2.0', 'cn-seedance-2.0-fast', 'cn-seedance-2.0-mini', 'cn-seedance-2.5'] as const) {
      const d = buildTaskDetail(
        card({ model, status: 'running', taskId: 'task_cn', upstreamTaskId: 'task_97eb3ce2', billing: 'platform' }),
        { index: 0 },
      )
      const hint = field(d, 'upstreamTaskId').hint ?? ''
      expect(hint, model).toMatch(/Roneyun-cn/)
      expect(hint, model).not.toMatch(/火山/)
    }
  })

  it('直连(自填 Key)没有另一跳:上游任务 ID 行直接给任务 ID,并说明原因', () => {
    const d = buildTaskDetail(card({ status: 'succeeded', taskId: 'cgt-direct-1', billing: 'own-key' }), { index: 0 })
    expect(field(d, 'taskId').label).toMatch(/直连/)
    expect(field(d, 'upstreamTaskId')).toMatchObject({ value: 'cgt-direct-1', copy: true })
    expect(field(d, 'upstreamTaskId').hint).toMatch(/直连/)
  })

  it('网关还没回传上游号:该行标 missing,不给复制按钮', () => {
    const d = buildTaskDetail(card({ status: 'queued', taskId: 'task_x', billing: 'platform' }), { index: 0 })
    expect(field(d, 'upstreamTaskId')).toMatchObject({ missing: true })
    expect(field(d, 'upstreamTaskId').copy).toBeFalsy()
    expect(field(d, 'upstreamTaskId').value).toMatch(/尚未/)
  })

  it('从没提交到上游(准备阶段就失败):任务 ID 与上游任务 ID 都标 missing', () => {
    const d = buildTaskDetail(card({ status: 'failed', error: '素材上传失败' }), { index: 0 })
    expect(field(d, 'taskId')).toMatchObject({ missing: true })
    expect(field(d, 'upstreamTaskId')).toMatchObject({ missing: true })
  })
})

/**
 * Roneyun-cn 再往下一层的火山 `cgt-…` 号(网关 new-api #209,2026-11-18:`metadata.provider_task_id`)。
 * 「上游任务 ID」那一行在这条渠道上是 Roneyun 自己的 `task_…`,找火山对账要的是这一行。
 */
describe('火山任务 ID(providerTaskId)', () => {
  const CGT = 'cgt-20261118101131-i5x3m'
  const cn = (patch: Partial<VideoWorkbenchCard> = {}) =>
    card({ model: 'cn-seedance-2.5', status: 'running', taskId: 'task_cn', upstreamTaskId: 'task_eec4691', billing: 'platform', ...patch })
  const idKeys = (d: TaskDetail) => d.sections.find((s) => s.key === 'ids')!.fields.map((f) => f.key)

  /**
   * 🧬 变异点:去掉 `idFields` 里的 `...(provider ? [provider] : [])`,这条必红;
   * 把 providerField 里的 `copy: true` 去掉,这条也红。
   */
  it('Roneyun-cn 卡带了火山号:紧跟在「上游任务 ID」后面,可复制,提示指向火山', () => {
    const d = buildTaskDetail(cn({ providerTaskId: CGT }), { index: 0 })
    expect(field(d, 'providerTaskId')).toMatchObject({ value: CGT, copy: true })
    expect(field(d, 'providerTaskId').hint).toMatch(/火山/)
    expect(field(d, 'upstreamTaskId').value).toBe('task_eec4691') // 不被覆盖
    const keys = idKeys(d)
    expect(keys.indexOf('providerTaskId')).toBe(keys.indexOf('upstreamTaskId') + 1)
  })

  it('Roneyun-cn 卡已提交、火山号还没到:标 missing 说明缺在哪,不拿 task_ 冒充,不给复制', () => {
    const d = buildTaskDetail(cn(), { index: 0 })
    expect(field(d, 'providerTaskId')).toMatchObject({ missing: true })
    expect(field(d, 'providerTaskId').value).toMatch(/尚未/)
    expect(field(d, 'providerTaskId').copy).toBeFalsy()
    expect(field(d, 'providerTaskId').value).not.toContain('task_')
  })

  it('Roneyun-cn 卡还没提交到上游:不多出这一行', () => {
    const d = buildTaskDetail(cn({ status: 'failed', error: '素材上传失败', taskId: undefined, upstreamTaskId: undefined }), { index: 0 })
    expect(idKeys(d)).not.toContain('providerTaskId')
  })

  /**
   * 🧬 变异点:把 `hasProviderLayer` 改成恒真,火山 / 万相 / 可灵的卡就会凭空多一行「渠道尚未回传」。
   */
  it('没有火山那一层的渠道(火山直出 / 万相 / 可灵)不多这一行', () => {
    for (const model of ['2.5', '2.0', 'wan3', 'kling4'] as const) {
      const d = buildTaskDetail(card({ model, status: 'running', taskId: 'task_x', upstreamTaskId: 'up-1', billing: 'platform' }), { index: 0 })
      expect(idKeys(d), model).not.toContain('providerTaskId')
    }
  })

  it('「复制全部」的 JSON:有火山号才有 ids.providerTaskId;其它卡的 ids 与以前逐键相同', () => {
    const withIt = JSON.parse(buildTaskDetail(cn({ providerTaskId: CGT }), { index: 0 }).json) as { ids: Record<string, unknown> }
    expect(withIt.ids).toEqual({ taskId: 'task_cn', upstreamTaskId: 'task_eec4691', providerTaskId: CGT, clientId: null })
    const without = JSON.parse(buildTaskDetail(cn(), { index: 0 }).json) as { ids: Record<string, unknown> }
    expect(Object.keys(without.ids)).toEqual(['taskId', 'upstreamTaskId', 'clientId'])
  })

  describe('历史版本', () => {
    const cnSpec = { ...specOf(), model: 'cn-seedance-2.5' as const }
    const v1: VideoWorkbenchVersion = { id: 'v1', seq: 1, createdAt: T0, taskId: 't1', upstreamTaskId: 'task_a', providerTaskId: CGT, spec: cnSpec }
    const v2: VideoWorkbenchVersion = { id: 'v2', seq: 2, createdAt: T0 + 60_000, taskId: 't2', upstreamTaskId: 'task_b', spec: cnSpec }
    const two = (versions: VideoWorkbenchVersion[]) =>
      cn({ status: 'succeeded', taskId: 't2', upstreamTaskId: 'task_b', providerTaskId: 'cgt-latest', versions })

    it('指向更早的版本:取那一版存档里的火山号,不混卡片当前的', () => {
      const d = buildTaskDetail(two([v1, v2]), { index: 0, now: T0, versionIdx: 0 })
      expect(field(d, 'providerTaskId')).toMatchObject({ value: CGT, copy: true })
      const parsed = JSON.parse(d.json) as { ids: Record<string, unknown> }
      expect(parsed.ids).toEqual({ taskId: 't1', upstreamTaskId: 'task_a', providerTaskId: CGT, clientId: null })
    })

    it('那一版没记下火山号:标 missing,不拿卡片现在的号冒充', () => {
      const d = buildTaskDetail(two([{ ...v1, providerTaskId: undefined }, v2]), { index: 0, now: T0, versionIdx: 0 })
      expect(field(d, 'providerTaskId')).toMatchObject({ missing: true })
      expect(field(d, 'providerTaskId').value).toMatch(/未记录/)
      expect(field(d, 'providerTaskId').value).not.toContain('cgt-latest')
    })

    it('版本行与版本 JSON 带火山号;没有就不出现', () => {
      const d = buildTaskDetail(two([v1, v2]), { index: 0, now: T0 })
      const rows = d.sections.find((s) => s.key === 'versions')!.fields
      expect(rows[0].value).toContain(`火山 ${CGT}`)
      expect(rows[1].value).not.toContain('火山')
      const parsed = JSON.parse(d.json) as { versions: Array<Record<string, unknown>> }
      expect(parsed.versions[0]).toMatchObject({ providerTaskId: CGT })
      expect(Object.hasOwn(parsed.versions[1], 'providerTaskId')).toBe(false)
    })
  })
})

describe('样片 / 成片的请求参数写实际发出去的分辨率', () => {
  it('样片 480p;成片 1080p(旧卡没有选档字段);样片升 4K 写 4k', () => {
    const base = { status: 'succeeded' as const, taskId: 'task_x', billing: 'platform' as const, resolution: '720p' as const }
    expect(buildTaskDetail(card({ ...base, draftRun: true }), { index: 0 }).request).toMatchObject({ resolution: '480p', draft: true })
    expect(buildTaskDetail(card({ ...base, fromDraftTaskId: 'task_d' }), { index: 0 }).request).toMatchObject({
      resolution: '1080p',
      fromDraftTaskId: 'task_d',
    })
    expect(
      buildTaskDetail(card({ ...base, fromDraftTaskId: 'task_d', draftFinalResolution: '4k' }), { index: 0 }).request,
    ).toMatchObject({ resolution: '4k', fromDraftTaskId: 'task_d' })
  })
})

describe('请求参数', () => {
  it('记规格与素材;素材只记名字与 https/本地地址,data: 字节绝不进文档', () => {
    const d = buildTaskDetail(
      card({
        status: 'running',
        taskId: 't',
        seed: 42,
        webSearch: true,
        referenceImages: [
          { name: '贴图.png', src: 'data:image/png;base64,AAAABBBBCCCCDDDD' },
          { name: '立绘', src: 'https://cos.example/a.png' },
          { name: 'local.png', src: 'D:\\refs\\local.png' },
        ],
      }),
      { index: 0 },
    )
    expect(d.request).toMatchObject({
      prompt: '一只赛博猫在雨夜奔跑',
      model: '2.5',
      mode: 'multimodal_ref',
      resolution: '480p',
      ratio: '16:9',
      duration: 6,
      generateAudio: true,
      webSearch: true,
      seed: 42,
    })
    const images = (d.request as { referenceImages: Array<Record<string, unknown>> }).referenceImages
    expect(images).toEqual([
      { name: '贴图.png', src: '(内嵌 data: 图,已省略)' },
      { name: '立绘', src: 'https://cos.example/a.png' },
      { name: 'local.png', src: 'D:\\refs\\local.png' },
    ])
    expect(d.json).not.toContain('AAAABBBB')
    expect(JSON.parse(d.json)).toMatchObject({ ids: { upstreamTaskId: null }, request: { seed: 42 } })
  })

  it('提交过的卡:素材 src 用实际递给上游的 https 地址,本地路径退到 local;data: 图有了地址就不再是占位', () => {
    const d = buildTaskDetail(
      card({
        status: 'succeeded',
        taskId: 't',
        referenceImages: [
          { name: '下载 (2).png', src: 'C:\\Users\\me\\Downloads\\下载 (2).png' },
          { name: '贴图.png', src: 'data:image/png;base64,AAAABBBBCCCCDDDD' },
          { name: '立绘', src: 'https://cos.example/a.png' },
        ],
        referenceVideos: [{ name: 'ref.mp4', src: 'D:\\clips\\ref.mp4' }],
        submittedReferences: {
          images: ['https://cos.example/relay/1.png', 'https://cos.example/relay/2.png', 'https://cos.example/a.png'],
          videos: ['https://cos.example/relay/ref.mp4'],
          audios: [],
        },
      }),
      { index: 0 },
    )
    const req = d.request as {
      referenceImages: Array<Record<string, unknown>>
      referenceVideos: Array<Record<string, unknown>>
    }
    expect(req.referenceImages).toEqual([
      { name: '下载 (2).png', src: 'https://cos.example/relay/1.png', local: 'C:\\Users\\me\\Downloads\\下载 (2).png' },
      { name: '贴图.png', src: 'https://cos.example/relay/2.png' },
      { name: '立绘', src: 'https://cos.example/a.png' },
    ])
    expect(req.referenceVideos).toEqual([{ name: 'ref.mp4', src: 'https://cos.example/relay/ref.mp4', local: 'D:\\clips\\ref.mp4' }])
    expect(d.json).not.toContain('AAAABBBB')
  })

  it('递上去的地址条数与卡上素材对不上(老数据 / 被上游折叠):按下标能对上的用地址,其余退回原样', () => {
    const d = buildTaskDetail(
      card({
        status: 'succeeded',
        taskId: 't',
        referenceImages: [
          { name: 'a.png', src: 'C:\\a.png' },
          { name: 'b.png', src: 'C:\\b.png' },
        ],
        submittedReferences: { images: ['https://cos.example/relay/a.png'], videos: [], audios: [] },
      }),
      { index: 0 },
    )
    const images = (d.request as { referenceImages: Array<Record<string, unknown>> }).referenceImages
    expect(images).toEqual([
      { name: 'a.png', src: 'https://cos.example/relay/a.png', local: 'C:\\a.png' },
      { name: 'b.png', src: 'C:\\b.png' },
    ])
  })
})

describe('时间与结果', () => {
  it('进行中:耗时按 now 算;终态:按 updatedAt 算', () => {
    const running = buildTaskDetail(
      card({ status: 'running', taskId: 't', startedAt: T0, updatedAt: T0 + 5_000 }),
      { index: 0, now: T0 + 95_000 },
    )
    expect(field(running, 'elapsed').value).toBe('1 分 35 秒')
    const done = buildTaskDetail(
      card({ status: 'succeeded', taskId: 't', startedAt: T0, updatedAt: T0 + 61_000 }),
      { index: 0, now: T0 + 999_000 },
    )
    expect(field(done, 'elapsed').value).toBe('1 分 01 秒')
  })

  it('结果区:本地成片带 path(给「在文件夹中显示」),云端与临时地址可复制,计费口径按模型', () => {
    const d = buildTaskDetail(
      card({
        status: 'succeeded',
        taskId: 't',
        localPath: 'D:\\out\\v.mp4',
        remoteUrl: 'https://cos.example/v.mp4',
        videoUrl: 'https://tos.example/tmp.mp4',
        persistence: 'done',
        actualSeed: 7,
        completionTokens: 81234,
      }),
      { index: 0 },
    )
    expect(field(d, 'localPath')).toMatchObject({ value: 'D:\\out\\v.mp4', path: 'D:\\out\\v.mp4', copy: true })
    expect(field(d, 'remoteUrl')).toMatchObject({ value: 'https://cos.example/v.mp4', copy: true })
    expect(field(d, 'videoUrl')).toMatchObject({ value: 'https://tos.example/tmp.mp4', copy: true })
    expect(field(d, 'actualSeed').value).toBe('7')
    expect(field(d, 'billed').value).toMatch(/81,?234/)
    expect(field(d, 'billed').label).toMatch(/token/i)
  })

  it('失败卡:错误原文进结果区;按秒计费的万相显示秒数', () => {
    const failed = buildTaskDetail(card({ status: 'failed', taskId: 't', error: 'ContentFilter: 触发审核' }), { index: 0 })
    expect(field(failed, 'error').value).toBe('ContentFilter: 触发审核')
    const wan = buildTaskDetail(card({ model: 'wan3', status: 'succeeded', taskId: 't', billedSeconds: 5 }), { index: 0 })
    expect(field(wan, 'billed').value).toBe('5 秒')
  })
})

describe('历史版本', () => {
  it('每版一行:序号 / 时间 / 任务号 / 上游任务号', () => {
    const d = buildTaskDetail(
      card({
        status: 'succeeded',
        taskId: 't2',
        upstreamTaskId: 'cgt-2',
        versions: [
          { id: 'v1', seq: 1, createdAt: T0, taskId: 't1', upstreamTaskId: 'cgt-1', localPath: 'D:\\v1.mp4', spec: specOf() },
          { id: 'v2', seq: 2, createdAt: T0 + 60_000, taskId: 't2', upstreamTaskId: 'cgt-2', spec: specOf() },
        ],
      }),
      { index: 0 },
    )
    const versions = d.sections.find((s) => s.key === 'versions')!
    expect(versions.fields.map((f) => f.label)).toEqual(['v1', 'v2'])
    expect(versions.fields[0].value).toMatch(/t1/)
    expect(versions.fields[0].value).toMatch(/cgt-1/)
    const parsed = JSON.parse(d.json) as { versions: Array<Record<string, unknown>> }
    expect(parsed.versions).toEqual([
      expect.objectContaining({ seq: 1, taskId: 't1', upstreamTaskId: 'cgt-1', localPath: 'D:\\v1.mp4' }),
      expect.objectContaining({ seq: 2, taskId: 't2', upstreamTaskId: 'cgt-2' }),
    ])
  })

  it('没有版本就没有这一区', () => {
    const d = buildTaskDetail(card({ status: 'running', taskId: 't' }), { index: 0 })
    expect(d.sections.find((s) => s.key === 'versions')).toBeUndefined()
  })
})

describe('按版本查看(卡片切到 v1,面板就得是 v1 那一轮的事实)', () => {
  const v1: VideoWorkbenchVersion = {
    id: 'v1',
    seq: 1,
    createdAt: T0,
    taskId: 't1',
    upstreamTaskId: 'cgt-1',
    localPath: 'D:\\v1.mp4',
    actualSeed: 11,
    submittedReferences: { images: ['https://cos.example/relay/a.png'], videos: [], audios: [] },
    spec: { ...specOf(), prompt: '第一版', seed: 3, referenceBrief: { images: ['a.png', 'b.png'], videos: [], audios: [] } },
  }
  const v2: VideoWorkbenchVersion = { id: 'v2', seq: 2, createdAt: T0 + 60_000, taskId: 't2', upstreamTaskId: 'cgt-2', localPath: 'D:\\v2.mp4', spec: specOf() }
  const two = () =>
    card({
      prompt: '第二版',
      status: 'succeeded',
      taskId: 't2',
      upstreamTaskId: 'cgt-2',
      clientId: 'wb-2',
      billing: 'platform',
      startedAt: T0 + 30_000,
      localPath: 'D:\\v2.mp4',
      referenceImages: [{ name: 'c.png', src: 'C:\\c.png' }],
      versions: [v1, v2],
    })

  it('指向更早的版本:标识 / 结果 / 请求参数全部来自那条存档,卡片当前字段不混进来', () => {
    const d = buildTaskDetail(two(), { index: 1, now: T0, versionIdx: 0 })
    expect(d.title).toBe('#02 · 任务详情 · v1/2')
    expect(d.view).toEqual({ historical: true, seq: 1, total: 2 })
    expect(field(d, 'taskId')).toMatchObject({ value: 't1', copy: true })
    expect(field(d, 'upstreamTaskId')).toMatchObject({ value: 'cgt-1', copy: true })
    expect(field(d, 'cardId').value).toBe('card0000aa')
    // 存档里没有的东西说缺,不拿卡片当前值充数
    expect(field(d, 'clientId')).toMatchObject({ missing: true })
    expect(field(d, 'billing')).toMatchObject({ missing: true })
    expect(field(d, 'createdAt').value).toBeTruthy()
    expect(d.sections.find((s) => s.key === 'timing')!.fields.map((f) => f.key)).not.toContain('elapsed')
    expect(field(d, 'status').value).toBe('已完成')
    expect(field(d, 'localPath')).toMatchObject({ value: 'D:\\v1.mp4', path: 'D:\\v1.mp4' })
    expect(field(d, 'actualSeed').value).toBe('11')
    expect(d.request).toMatchObject({ prompt: '第一版', seed: 3 })
    // 素材只有名字;递上去的地址按下标能对上就写,对不上只写名字
    expect((d.request as { referenceImages: unknown }).referenceImages).toEqual([
      { name: 'a.png', src: 'https://cos.example/relay/a.png' },
      { name: 'b.png' },
    ])
    const parsed = JSON.parse(d.json) as Record<string, unknown>
    expect(parsed).toMatchObject({
      view: { historical: true, seq: 1, total: 2 },
      status: 'succeeded',
      ids: { taskId: 't1', upstreamTaskId: 'cgt-1', clientId: null },
      request: { prompt: '第一版' },
      result: { localPath: 'D:\\v1.mp4' },
    })
    expect(d.json).not.toContain('c.png')
  })

  it('历史版本区标出当前展示的那一版,并带下标给面板做「查看」', () => {
    const d = buildTaskDetail(two(), { index: 0, now: T0, versionIdx: 0 })
    const rows = d.sections.find((s) => s.key === 'versions')!.fields
    expect(rows.map((f) => [f.versionIdx, f.current])).toEqual([
      [0, true],
      [1, false],
    ])
  })

  it('指向最后一版 = 卡片当前结果:与不传 versionIdx 完全一致,标题仍标 vN/N', () => {
    const same = two() // 同一个卡片对象:buildCard 每次都会盖新的 updatedAt
    const latest = buildTaskDetail(same, { index: 0, now: T0, versionIdx: 1 })
    const plain = buildTaskDetail(same, { index: 0, now: T0 })
    expect(latest).toEqual(plain)
    expect(latest.title).toBe('#01 · 任务详情 · v2/2')
    expect(latest.view).toEqual({ historical: false, seq: 2, total: 2 })
    expect(field(latest, 'taskId').value).toBe('t2')
    expect(field(latest, 'clientId').value).toBe('wb-2')
    expect(latest.request).toMatchObject({ prompt: '第二版' })
    expect(latest.sections.find((s) => s.key === 'versions')!.fields.map((f) => f.current)).toEqual([false, true])
  })

  it('越界 / 负数 / 非整数下标按最新一版处理,不抛', () => {
    for (const idx of [5, -1, 0.5]) {
      const d = buildTaskDetail(two(), { index: 0, now: T0, versionIdx: idx })
      expect(d.view.historical).toBe(false)
      expect(field(d, 'taskId').value).toBe('t2')
    }
  })

  it('那一版没记下上游号:该行标 missing,不拿卡片现在的号冒充', () => {
    const noUpstream: VideoWorkbenchVersion = { ...v1, upstreamTaskId: undefined }
    const d = buildTaskDetail(card({ ...two(), versions: [noUpstream, v2] }), { index: 0, now: T0, versionIdx: 0 })
    expect(field(d, 'upstreamTaskId')).toMatchObject({ missing: true })
    expect(field(d, 'upstreamTaskId').value).toMatch(/未记录/)
    expect(field(d, 'upstreamTaskId').copy).toBeFalsy()
  })

  it('subject:最新一版取卡片字段;历史版取存档(状态记已完成、计费没存所以是 undefined)', () => {
    const latest = buildTaskDetail(two(), { index: 0, now: T0 })
    expect(latest.subject).toEqual({ status: 'succeeded', billing: 'platform', model: '2.5', taskId: 't2' })

    const old = buildTaskDetail(two(), { index: 0, now: T0, versionIdx: 0 })
    expect(old.subject).toEqual({ status: 'succeeded', billing: undefined, model: '2.5', taskId: 't1' })

    // 历史版本用自己 spec 里的模型,不是卡片当前的模型
    const v1Wan: VideoWorkbenchVersion = { ...v1, spec: { ...v1.spec, model: 'wan3' } }
    const mixed = buildTaskDetail(card({ ...two(), versions: [v1Wan, v2] }), { index: 0, now: T0, versionIdx: 0 })
    expect(mixed.subject.model).toBe('wan3')
  })

  it('subject:没提交 / 没记任务号时 taskId 是 undefined', () => {
    const fresh = buildTaskDetail(card({ status: 'idle' }), { index: 0, now: T0 })
    expect(fresh.subject.taskId).toBeUndefined()
    const noId: VideoWorkbenchVersion = { ...v1, taskId: undefined }
    const old = buildTaskDetail(card({ ...two(), versions: [noId, v2] }), { index: 0, now: T0, versionIdx: 0 })
    expect(old.subject.taskId).toBeUndefined()
  })

  it('只有一版时不标 vN/N(没有可切的)', () => {
    const d = buildTaskDetail(card({ status: 'succeeded', taskId: 't1', versions: [v1] }), { index: 0, now: T0, versionIdx: 0 })
    expect(d.title).toBe('#01 · 任务详情')
    expect(d.view).toEqual({ historical: false, seq: 1, total: 1 })
  })
})

function specOf() {
  return {
    prompt: 'p',
    model: '2.5' as const,
    resolution: '480p' as const,
    ratio: '16:9' as const,
    duration: 6,
    generateAudio: true,
    mode: 'multimodal_ref' as const,
    webSearch: false,
    referenceBrief: { images: [], videos: [], audios: [] },
  }
}

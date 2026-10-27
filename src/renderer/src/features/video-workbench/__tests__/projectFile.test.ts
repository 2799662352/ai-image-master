// 工程文件 `*.catwb.json`:格式、加固解析、导出规划、导入规划 —— 全部纯函数。
import { describe, expect, it } from 'vitest'
import type { VideoWorkbenchBoard, VideoWorkbenchProject } from '../../../../../types/videoWorkbench'
import { buildCard } from '../cardSpec'
import {
  PROJECT_FILE_FORMAT,
  PROJECT_FILE_MAX_BYTES,
  PROJECT_FILE_VERSION,
  buildProjectFile,
  collectExportTargets,
  parseProjectFile,
  planImport,
  uniqueProjectName,
} from '../projectFile'

const project: VideoWorkbenchProject = {
  id: 'p1', name: '追车戏 · 夜景', order: 0, createdAt: 1_000, updatedAt: 2_000, summary: '三集 · 夜外',
}
const boards: VideoWorkbenchBoard[] = [
  { id: 'b2', projectId: 'p1', name: '隧道', order: 1, createdAt: 2 },
  { id: 'b1', projectId: 'p1', name: '建立镜头', summary: '城市夜景', order: 0, createdAt: 1 },
  { id: 'x1', projectId: 'other', name: '别剧', order: 0, createdAt: 1 },
]
const app = { name: 'CATIMATION-Cyberpunk Master', version: '4.8.1' }
const NOW = Date.UTC(2026, 8, 6, 10, 0, 0)

function cards() {
  const a = buildCard({
    prompt: '主角跳车',
    referenceImages: [
      { name: 'ref.png', src: 'https://cos.example/ref.png' },
      { name: 'local.png', src: 'D:\\pics\\local.png' },
      { name: '立绘', src: 'asset://portrait-1', previewUrl: 'https://cos.example/portrait-1.png' },
    ],
    referenceVideos: [{ name: 'clip.mp4', src: 'C:\\clips\\clip.mp4' }],
  }, 0, 'b1')
  const b = {
    ...buildCard({ prompt: '追兵逼近', duration: 10 }, 1, 'b1'),
    status: 'succeeded' as const,
    remoteUrl: 'https://cos.example/v2.mp4',
    localPath: 'C:\\out\\v2.mp4',
    summary: '追兵 · 夜外',
    versions: [
      { id: 'v1', seq: 1, createdAt: 1, remoteUrl: 'https://cos.example/v1.mp4', spec: { prompt: '旧版提示词' } },
      { id: 'v2', seq: 2, createdAt: 2, localPath: 'C:\\out\\v2.mp4', remoteUrl: 'https://cos.example/v2.mp4', spec: { prompt: '追兵逼近' } },
    ] as never,
  }
  const c = { ...buildCard({ prompt: '生成中的卡' }, 0, 'b2'), status: 'running' as const, taskId: 't-1' }
  const d = { ...buildCard({ prompt: '只有本地成片' }, 1, 'b2'), status: 'succeeded' as const, localPath: 'C:\\out\\d.mp4' }
  const foreign = buildCard({ prompt: '别剧的卡' }, 0, 'x1')
  return [c, d, b, a, foreign]
}

describe('collectExportTargets', () => {
  it('只统计本剧;待上传 = 非 https 素材(带 previewUrl 的 asset:// 不算)+ 只有 localPath 的成片', () => {
    const t = collectExportTargets(boards.filter((b) => b.projectId === 'p1'), cards())
    expect(t.segments).toBe(2)
    expect(t.cards).toBe(4)
    expect(t.materials).toBe(4)
    expect(t.pending.map((p) => p.src)).toEqual(['C:\\out\\d.mp4', 'D:\\pics\\local.png', 'C:\\clips\\clip.mp4'])
    expect(t.pending.map((p) => p.kind)).toEqual(['result', 'material', 'material'])
  })
})

describe('buildProjectFile / parseProjectFile 往返', () => {
  const resolve = (src: string) => {
    if (src === 'D:\\pics\\local.png') return 'https://cos.example/local.png'
    if (src === 'C:\\clips\\clip.mp4') return 'https://cos.example/clip.mp4'
    if (src === 'C:\\out\\d.mp4') return 'https://cos.example/d.mp4'
    return null
  }

  it('分段按 order、卡按 order;素材全 https;asset:// 取 previewUrl;结果只留状态与云端地址;生成中变 draft;无任何 id', () => {
    const r = buildProjectFile({ project, boards, cards: cards(), app, now: NOW, resolve })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const f = r.file
    expect(f.format).toBe(PROJECT_FILE_FORMAT)
    expect(f.formatVersion).toBe(PROJECT_FILE_VERSION)
    expect(f.app).toEqual(app)
    expect(f.exportedAt).toBe('2026-09-06T10:00:00.000Z')
    expect(f.project).toEqual({ name: '追车戏 · 夜景', createdAt: 1_000, updatedAt: 2_000, summary: '三集 · 夜外' })
    expect(f.boards.map((b) => b.name)).toEqual(['建立镜头', '隧道'])
    expect(f.boards[0].summary).toBe('城市夜景')
    const [a, b] = f.boards[0].cards
    expect(a.prompt).toBe('主角跳车')
    expect(a.referenceImages.map((m) => m.src)).toEqual([
      'https://cos.example/ref.png', 'https://cos.example/local.png', 'https://cos.example/portrait-1.png',
    ])
    expect(a.referenceVideos[0].src).toBe('https://cos.example/clip.mp4')
    expect(a.result).toEqual({ status: 'draft' })
    expect(b.summary).toBe('追兵 · 夜外')
    expect(b.result).toEqual({
      status: 'succeeded',
      remoteUrl: 'https://cos.example/v2.mp4',
      versions: [
        { seq: 1, remoteUrl: 'https://cos.example/v1.mp4', prompt: '旧版提示词' },
        { seq: 2, remoteUrl: 'https://cos.example/v2.mp4', prompt: '追兵逼近' },
      ],
    })
    const [c, d] = f.boards[1].cards
    expect(c.result).toEqual({ status: 'draft' })
    expect(d.result).toEqual({ status: 'succeeded', remoteUrl: 'https://cos.example/d.mp4' })
    const text = JSON.stringify(f)
    expect(text).not.toMatch(/"(id|boardId|projectId|localPath|taskId|clientId)":/)
    expect(text).not.toContain('D:\\\\pics')
    expect(text).not.toContain('asset://')

    const parsed = parseProjectFile(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.file).toEqual(f)
    expect(parsed.summary).toEqual({ segments: 2, cards: 4, materials: 4, exportedAt: f.exportedAt, appVersion: '4.8.1' })
  })

  it('有素材解析不到 https → 拒绝(不写半个文件)', () => {
    const r = buildProjectFile({ project, boards, cards: cards(), app, now: NOW, resolve: () => null })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('local.png')
  })
})

describe('parseProjectFile 加固', () => {
  const good = () => {
    const r = buildProjectFile({ project, boards, cards: [buildCard({ prompt: 'p' }, 0, 'b1')], app, now: NOW, resolve: () => null })
    if (!r.ok) throw new Error('fixture')
    return r.file
  }

  it('format 不符 → code format;高版本 → code version;非 JSON / 缺字段 → code invalid', () => {
    expect(parseProjectFile(JSON.stringify({ ...good(), format: 'something-else' }))).toMatchObject({ ok: false, code: 'format' })
    expect(parseProjectFile(JSON.stringify({ ...good(), formatVersion: PROJECT_FILE_VERSION + 1 }))).toMatchObject({ ok: false, code: 'version' })
    expect(parseProjectFile('{not json')).toMatchObject({ ok: false, code: 'invalid' })
    expect(parseProjectFile(JSON.stringify({ ...good(), project: { name: 42 } }))).toMatchObject({ ok: false, code: 'invalid' })
    expect(parseProjectFile(JSON.stringify({ ...good(), boards: [{ name: 'x', cards: [{ prompt: 1 }] }] }))).toMatchObject({ ok: false, code: 'invalid' })
    expect(parseProjectFile(JSON.stringify({ ...good(), boards: [{ name: 'x', cards: [{ prompt: 'p', referenceImages: [{ name: 'a' }] }] }] }))).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('__proto__ / constructor / prototype 键 → 拒绝', () => {
    const text = JSON.stringify(good()).replace('"project":', '"__proto__":{"polluted":1},"project":')
    expect(parseProjectFile(text)).toMatchObject({ ok: false, code: 'invalid' })
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
    const text2 = JSON.stringify(good()).replace('"project":', '"constructor":{"prototype":{}},"project":')
    expect(parseProjectFile(text2)).toMatchObject({ ok: false, code: 'invalid' })
  })

  it('未知字段放行(向前兼容);超过 50 MB 拒绝', () => {
    const withExtra = { ...good(), futureField: { a: 1 }, boards: [{ ...good().boards[0], extra: true }] }
    const r = parseProjectFile(JSON.stringify(withExtra))
    expect(r.ok).toBe(true)
    const huge = 'x'.repeat(PROJECT_FILE_MAX_BYTES + 1)
    expect(parseProjectFile(huge)).toMatchObject({ ok: false, code: 'too-large' })
  })
})

describe('uniqueProjectName', () => {
  it('不重名原样;重名加 (2)、(3)', () => {
    expect(uniqueProjectName('新剧', ['别的'])).toBe('新剧')
    expect(uniqueProjectName('新剧', ['新剧'])).toBe('新剧 (2)')
    expect(uniqueProjectName('新剧', ['新剧', '新剧 (2)'])).toBe('新剧 (3)')
    expect(uniqueProjectName('  ', [])).toBe('导入的剧')
  })
})

describe('planImport', () => {
  it('把文件展开成 store 能吃的分段/卡片输入;结果与摘要跟着走', () => {
    const r = buildProjectFile({
      project, boards, cards: cards(), app, now: NOW,
      resolve: (src) => `https://cos.example/${src.split(/[\\/]/).pop()}`,
    })
    if (!r.ok) throw new Error('fixture')
    const plan = planImport(r.file)
    expect(plan.boards.map((b) => b.name)).toEqual(['建立镜头', '隧道'])
    expect(plan.boards[0].summary).toBe('城市夜景')
    const [a, b] = plan.boards[0].cards
    expect(a.input.prompt).toBe('主角跳车')
    expect(a.input.referenceImages).toHaveLength(3)
    expect((a.input.referenceImages![1] as { src: string }).src).toBe('https://cos.example/local.png')
    expect(a.result).toEqual({ status: 'draft' })
    expect(b.summary).toBe('追兵 · 夜外')
    expect(b.result?.status).toBe('succeeded')
    expect(b.result?.remoteUrl).toBe('https://cos.example/v2.mp4')
    expect(b.result?.versions).toHaveLength(2)
  })
})

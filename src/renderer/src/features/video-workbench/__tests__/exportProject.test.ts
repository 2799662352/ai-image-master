// 导出编排:清点 → 上传待上传项 → 组装 → 原子写。任何一步失败都不写文件。
import { describe, expect, it, vi } from 'vitest'
import type { VideoWorkbenchBoard, VideoWorkbenchProject } from '../../../../../types/videoWorkbench'
import { buildCard } from '../cardSpec'
import { runProjectExport, type ExportApi } from '../exportProject'

const project: VideoWorkbenchProject = { id: 'p1', name: '追车戏', order: 0, createdAt: 1, updatedAt: 2 }
const boards: VideoWorkbenchBoard[] = [{ id: 'b1', projectId: 'p1', name: '建立镜头', order: 0, createdAt: 1 }]
const app = { name: 'CATIMATION', version: '4.8.1' }

function cards() {
  const a = buildCard({
    prompt: 'A',
    referenceImages: [
      { name: 'cloud.png', src: 'https://cos/cloud.png' },
      { name: 'local.png', src: 'D:\\pics\\local.png' },
      { name: 'pasted.png', src: 'data:image/png;base64,AAAA' },
    ],
  }, 0, 'b1')
  const b = { ...buildCard({ prompt: 'B' }, 1, 'b1'), status: 'succeeded' as const, localPath: 'C:\\out\\b.mp4' }
  return [a, b]
}

function api(overrides: Partial<ExportApi> = {}): ExportApi & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    resolveRefMedia: vi.fn(async (p: string) => {
      calls.push(`path:${p}`)
      return { ok: true as const, url: `https://cos/uploaded/${p.split(/[\\/]/).pop()}` }
    }),
    uploadDataUrl: vi.fn(async (d: string) => {
      calls.push(`data:${d.slice(0, 20)}`)
      return 'https://cos/uploaded/pasted.png'
    }),
    write: vi.fn(async (path: string) => ({ ok: true as const, path })),
    ...overrides,
  }
}

describe('runProjectExport', () => {
  it('本地素材与只有本地副本的成片先上传,拿到的地址写进文件;data: 图走字节直传;进度按项回报', async () => {
    const a = api()
    const progress: Array<[number, number]> = []
    const r = await runProjectExport({
      project, boards, cards: cards(), app, path: 'D:\\Docs\\追车戏.catwb.json', api: a, now: 0,
      onProgress: (done, total) => progress.push([done, total]),
    })
    expect(r).toEqual({ ok: true, path: 'D:\\Docs\\追车戏.catwb.json', uploaded: 3 })
    expect(a.calls.sort()).toEqual(['data:data:image/png;base6', 'path:C:\\out\\b.mp4', 'path:D:\\pics\\local.png'])
    expect(progress.at(-1)).toEqual([3, 3])
    const json = JSON.parse((a.write as ReturnType<typeof vi.fn>).mock.calls[0][1])
    const [ca, cb] = json.boards[0].cards
    expect(ca.referenceImages.map((m: { src: string }) => m.src)).toEqual([
      'https://cos/cloud.png', 'https://cos/uploaded/local.png', 'https://cos/uploaded/pasted.png',
    ])
    expect(cb.result).toEqual({ status: 'succeeded', remoteUrl: 'https://cos/uploaded/b.mp4' })
  })

  it('某个上传失败 → 整体失败、不写文件、原因点名素材', async () => {
    const a = api({
      resolveRefMedia: vi.fn(async (p: string) =>
        p.endsWith('local.png') ? { ok: false as const, reason: 'offline' } : { ok: true as const, url: 'https://cos/x.mp4' }),
    })
    const r = await runProjectExport({ project, boards, cards: cards(), app, path: 'D:\\x.catwb.json', api: a, now: 0 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('local.png')
    expect(a.write).not.toHaveBeenCalled()
  })

  it('上传通道不可用(非 Electron)→ 明确原因;写失败 → 透传原因', async () => {
    const noApi = api({ resolveRefMedia: undefined, uploadDataUrl: undefined })
    const r1 = await runProjectExport({ project, boards, cards: cards(), app, path: 'D:\\x.catwb.json', api: noApi, now: 0 })
    expect(r1).toMatchObject({ ok: false })
    expect(noApi.write).not.toHaveBeenCalled()

    const bad = api({ write: vi.fn(async () => ({ ok: false as const, reason: 'EACCES' })) })
    const r2 = await runProjectExport({ project, boards, cards: cards(), app, path: 'D:\\x.catwb.json', api: bad, now: 0 })
    expect(r2).toEqual({ ok: false, reason: 'EACCES' })
  })

  it('没有待上传项时不调上传,直接写', async () => {
    const a = api()
    const only = [buildCard({ prompt: 'C', referenceImages: ['https://cos/c.png'] }, 0, 'b1')]
    const r = await runProjectExport({ project, boards, cards: only, app, path: 'D:\\x.catwb.json', api: a, now: 0 })
    expect(r).toMatchObject({ ok: true, uploaded: 0 })
    expect(a.resolveRefMedia).not.toHaveBeenCalled()
  })
})

// 导入编排:读 → 加固解析 → 摘要;失败透传 code。
import { describe, expect, it } from 'vitest'
import type { VideoWorkbenchBoard, VideoWorkbenchProject } from '../../../../../types/videoWorkbench'
import { buildCard } from '../cardSpec'
import { isProjectFileName, loadProjectFile } from '../importProject'
import { PROJECT_FILE_VERSION, buildProjectFile } from '../projectFile'

const project: VideoWorkbenchProject = { id: 'p1', name: '追车戏', order: 0, createdAt: 1, updatedAt: 2 }
const boards: VideoWorkbenchBoard[] = [{ id: 'b1', projectId: 'p1', name: '建立镜头', order: 0, createdAt: 1 }]

function goodText(): string {
  const r = buildProjectFile({
    project, boards, cards: [buildCard({ prompt: 'p', referenceImages: ['https://cos/a.png'] }, 0, 'b1')],
    app: { name: 'CATIMATION', version: '4.8.1' }, now: 0, resolve: () => null,
  })
  if (!r.ok) throw new Error('fixture')
  return JSON.stringify(r.file)
}

describe('loadProjectFile', () => {
  it('读到合法文件 → file + summary', async () => {
    const r = await loadProjectFile('D:\\x.catwb.json', {
      read: async (path) => ({ ok: true, path, text: goodText() }),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.path).toBe('D:\\x.catwb.json')
    expect(r.file.project.name).toBe('追车戏')
    expect(r.summary).toMatchObject({ segments: 1, cards: 1, materials: 1, appVersion: '4.8.1' })
  })

  it('读失败透传 code/reason;高版本文件 → code version 且提示更新', async () => {
    const r1 = await loadProjectFile('D:\\missing.catwb.json', {
      read: async () => ({ ok: false, code: 'not-found', reason: '文件不存在' }),
    })
    expect(r1).toEqual({ ok: false, path: 'D:\\missing.catwb.json', code: 'not-found', reason: '文件不存在' })

    const future = JSON.stringify({ ...JSON.parse(goodText()), formatVersion: PROJECT_FILE_VERSION + 1 })
    const r2 = await loadProjectFile('D:\\future.catwb.json', {
      read: async (path) => ({ ok: true, path, text: future }),
    })
    expect(r2).toMatchObject({ ok: false, code: 'version' })
    if (r2.ok) return
    expect(r2.reason).toContain('更新')
  })
})

describe('isProjectFileName', () => {
  it('只认 .catwb.json 后缀,大小写不敏感', () => {
    expect(isProjectFileName('追车戏.catwb.json')).toBe(true)
    expect(isProjectFileName('X.CATWB.JSON')).toBe(true)
    expect(isProjectFileName('a.json')).toBe(false)
    expect(isProjectFileName('catwb.json.png')).toBe(false)
  })
})

// 工程文件里的分组名 `project.group`:没分组的剧导出的文件和以前逐字节一样(云备份指纹不变);
// 带分组的随文件走,导入 / 云端恢复按名字并入本机同名分组;解析对这个装饰性字段是宽松的。
import { describe, expect, it } from 'vitest'
import type { VideoWorkbenchBoard, VideoWorkbenchProject } from '../../../../../types/videoWorkbench'
import { buildCard } from '../cardSpec'
import { fingerprintFile } from '../cloudBackup'
import { PROJECT_FILE_VERSION, buildProjectFile, parseProjectFile, type WorkbenchProjectFile } from '../projectFile'

const base: VideoWorkbenchProject = { id: 'p1', name: '追车戏', order: 0, createdAt: 1_000, updatedAt: 2_000, summary: '三集' }
const boards: VideoWorkbenchBoard[] = [{ id: 'b1', projectId: 'p1', name: '建立镜头', order: 0, createdAt: 1 }]
const cards = [buildCard({ prompt: '一镜' }, 0, 'b1')]
const app = { name: 'CATIMATION-Cyberpunk Master', version: '4.9.39' }
const NOW = Date.UTC(2026, 10, 16, 10, 0, 0)

const build = (project: VideoWorkbenchProject): WorkbenchProjectFile => {
  const r = buildProjectFile({ project, boards, cards, app, now: NOW, resolve: () => null })
  if (!r.ok) throw new Error('fixture')
  return r.file
}

describe('导出', () => {
  it('带分组:写 project.group,排在 project 的最后一个键', () => {
    const file = build({ ...base, group: '外传' })
    expect(file.project.group).toBe('外传')
    expect(Object.keys(file.project)).toEqual(['name', 'createdAt', 'updatedAt', 'summary', 'group'])
  })

  it('没分组:不写这个键,文件和从没有 group 字段的剧导出的逐字节一样,指纹不变', async () => {
    const plain = build(base)
    expect('group' in plain.project).toBe(false)
    expect(Object.keys(plain.project)).toEqual(['name', 'createdAt', 'updatedAt', 'summary'])
    // 字段存在但是 undefined / 空白 / 非法 → 同样不写
    for (const g of [undefined, '', '   ']) {
      const file = build({ ...base, group: g as string | undefined })
      expect(JSON.stringify(file)).toBe(JSON.stringify(plain))
      expect(await fingerprintFile(file)).toBe(await fingerprintFile(plain))
    }
  })

  it('分组名进指纹:换了分组就是新内容(云备份会再传一版),同名分组指纹相同', async () => {
    const a = await fingerprintFile(build({ ...base, group: '外传' }))
    const b = await fingerprintFile(build({ ...base, group: '主线' }))
    const c = await fingerprintFile(build({ ...base, group: '  外传 ' }))
    const none = await fingerprintFile(build(base))
    expect(a).not.toBe(b)
    expect(a).not.toBe(none)
    expect(a).toBe(c)
  })

  it('过长的分组名按上限截断(和库里的规则一致)', () => {
    expect(build({ ...base, group: '长'.repeat(40) }).project.group).toBe('长'.repeat(24))
  })
})

describe('解析', () => {
  const parse = (project: Record<string, unknown>) => {
    const file = build(base)
    return parseProjectFile(JSON.stringify({ ...file, project: { ...file.project, ...project } }))
  }

  it('往返:带分组的文件解析出同名分组;没有 group 的老文件解析出来也没有这个键', () => {
    const withGroup = parseProjectFile(JSON.stringify(build({ ...base, group: '外传' })))
    expect(withGroup.ok && withGroup.file.project.group).toBe('外传')
    const old = parseProjectFile(JSON.stringify(build(base)))
    expect(old.ok).toBe(true)
    expect(old.ok && 'group' in old.file.project).toBe(false)
  })

  it('宽松:非字符串 / 空 / 纯空白 → 当没分组,整份文件照常打开(不因一个装饰字段拒绝)', () => {
    for (const bad of [42, true, null, {}, [], '', '   ']) {
      const r = parse({ group: bad })
      expect(r.ok).toBe(true)
      expect(r.ok && 'group' in r.file.project).toBe(false)
    }
  })

  it('规整:首尾空白去掉、内部空白折叠、过长截断', () => {
    const r1 = parse({ group: '  第一   季 ' })
    expect(r1.ok && r1.file.project.group).toBe('第一 季')
    const r2 = parse({ group: '长'.repeat(40) })
    expect(r2.ok && r2.file.project.group).toBe('长'.repeat(24))
  })

  it('加字段是纯增量:formatVersion 不动(旧客户端不会因版本号拒绝带分组的文件;它解析时对未知字段放行)', () => {
    expect(build({ ...base, group: '外传' }).formatVersion).toBe(PROJECT_FILE_VERSION)
  })
})

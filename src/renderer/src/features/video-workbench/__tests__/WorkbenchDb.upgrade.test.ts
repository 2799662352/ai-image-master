// v2 → v3 升级:老 board 归入默认项目;projects store 与索引就位;幂等。
// 用 fake-indexeddb 在 jsdom 里提供真 IndexedDB;每个用例新建独立数据库实例。
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT_ID } from '../../../../../types/videoWorkbench'
import { assignDefaultProject, getWorkbenchDb, resetWorkbenchDbForTest } from '../WorkbenchDb'

const DB_NAME = 'catimation-video-workbench'

/** 手工造一个 v2 库:cards + boards 两个 store,boards 没有 projectId。 */
function seedV2(boards: Array<{ id: string; name: string; order: number }>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2)
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore('cards', { keyPath: 'id' }).createIndex('order', 'order')
      db.createObjectStore('boards', { keyPath: 'id' })
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('boards', 'readwrite')
      for (const b of boards) tx.objectStore('boards').put({ ...b, createdAt: 1 })
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
    req.onerror = () => reject(req.error)
  })
}

function openRaw(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

beforeEach(() => {
  // 每个用例一个全新的 IndexedDB 世界
  ;(globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  resetWorkbenchDbForTest()
})

describe('assignDefaultProject(纯函数)', () => {
  it('缺 projectId 的补默认项目,已有的不动,并报告是否有改动', () => {
    const r = assignDefaultProject([
      { id: 'a', name: 'A', order: 0, createdAt: 1 } as never,
      { id: 'b', name: 'B', order: 1, createdAt: 1, projectId: 'p9' },
    ])
    expect(r.changed).toBe(true)
    expect(r.boards.map((b) => b.projectId)).toEqual([DEFAULT_PROJECT_ID, 'p9'])
    expect(assignDefaultProject(r.boards).changed).toBe(false)
  })
})

describe('v2 → v3', () => {
  it('老 board 全部归入默认项目,projects 里有默认项目', async () => {
    await seedV2([
      { id: 'b1', name: '页面 1', order: 0 },
      { id: 'b2', name: '页面 2', order: 1 },
    ])
    const db = getWorkbenchDb()
    const boards = await db.listBoards()
    expect(boards.map((b) => b.projectId)).toEqual([DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID])
    const projects = await db.listProjects()
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({ id: DEFAULT_PROJECT_ID, name: '默认项目', legacy: true })
    // 升级事务里已把 projectId 写回库,而不是只在读出时补
    const raw = await openRaw()
    const stored = await new Promise<Array<{ projectId?: string }>>((resolve, reject) => {
      const r = raw.transaction('boards').objectStore('boards').getAll()
      r.onsuccess = () => resolve(r.result as Array<{ projectId?: string }>)
      r.onerror = () => reject(r.error)
    })
    expect(stored.every((b) => b.projectId === DEFAULT_PROJECT_ID)).toBe(true)
    raw.close()
  })

  it('索引与 store 就位', async () => {
    await seedV2([])
    await getWorkbenchDb().listProjects()
    const raw = await openRaw()
    expect(raw.version).toBe(3)
    expect(Array.from(raw.objectStoreNames)).toEqual(expect.arrayContaining(['cards', 'boards', 'projects']))
    expect(raw.transaction('boards').objectStore('boards').indexNames.contains('by-project')).toBe(true)
    expect(raw.transaction('cards').objectStore('cards').indexNames.contains('by-board')).toBe(true)
    raw.close()
  })

  it('全新库直接建 v3,也带默认项目', async () => {
    const projects = await getWorkbenchDb().listProjects()
    expect(projects.map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID])
  })

  it('putProject / removeProject 往返', async () => {
    const db = getWorkbenchDb()
    await db.putProject({ id: 'p1', name: '追车戏', order: 1, createdAt: 1, updatedAt: 1 })
    expect((await db.listProjects()).map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID, 'p1'])
    await db.removeProject('p1')
    expect((await db.listProjects()).map((p) => p.id)).toEqual([DEFAULT_PROJECT_ID])
  })
})

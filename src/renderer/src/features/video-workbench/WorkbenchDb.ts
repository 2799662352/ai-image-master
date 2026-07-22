// src/renderer/src/features/video-workbench/WorkbenchDb.ts
/**
 * 「生成视频」工作台卡片持久化（IndexedDB）。
 *
 * 参考 AudioLibraryStore 的模式:参考素材可能是几 MB 的 data: URL,
 * localStorage(~5MB 配额)装不下,所以用 IndexedDB;环境不支持(jsdom 测试/
 * 极端异常)时降级为进程内内存表,页面功能不受影响,只是不跨重启。
 *
 * 存的是完整卡片(草稿参数 + 参考素材 + 任务结果元数据 localPath/remoteUrl),
 * 视频字节本身不进 IndexedDB —— 本地 mp4 由主进程 SeedanceTaskManager 落
 * userData 目录,远端在 COS,这里只背两个地址。
 */

import type { VideoWorkbenchCard } from '../../../../types/videoWorkbench'

const DB_NAME = 'catimation-video-workbench'
const DB_VERSION = 1
const STORE = 'cards'

/** 卡片总量上限:超出后删最旧的已终态卡(防素材 data: URL 无限膨胀)。 */
export const WORKBENCH_MAX_CARDS = 200

export class WorkbenchDb {
  private dbPromise: Promise<IDBDatabase | null> | null = null
  private memory = new Map<string, VideoWorkbenchCard>()
  private useMemory = typeof indexedDB === 'undefined'

  private openDb(): Promise<IDBDatabase | null> {
    if (this.useMemory) return Promise.resolve(null)
    if (this.dbPromise) return this.dbPromise
    this.dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains(STORE)) {
            const store = db.createObjectStore(STORE, { keyPath: 'id' })
            store.createIndex('order', 'order')
          }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => {
          console.warn('[WorkbenchDb] IndexedDB 打开失败,降级内存表:', req.error)
          this.useMemory = true
          resolve(null)
        }
      } catch (e) {
        console.warn('[WorkbenchDb] IndexedDB 不可用,降级内存表:', e)
        this.useMemory = true
        resolve(null)
      }
    })
    return this.dbPromise
  }

  private tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
    return db.transaction(STORE, mode).objectStore(STORE)
  }

  private request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  async put(card: VideoWorkbenchCard): Promise<void> {
    const db = await this.openDb()
    if (!db) {
      this.memory.set(card.id, card)
      return
    }
    await this.request(this.tx(db, 'readwrite').put(card))
  }

  async remove(id: string): Promise<void> {
    const db = await this.openDb()
    if (!db) {
      this.memory.delete(id)
      return
    }
    await this.request(this.tx(db, 'readwrite').delete(id))
  }

  /** 全量列表,按 order 升序(卷轴从上到下)。 */
  async list(): Promise<VideoWorkbenchCard[]> {
    const db = await this.openDb()
    const items = db
      ? await this.request<VideoWorkbenchCard[]>(this.tx(db, 'readonly').getAll())
      : [...this.memory.values()]
    return items.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
  }

  /** 超上限时删最旧的终态卡片(生成中的不动)。返回被删 id。 */
  async evict(): Promise<string[]> {
    const items = await this.list()
    if (items.length <= WORKBENCH_MAX_CARDS) return []
    const terminal = items
      .filter((c) => c.status === 'succeeded' || c.status === 'failed' || c.status === 'draft')
      .sort((a, b) => a.createdAt - b.createdAt)
    const removed: string[] = []
    for (const card of terminal.slice(0, items.length - WORKBENCH_MAX_CARDS)) {
      await this.remove(card.id)
      removed.push(card.id)
    }
    return removed
  }
}

let instance: WorkbenchDb | null = null

export function getWorkbenchDb(): WorkbenchDb {
  if (!instance) instance = new WorkbenchDb()
  return instance
}

/** 测试用:重置单例。 */
export function resetWorkbenchDbForTest(): void {
  instance = null
}

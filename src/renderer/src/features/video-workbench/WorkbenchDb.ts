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

import type { VideoWorkbenchBoard, VideoWorkbenchCard } from '../../../../types/videoWorkbench'

const DB_NAME = 'catimation-video-workbench'
// v2:新增 boards object store(多「页」工作区)。v1 老库 onupgradeneeded 原地补建,cards 数据不动。
const DB_VERSION = 2
const STORE = 'cards'
const BOARD_STORE = 'boards'

/** 卡片总量上限:超出后删最旧的已终态卡(防素材 data: URL 无限膨胀)。 */
export const WORKBENCH_MAX_CARDS = 200

/** 素材三类的字段名 —— 剥 uploadState 时逐类扫。 */
const MATERIAL_FIELDS = ['referenceImages', 'referenceVideos', 'referenceAudios'] as const

/**
 * 落库前剥掉素材上的 `uploadState`(预传的转圈 / 打勾 / 感叹号)。
 *
 * 它是**界面的进行态**,不是数据:存下来重启会画出一个转圈,而那一刻根本没有上传
 * 在跑,它会一直转下去。水合时由 `uploadedUrl` 还在不在重新算出 `uploaded`。
 *
 * 地址本身(`uploadedUrl` + `uploadedAt`)**要存** —— 那是这条链路省下的那次上传的
 * 全部意义。安全性由另外两道兜底保证,见 `MATERIAL_UPLOAD_URL_TTL_MS` 与 store 的
 * 「失败即清」。
 *
 * 没有可剥的就原样返回 —— 提交草稿是逐字符防抖落库的,不该每次都复制一遍卡片。
 */
function stripTransientUploadState(card: VideoWorkbenchCard): VideoWorkbenchCard {
  const dirty = MATERIAL_FIELDS.filter((field) => card[field]?.some((m) => m.uploadState !== undefined))
  if (dirty.length === 0) return card
  const next = { ...card }
  for (const field of dirty) {
    next[field] = card[field].map(({ uploadState: _state, ...rest }) => rest)
  }
  return next
}

export class WorkbenchDb {
  private dbPromise: Promise<IDBDatabase | null> | null = null
  private memory = new Map<string, VideoWorkbenchCard>()
  private memoryBoards = new Map<string, VideoWorkbenchBoard>()
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
          if (!db.objectStoreNames.contains(BOARD_STORE)) {
            db.createObjectStore(BOARD_STORE, { keyPath: 'id' })
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

  private tx(db: IDBDatabase, mode: IDBTransactionMode, store: string = STORE): IDBObjectStore {
    return db.transaction(store, mode).objectStore(store)
  }

  private request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  async put(card: VideoWorkbenchCard): Promise<void> {
    const record = stripTransientUploadState(card)
    const db = await this.openDb()
    if (!db) {
      this.memory.set(record.id, record)
      return
    }
    await this.request(this.tx(db, 'readwrite').put(record))
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

  // ==================== 「页」(board) ====================

  async putBoard(board: VideoWorkbenchBoard): Promise<void> {
    const db = await this.openDb()
    if (!db) {
      this.memoryBoards.set(board.id, board)
      return
    }
    await this.request(this.tx(db, 'readwrite', BOARD_STORE).put(board))
  }

  async removeBoard(id: string): Promise<void> {
    const db = await this.openDb()
    if (!db) {
      this.memoryBoards.delete(id)
      return
    }
    await this.request(this.tx(db, 'readwrite', BOARD_STORE).delete(id))
  }

  /** 全部页,按 order 升序(页签从左到右)。 */
  async listBoards(): Promise<VideoWorkbenchBoard[]> {
    const db = await this.openDb()
    const items = db
      ? await this.request<VideoWorkbenchBoard[]>(this.tx(db, 'readonly', BOARD_STORE).getAll())
      : [...this.memoryBoards.values()]
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

// src/renderer/src/features/audio/AudioLibraryStore.ts
/**
 * 音频作品库存储。
 *
 * 音频 base64 一条就可能有几 MB,localStorage(~5MB 配额)装不下,所以用
 * IndexedDB;环境不支持(jsdom 测试/极端异常)时降级为进程内内存表,页面
 * 功能不受影响,只是不跨重启。波形峰值(peaks)首次解码后回写记录,避免
 * 每次渲染重复 decodeAudioData。
 */

export interface AudioLibraryItem {
  id: string
  /** 生成时的自然语言描述(场景/角色/环境音)。 */
  prompt: string
  /** 实际编码格式(mp3 / ogg_opus / wav)。 */
  format: string
  /** 音频时长(秒,上游 duration;缺省 0)。 */
  duration: number
  /** 计费秒数(original_duration,展示用)。 */
  billedSeconds: number
  createdAt: number
  /**
   * 本地文件路径(方案 A 主路径):字节落 userData/audio-history/,
   * 播放走 local-file://,IndexedDB 只背元数据。
   */
  filePath?: string
  /**
   * 裸 base64 音频数据(无 data: 前缀)。仅当本地落盘不可用
   * (非 Electron 环境/写盘失败)时的降级存储;与 filePath 二选一。
   */
  audioBase64?: string
  /** 上游音频 URL(可能不存在)。 */
  remoteUrl?: string
  /** 波形峰值缓存(0~1,首次渲染时计算回写)。 */
  peaks?: number[]
}

const DB_NAME = 'catimation-audio-library'
const DB_VERSION = 1
const STORE = 'items'

/** 库容量上限:超出后删最旧的(音频体积大,防 IndexedDB 无限膨胀)。 */
export const AUDIO_LIBRARY_MAX_ITEMS = 100

export class AudioLibraryStore {
  private dbPromise: Promise<IDBDatabase | null> | null = null
  /** IndexedDB 不可用时的内存降级表(仅当前会话)。 */
  private memory = new Map<string, AudioLibraryItem>()
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
            store.createIndex('createdAt', 'createdAt')
          }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => {
          console.warn('[AudioLibraryStore] IndexedDB 打开失败,降级内存表:', req.error)
          this.useMemory = true
          resolve(null)
        }
      } catch (e) {
        console.warn('[AudioLibraryStore] IndexedDB 不可用,降级内存表:', e)
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

  async add(item: AudioLibraryItem): Promise<void> {
    const db = await this.openDb()
    if (!db) {
      this.memory.set(item.id, item)
      this.evictMemory()
      return
    }
    await this.request(this.tx(db, 'readwrite').put(item))
    await this.evictDb(db)
  }

  async update(id: string, patch: Partial<AudioLibraryItem>): Promise<void> {
    const db = await this.openDb()
    if (!db) {
      const existing = this.memory.get(id)
      if (existing) this.memory.set(id, { ...existing, ...patch, id })
      return
    }
    const store = this.tx(db, 'readwrite')
    const existing = await this.request<AudioLibraryItem | undefined>(store.get(id))
    if (existing) await this.request(store.put({ ...existing, ...patch, id }))
  }

  async remove(id: string): Promise<void> {
    const db = await this.openDb()
    if (!db) {
      this.memory.delete(id)
      return
    }
    await this.request(this.tx(db, 'readwrite').delete(id))
  }

  async get(id: string): Promise<AudioLibraryItem | null> {
    const db = await this.openDb()
    if (!db) return this.memory.get(id) ?? null
    const item = await this.request<AudioLibraryItem | undefined>(this.tx(db, 'readonly').get(id))
    return item ?? null
  }

  /** 全量列表,新的在前。 */
  async list(): Promise<AudioLibraryItem[]> {
    const db = await this.openDb()
    if (!db) {
      return [...this.memory.values()].sort((a, b) => b.createdAt - a.createdAt)
    }
    const items = await this.request<AudioLibraryItem[]>(this.tx(db, 'readonly').getAll())
    return items.sort((a, b) => b.createdAt - a.createdAt)
  }

  private evictMemory(): void {
    if (this.memory.size <= AUDIO_LIBRARY_MAX_ITEMS) return
    const sorted = [...this.memory.values()].sort((a, b) => a.createdAt - b.createdAt)
    for (const item of sorted.slice(0, this.memory.size - AUDIO_LIBRARY_MAX_ITEMS)) {
      this.memory.delete(item.id)
    }
  }

  private async evictDb(db: IDBDatabase): Promise<void> {
    try {
      const items = await this.request<AudioLibraryItem[]>(this.tx(db, 'readonly').getAll())
      if (items.length <= AUDIO_LIBRARY_MAX_ITEMS) return
      const oldest = items.sort((a, b) => a.createdAt - b.createdAt).slice(0, items.length - AUDIO_LIBRARY_MAX_ITEMS)
      const store = this.tx(db, 'readwrite')
      for (const item of oldest) await this.request(store.delete(item.id))
    } catch (e) {
      console.warn('[AudioLibraryStore] 容量清理失败(忽略):', e)
    }
  }
}

let instance: AudioLibraryStore | null = null

export function getAudioLibraryStore(): AudioLibraryStore {
  if (!instance) instance = new AudioLibraryStore()
  return instance
}

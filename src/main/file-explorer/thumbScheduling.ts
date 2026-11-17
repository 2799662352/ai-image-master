/**
 * `media:thumb` 的两个调度原语:限并发的执行器 + 按字节封顶的 LRU 缓存。
 *
 * 为什么需要(真 Electron 窗口量测,60 张全新的 2336px JPEG,没有系统缩略图缓存):
 *  - 对话里有几百张本地生成图时,渲染层一次发出几百个 `media:thumb`。系统自带的
 *    缩略图提供者(`nativeImage.createThumbnailFromPath`)的结果会在同一个事件循环轮次里
 *    集中回来,每张在主线程上还要 `toJPEG` + base64:60 张一起发,主进程事件循环被占住
 *    1.5 s;限成 4 并发,总耗时不变,事件循环最长只停 ~90 ms。
 *  - 同一张图换个入口(file:/// 与 local-file:///)、重新打开线程,都会重新生成一遍。
 *    结果只有几 KB~几十 KB,按 (真实路径, mtime, 大小, 尺寸) 记住即可,文件变了自动失效。
 */

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>

/** 同一时刻最多跑 `max` 个任务,其余按到达顺序排队。 */
export function createLimiter(max: number): Limiter {
  const cap = Math.max(1, Math.floor(max))
  let active = 0
  const queue: Array<() => void> = []

  const release = (): void => {
    active -= 1
    const next = queue.shift()
    if (next) next()
  }

  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = (): void => {
        active += 1
        // task 同步抛错也要归还名额,所以包一层 Promise;先归还名额再交结果,
        // 这样调用方拿到结果时,排在后面的任务已经开跑了。
        new Promise<T>((res) => res(task())).then(
          (v) => {
            release()
            resolve(v)
          },
          (e: unknown) => {
            release()
            reject(e)
          },
        )
      }
      if (active < cap) start()
      else queue.push(start)
    })
}

export interface ByteLruCache<V> {
  get(key: string): V | undefined
  set(key: string, value: V, bytes: number): void
  readonly size: number
  readonly bytes: number
  clear(): void
}

/** 总字节数封顶的 LRU:读一次就算「最近用过」,超出就从最久没用的开始丢。 */
export function createByteLru<V>(maxBytes: number): ByteLruCache<V> {
  const map = new Map<string, { value: V; bytes: number }>()
  let total = 0

  return {
    get(key) {
      const hit = map.get(key)
      if (!hit) return undefined
      // 重新插入 = 挪到「最近」一端。
      map.delete(key)
      map.set(key, hit)
      return hit.value
    },
    set(key, value, bytes) {
      const old = map.get(key)
      if (old) {
        total -= old.bytes
        map.delete(key)
      }
      // 单条就超过总预算:不缓存(缓存了也只会把别的全挤掉)。
      if (bytes > maxBytes) return
      map.set(key, { value, bytes })
      total += bytes
      for (const [k, entry] of map) {
        if (total <= maxBytes) break
        map.delete(k)
        total -= entry.bytes
      }
    },
    get size() {
      return map.size
    },
    get bytes() {
      return total
    },
    clear() {
      map.clear()
      total = 0
    },
  }
}

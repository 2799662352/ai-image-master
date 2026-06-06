import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

/**
 * 可复用的「持久化 state」hook —— 用户调过的参数退出后再进还在。
 *
 * 设计(遵循 React best-practices 4.4「Version and Minimize localStorage」):
 * - 带命名空间 + 版本前缀的 key,改结构时升版本即自动失效旧数据。
 * - 读写全程 try/catch:无痕模式 / 配额满 / 被禁用都不会抛。
 * - 惰性初始化:只在首次渲染读一次 localStorage。
 * - 写入做 200ms 防抖:拖滑杆不会每帧狂写磁盘。
 *
 * 各编辑器共用:PanoramaEditor / LightEditor / MultiAngleEditor 等都可直接调用,
 * 只要 key 不冲突即可(建议用 'pano.fov' / 'light.intensity' 这种带前缀的 key)。
 */

const NS = 'imgeditor'
// v2:全景默认改为中性曲度/无辉光(对齐 HTML 直渲清晰度),升版以清掉旧的 1.3/辉光持久值。
const VERSION = 'v2'

function storageKey(key: string): string {
  return `${NS}:${VERSION}:${key}`
}

export function readPersisted<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(storageKey(key))
    if (raw == null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writePersisted<T>(key: string, value: T): void {
  try {
    localStorage.setItem(storageKey(key), JSON.stringify(value))
  } catch {
    /* 无痕 / 配额满 / 禁用:静默降级,内存态照常工作 */
  }
}

export function usePersistentState<T>(
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => readPersisted(key, initial))

  const timer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => writePersisted(key, state), 200)
    return () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
    }
  }, [key, state])

  return [state, setState]
}

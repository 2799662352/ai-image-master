/**
 * 出图渠道选择器的个人偏好:钉到「常用」的渠道 + 最近使用。
 *
 * 存本机 localStorage(与 `selectedImageChannel` 同一个思路,桌面端是单机单用户)。
 * 读出来的内容一律当不可信输入:逐项校验、去重、截断后才进状态,JSON 坏了就当没有。
 * 不用 zustand persist —— 它不校验读出来的内容,而这里的 id 会拿去匹配清单。
 */
import { create } from 'zustand'

export const IMAGE_CHANNEL_PREFS_STORAGE_KEY = 'catimation.agent.imageChannelPrefs.v1'
/** 存储上限(防异常数据撑爆);界面上「常用 ≤ 10」由 arrangeChannelMenu 控制。 */
export const MAX_STORED_PINNED = 20
export const MAX_STORED_RECENT = 8
const MAX_ID_LENGTH = 128

export interface ImageChannelPrefs {
  /** 用户自己钉到「常用」的渠道 id,按钉的先后。 */
  pinned: string[]
  /** 最近选过的渠道 id,最新在前。 */
  recent: string[]
}

function cleanIdList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || !item || item.length > MAX_ID_LENGTH || out.includes(item)) continue
    out.push(item)
    if (out.length >= max) break
  }
  return out
}

/** 把读出来的任意 JSON 规整成合法偏好;任何字段不合法都退成空,不抛错。 */
export function sanitizeImageChannelPrefs(raw: unknown): ImageChannelPrefs {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    pinned: cleanIdList(record.pinned, MAX_STORED_PINNED),
    recent: cleanIdList(record.recent, MAX_STORED_RECENT),
  }
}

function readPrefs(): ImageChannelPrefs {
  try {
    const text = globalThis.localStorage?.getItem(IMAGE_CHANNEL_PREFS_STORAGE_KEY)
    return sanitizeImageChannelPrefs(text ? JSON.parse(text) : null)
  } catch {
    return { pinned: [], recent: [] }
  }
}

function writePrefs(prefs: ImageChannelPrefs): void {
  try {
    globalThis.localStorage?.setItem(IMAGE_CHANNEL_PREFS_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // 隐私模式 / 配额满:本次会话内仍然生效
  }
}

interface ImageChannelPrefsState extends ImageChannelPrefs {
  togglePin: (channelId: string) => void
  recordUse: (channelId: string) => void
  /** 重新从 localStorage 载入(测试 / 外部清空存储后用)。 */
  reload: () => void
}

export const useImageChannelPrefsStore = create<ImageChannelPrefsState>((set, get) => ({
  ...readPrefs(),

  togglePin: (channelId) => {
    if (!channelId || channelId.length > MAX_ID_LENGTH) return
    const { pinned, recent } = get()
    let nextPinned: string[]
    if (pinned.includes(channelId)) {
      nextPinned = pinned.filter((id) => id !== channelId)
    } else {
      if (pinned.length >= MAX_STORED_PINNED) return
      nextPinned = [...pinned, channelId]
    }
    set({ pinned: nextPinned })
    writePrefs({ pinned: nextPinned, recent })
  },

  recordUse: (channelId) => {
    if (!channelId || channelId.length > MAX_ID_LENGTH) return
    const { pinned, recent } = get()
    if (recent[0] === channelId) return
    const nextRecent = [channelId, ...recent.filter((id) => id !== channelId)].slice(0, MAX_STORED_RECENT)
    set({ recent: nextRecent })
    writePrefs({ pinned, recent: nextRecent })
  },

  reload: () => set(readPrefs()),
}))

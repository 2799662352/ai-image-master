// 素材「预传地址」缓存的体检(渲染端一侧)。
//
// 预传拿到的 COS 地址现在会连同来源指纹一起落库(见 types 里 `uploadedUrl` /
// `uploadedFrom` 的说明),重启后素材不必退回「只剩本地路径、提交时再传一遍」。
// 代价是**用之前必须确认它还对**:本地文件可能被改过、云端对象可能被人删了。
// 真正的判定在主进程(`media:verify-uploaded-materials`,要 `fs.stat` 与 HEAD),
// 本模块只做三件事:
//   1. 从卡片里收集「带缓存地址的素材」(带定位信息,回写时按它对号入座);
//   2. 调主进程体检,并把「没桥 / 抛错 / 超时」统一成 `null`;
//   3. 记「本会话已确认云端还活着」的地址,免得每次提交都对同一个地址再 HEAD 一遍。
//
// 底线与主进程一致:**拿不准就丢**。丢掉缓存的代价只是回到「提交时由主进程从本地路径
// 现传」的老行为(慢,但一定对)。

import type { VideoWorkbenchCard, VideoWorkbenchMaterial } from '../../../../types/videoWorkbench'
import type { MaterialKind } from './cardSpec'

const MATERIAL_KINDS: readonly MaterialKind[] = ['referenceImages', 'referenceVideos', 'referenceAudios']

/** 提交前体检的总时限。网络很差时宁可放弃缓存重传,也不让「点了生成没反应」拖下去。 */
export const SUBMIT_VERIFY_TIMEOUT_MS = 15_000

export interface UploadVerdict {
  keep: boolean
  local: 'same' | 'changed' | 'missing' | 'unverifiable'
  remote: 'alive' | 'dead' | 'unknown' | 'skipped'
}

type VerifyBridge = (args: {
  items: Array<{
    src: string
    uploadedUrl: string
    uploadedFrom?: { src: string; size?: number; mtimeMs?: number }
  }>
  checkRemote: boolean
}) => Promise<UploadVerdict[]>

function getVerifyBridge(): VerifyBridge | undefined {
  return (
    window as Window & {
      electronAPI?: { attachments?: { verifyUploadedMaterials?: VerifyBridge } }
    }
  ).electronAPI?.attachments?.verifyUploadedMaterials
}

/** 一条「带缓存地址的素材」,附定位信息。 */
export interface UploadEntry {
  cardId: string
  kind: MaterialKind
  index: number
  src: string
  uploadedUrl: string
  uploadedFrom?: VideoWorkbenchMaterial['uploadedFrom']
  uploadState?: VideoWorkbenchMaterial['uploadState']
}

/** 收集给定卡片上所有带缓存地址的素材。 */
export function collectUploadEntries(cards: readonly VideoWorkbenchCard[]): UploadEntry[] {
  const out: UploadEntry[] = []
  for (const card of cards) {
    for (const kind of MATERIAL_KINDS) {
      card[kind]?.forEach((m, index) => {
        if (typeof m.uploadedUrl === 'string' && m.uploadedUrl.length > 0) {
          out.push({
            cardId: card.id,
            kind,
            index,
            src: m.src,
            uploadedUrl: m.uploadedUrl,
            uploadedFrom: m.uploadedFrom,
            uploadState: m.uploadState,
          })
        }
      })
    }
  }
  return out
}

// ---- 本会话已确认云端还活着的地址 ----

const aliveUrls = new Set<string>()

/** 刚预传成功,或体检探到 200:本会话内不必再探云端。 */
export function markUploadAlive(url: string): void {
  aliveUrls.add(url)
}

export function isUploadAlive(url: string): boolean {
  return aliveUrls.has(url)
}

export function forgetUploadAlive(url: string): void {
  aliveUrls.delete(url)
}

export function resetUploadCacheForTest(): void {
  aliveUrls.clear()
}

// ---- 调主进程体检 ----

/**
 * 体检一批条目。返回数组与 `entries` 一一对应;**没有桥 / 抛错 / 超时一律返回 `null`**,
 * 由调用方按「验证不了」处理(丢缓存)。空输入不发 IPC。
 */
export async function verifyUploadEntries(
  entries: readonly UploadEntry[],
  opts: { checkRemote: boolean; timeoutMs?: number },
): Promise<UploadVerdict[] | null> {
  if (entries.length === 0) return []
  const bridge = getVerifyBridge()
  if (!bridge) return null

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const call = bridge({
      items: entries.map((e) => ({
        src: e.src,
        uploadedUrl: e.uploadedUrl,
        ...(e.uploadedFrom
          ? {
              uploadedFrom: {
                src: e.uploadedFrom.src,
                size: e.uploadedFrom.size,
                mtimeMs: e.uploadedFrom.mtimeMs,
              },
            }
          : {}),
      })),
      checkRemote: opts.checkRemote,
    })
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), opts.timeoutMs ?? SUBMIT_VERIFY_TIMEOUT_MS)
    })
    const verdicts = await Promise.race([call, timeout])
    // 长度对不上说明桥版本不一致或实现出错,不能按下标对号入座。
    if (!Array.isArray(verdicts) || verdicts.length !== entries.length) return null
    return verdicts
  } catch (err) {
    console.warn('[vwUploadCache] 体检失败,按验证不了处理:', err)
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

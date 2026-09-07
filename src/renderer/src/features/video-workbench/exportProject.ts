// 导出一部剧为工程文件:清点 → 上传待上传项 → 组装 → 主进程原子写。
//
// 上传复用两条既有通道:本地路径走 `attachments.resolveRefMedia`(主进程从磁盘流式
// 传 COS,与「拖入即传」同源);粘贴的 data: 图走 `cos.uploadImageHistory`(字节直传,
// 可 await)。任何一项拿不到 https 就整体失败、**不写文件** —— 半份工程比没有更糟。
//
// 与 store 解耦:调用方把 project/boards/cards 和一组 api 函数传进来,测试直接喂 mock。

import type { VideoWorkbenchBoard, VideoWorkbenchCard, VideoWorkbenchProject } from '../../../../types/videoWorkbench'
import { buildProjectFile, collectExportTargets, isHttpsUrl } from './projectFile'

export interface ExportApi {
  /** 本地路径 → COS https(主进程流式上传)。缺省 = 非 Electron 环境。 */
  resolveRefMedia?: (path: string) => Promise<{ ok: true; url: string } | { ok: false; reason: string }>
  /** `data:image/*` → COS https。缺省 = 非 Electron 环境。 */
  uploadDataUrl?: (dataUrl: string) => Promise<string | null>
  write: (path: string, json: string) => Promise<{ ok: true; path: string } | { ok: false; reason: string }>
}

export interface RunProjectExportOptions {
  project: VideoWorkbenchProject
  boards: readonly VideoWorkbenchBoard[]
  cards: readonly VideoWorkbenchCard[]
  app: { name: string; version: string }
  path: string
  api: ExportApi
  onProgress?: (done: number, total: number) => void
  now?: number
  concurrency?: number
}

export type RunProjectExportResult =
  | { ok: true; path: string; uploaded: number }
  | { ok: false; reason: string }

async function uploadOne(src: string, api: ExportApi): Promise<string> {
  if (src.startsWith('data:')) {
    if (!/^data:image\//i.test(src)) throw new Error('内联的视频/音频素材无法上传,请先换成文件或云端地址')
    if (!api.uploadDataUrl) throw new Error('当前环境没有上传通道')
    const url = await api.uploadDataUrl(src)
    if (!url || !isHttpsUrl(url)) throw new Error('上传失败')
    return url
  }
  if (!api.resolveRefMedia) throw new Error('当前环境没有上传通道')
  const r = await api.resolveRefMedia(src)
  if (!r.ok) throw new Error(r.reason)
  // COS 不可达时主进程会把小文件降级成内联 data URL —— 对导出是净亏,当失败。
  if (!isHttpsUrl(r.url)) throw new Error('COS 不可达,拿不到云端地址')
  return r.url
}

/** 有限并发跑一组任务;第一个失败即停止派发新任务(已在途的照常结束)。 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  let failed: unknown = null
  const worker = async (): Promise<void> => {
    while (failed === null) {
      const i = next++
      if (i >= items.length) return
      try {
        out[i] = await fn(items[i])
      } catch (e) {
        failed = e
        return
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (failed !== null) throw failed
  return out
}

export async function runProjectExport(opts: RunProjectExportOptions): Promise<RunProjectExportResult> {
  const own = opts.boards.filter((b) => b.projectId === opts.project.id)
  const targets = collectExportTargets(own, opts.cards)
  // 同一个源(同一张图挂在两张卡上)只传一次;上游按下标解析素材,这里换的是地址不是槽位,不怕折叠。
  const srcs = [...new Set(targets.pending.map((p) => p.src))]
  const nameOf = new Map<string, string>()
  for (const p of targets.pending) {
    if (p.kind === 'material') {
      const card = opts.cards.find((c) => c.id === p.cardId)
      const m = card?.[p.field][p.index]
      if (m) nameOf.set(p.src, m.name)
    } else {
      nameOf.set(p.src, '成片')
    }
  }
  const resolved = new Map<string, string>()
  let done = 0
  opts.onProgress?.(0, srcs.length)
  try {
    await mapLimit(srcs, opts.concurrency ?? 3, async (src) => {
      try {
        resolved.set(src, await uploadOne(src, opts.api))
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e)
        throw new Error(`「${nameOf.get(src) ?? src}」上传失败:${why}`)
      }
      done += 1
      opts.onProgress?.(done, srcs.length)
    })
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
  const built = buildProjectFile({
    project: opts.project,
    boards: opts.boards,
    cards: opts.cards,
    app: opts.app,
    now: opts.now ?? Date.now(),
    resolve: (src) => resolved.get(src) ?? null,
  })
  if (!built.ok) return { ok: false, reason: built.reason }
  const written = await opts.api.write(opts.path, JSON.stringify(built.file, null, 2))
  if (!written.ok) return { ok: false, reason: written.reason }
  return { ok: true, path: written.path, uploaded: srcs.length }
}

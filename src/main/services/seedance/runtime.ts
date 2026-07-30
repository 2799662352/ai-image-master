// Seedance 运行时接线：TaskManager 单例 + ToolRouter main handler + 设置 IPC。
// 由 index.ts 在 MCP runtime 就绪后调用一次。

import { ipcMain, net, type BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ToolRouter } from '../../mcp/ToolRouter'
import type { AttachmentService } from '../../agent/AttachmentService'
import { CHECK_LONG_POLL_MS } from '../../mcp/tools/videoTools'
import { reconcileInFlightTasks } from './adoption'
import { seedanceClient } from './client'
import {
  getSeedanceApiKey,
  getSeedanceApiSecret,
  getSeedanceKeyState,
  setSeedanceCredentials,
} from './credentials'
import {
  deleteSeedanceAssets,
  getSeedanceAssetCapacity,
  importSeedanceAsset,
  listSeedanceAssets,
  listSeedanceOfficialMaterials,
  translateSeedanceTaskError,
  verifyContentAssetReferences,
} from './assets'
import {
  getPortraitOverlay,
  mutatePortraitOverlay,
  onPortraitOverlayChange,
} from './portraitOverlay'
import { normalizeSeedancePromptReferences } from './promptReferences'
import { SeedanceTaskManager } from './taskManager'
import { describeCosError } from '../tencent/cosErrors'
import { relayBufferToCos, relayDataUrlToCos, relayFileToCos } from '../tencent/mediaRelay'
import type { CreateVideoTaskInput, SeedanceContentItem } from './types'
import type {
  PortraitOverlayMutation,
  PortraitOverlayState,
  SeedanceAssetImportInput,
  SeedanceAssetItem,
  SeedanceAssetKindFilter,
  SeedanceAssetListQuery,
  SeedanceOfficialMaterialsQuery,
} from '../../../types/seedance'

/**
 * data: URL 内联的安全上限。上游对 url 字段有长度限制(实测 ~1MB 原始
 * 字节就可能触发 `400 url is too long`),所以只有小文件才内联;更大的
 * 文件走 COS 中转(历史图片上传链路)换 https URL 再提交。
 */
const MAX_INLINE_FILE_BYTES = 512 * 1024
/**
 * 上游 `url` 字段能吃下的内联体积(实测约 1MB 原始字节后开始 `400 url is too
 * long`)。只用在一个地方:中转失败时判断「降级回内联」还不还有希望 ——
 * 512KB~1MB 这个窗口里内联仍在上游限内,值得一试;更大就只能报错。
 */
const MAX_UPSTREAM_INLINE_BYTES = 1024 * 1024
/** download_portrait_asset 下载体积上限(防止超大视频拖垮内存)。 */
const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024

/** 无 threadId 的任务(手动 MCP 调用等)落到这个伪线程目录。 */
const FALLBACK_THREAD_ID = 'seedance'

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
}

/**
 * 本地路径 → 可提交上游的 URL;http(s)/asset: 原样透传。
 * - 小文件(≤512KB)内联 data: URL;
 * - 大文件走 COS 中转(与历史图片上传同一条链路)换 https URL —— 上游对
 *   data: 长度有硬限制(`400 url is too long`),COS 中转既绕开限制又更快;
 * - data: URL 同理:超过内联上限时转存 COS。
 *
 * **这里不设体积闸门。** 本地文件走 `relayFileToCos` 从磁盘分片流式上传,
 * 整个文件不进 Node Buffer,所以「多大算太大」不该由我们猜:上游自己会对
 * 超限素材返回明确的 400,那个错误比我们编一个数字准。历史上这里卡了一道
 * 50MB,结果是用户被我们挡下,却看不到上游到底允许多少。
 */
async function resolveMediaUrl(src: string, label: string): Promise<string> {
  const trimmed = src.trim()
  if (/^(https?:|asset:)/i.test(trimmed)) return trimmed
  if (/^data:/i.test(trimmed)) {
    if (trimmed.length <= MAX_INLINE_FILE_BYTES * 1.4) return trimmed
    try {
      return await relayDataUrlToCos(trimmed)
    } catch (e) {
      // 仍在上游内联限内就降级重试内联(COS 不可达而模型接口可达时这条路救命);
      // 超出就必须报错 —— 硬塞进去只会换来一句莫名其妙的 `url is too long`。
      if (trimmed.length <= MAX_UPSTREAM_INLINE_BYTES * 1.4) {
        console.warn(`[seedance] ${label}: COS relay failed, falling back to inline data URL:`, e)
        return trimmed
      }
      throw new Error(`${label}: ${relayFailureHint(e)}`)
    }
  }
  let size: number
  try {
    // stat 而非 readFile:大文件走流式上传,这里只需要体积(给超时保险丝定值)。
    const stat = await fs.stat(trimmed)
    if (!stat.isFile()) throw new Error('not a regular file')
    size = stat.size
  } catch {
    throw new Error(`${label}: cannot read local file "${trimmed}" — pass an existing path, data: URL, or https URL.`)
  }
  const mime = MIME_BY_EXT[path.extname(trimmed).toLowerCase()] ?? 'application/octet-stream'
  if (size <= MAX_INLINE_FILE_BYTES) {
    return `data:${mime};base64,${(await fs.readFile(trimmed)).toString('base64')}`
  }
  try {
    return await relayFileToCos(trimmed, mime, { fileSize: size })
  } catch (e) {
    throw new Error(`${label}: ${(size / 1024 / 1024).toFixed(1)}MB 素材 ${relayFailureHint(e)}`)
  }
}

/**
 * 中转失败的用户可读说明。关键是**带上真实原因** —— COS SDK 抛的是裸对象,
 * 早先这里用 `String(e)` 渲出来就是一句 `[object Object]`,既看不出是票据问题
 * 还是网断了,也没法据此做任何事(mediaRelay 已经把它收敛成真 Error,这里再
 * 兜一层防止别的调用路径漏进来)。
 */
function relayFailureHint(e: unknown): string {
  const reason = e instanceof Error ? e.message : describeCosError(e)
  return `上传到中转服务器失败(${reason})。已自动重试仍未成功,请检查网络后重新生成;若持续失败,可改用 https 链接或人像库素材(asset://)。`
}

/** 从扩展名 / mime / data: 头推断素材 kind(供 add_to_portrait_library 自动判断)。 */
function inferAssetKind(src: string, explicit?: string): 'image' | 'video' | 'audio' {
  if (explicit === 'image' || explicit === 'video' || explicit === 'audio') return explicit
  const probe = (/^data:([^;,]+)/i.exec(src.trim())?.[1] ?? src).toLowerCase()
  if (/video|\.(mp4|mov|webm|m4v|ogv)(?:[?#]|$)/.test(probe)) return 'video'
  if (/audio|\.(mp3|wav|m4a|aac|ogg|flac)(?:[?#]|$)/.test(probe)) return 'audio'
  return 'image'
}

interface EnrichedAsset {
  assetId: string
  assetUrl: string
  name: string
  kind: string
  sourceUrl?: string
  group?: string
  hidden: boolean
}

/**
 * 给素材附加叠加层信息(自定义名 / 分组 / 隐藏),供 list 工具返回给 agent。
 * 传入 overlay 快照(而非每项重读),保证一次 list 内一致且省开销;字段保持
 * 精简(codex 默认把工具输出截断到 ~10K tokens,冗余字段会挤掉真正有用的项)。
 */
function enrichWithOverlay(asset: SeedanceAssetItem, overlay: PortraitOverlayState): EnrichedAsset {
  const ov = overlay.entries[asset.assetId]
  return {
    assetId: asset.assetId,
    assetUrl: asset.assetUrl,
    name: ov?.name || asset.name,
    kind: String(asset.kind),
    sourceUrl: asset.sourceUrl,
    group: ov?.group,
    hidden: !!ov?.hidden,
  }
}

/**
 * 视频生成的图片素材默认先导入素材库（人像分类 image_people），再以
 * `asset://assetId` 引用创建任务 —— 上游按内容 hash 去重，同图复用同一
 * assetId，保证人像一致性，且人像库页面能看到所有用过的参考图。
 * 未配置 API Secret 或导入失败时回退为原 data:/https 直传，不阻塞生成。
 */
async function importImagesToPortraitLibrary(content: SeedanceContentItem[]): Promise<void> {
  const apiKey = getSeedanceApiKey()
  const apiSecret = getSeedanceApiSecret()
  if (!apiKey || !apiSecret) return
  for (const item of content) {
    if (item.type !== 'image_url') continue
    let url = item.image_url.url
    if (url.startsWith('asset://')) continue
    try {
      const mime = /^data:([^;,]+)/i.exec(url)?.[1]
      // 上游素材接口对 url 长度有硬限制(`400 url is too long`),data: 一律
      // 先走 COS 中转(历史图片上传链路)换 https URL,再转存到素材库。
      if (url.startsWith('data:')) {
        url = await relayDataUrlToCos(url)
        item.image_url.url = url
      }
      const { asset, referenceable } = await importSeedanceAsset(
        {
          kind: 'image',
          imageCategory: 'image_people',
          url,
          name: `视频参考-${item.role ?? 'reference_image'}-${Date.now()}`,
          ...(mime ? { mimeType: mime } : {}),
        },
        { apiKey, apiSecret },
      )
      // 上游导入有时只回不可引用的内部行 id(dla-xxx)且 list 也解析不出真
      // assetId——此时**保留 https 直传**(COS 中转地址照样能生成),只把素材
      // 留在人像库供展示;硬换成 asset://dla-xxx 会被创建任务 400 拒掉。
      if (referenceable !== false) {
        item.image_url.url = asset.assetUrl
        item.assetId = asset.assetId
      } else {
        console.warn(
          `[seedance] 导入素材未解析出可引用 assetId(${asset.assetId}),该图保留 URL 直传`,
        )
      }
    } catch (e) {
      console.warn('[seedance] portrait-library import failed, falling back to direct URL:', e)
    }
  }
}

async function buildContent(input: CreateVideoTaskInput): Promise<SeedanceContentItem[]> {
  const content: SeedanceContentItem[] = [
    { type: 'text', text: normalizeSeedancePromptReferences(input.prompt) },
  ]
  if (input.firstFrame) {
    content.push({ type: 'image_url', role: 'first_frame', image_url: { url: await resolveMediaUrl(input.firstFrame, 'firstFrame') } })
  }
  if (input.lastFrame) {
    content.push({ type: 'image_url', role: 'last_frame', image_url: { url: await resolveMediaUrl(input.lastFrame, 'lastFrame') } })
  }
  for (const [i, ref] of (input.referenceImages ?? []).entries()) {
    content.push({ type: 'image_url', role: 'reference_image', image_url: { url: await resolveMediaUrl(ref, `referenceImages[${i}]`) } })
  }
  // 全能参考 / 视频编辑 / 视频延长：视频、音频均可多条（单数字段并入数组，向后兼容）。
  // ⚠️ SDK 文档要求参考视频/音频必须带 reference_video / reference_audio role
  // （多模态参考、编辑视频、延长视频示例均如此）——漏掉会被当成非参考内容处理。
  const refVideos = [...(input.referenceVideos ?? []), ...(input.referenceVideo ? [input.referenceVideo] : [])]
  for (const [i, ref] of refVideos.entries()) {
    content.push({ type: 'video_url', role: 'reference_video', video_url: { url: await resolveMediaUrl(ref, `referenceVideos[${i}]`) } })
  }
  const refAudios = [...(input.referenceAudios ?? []), ...(input.referenceAudio ? [input.referenceAudio] : [])]
  for (const [i, ref] of refAudios.entries()) {
    content.push({ type: 'audio_url', role: 'reference_audio', audio_url: { url: await resolveMediaUrl(ref, `referenceAudios[${i}]`) } })
  }
  return content
}

export interface SeedanceRuntime {
  taskManager: SeedanceTaskManager
  dispose: () => void
}

/**
 * 注册「渲染端面向」的 Seedance IPC —— 人像库的 配置 / 素材 / 叠加层。
 *
 * 这些 handler 只依赖独立的 credentials / assets / overlay 模块,**不依赖** MCP
 * router 或 TaskManager,因此必须在窗口开始加载**之前**注册。否则人像库页面
 * 挂载时的 `getConfig()` / `listAssets()` 会与延迟执行的 `initSeedanceRuntime()`
 * (它要等 `await startCatimationMcpServer` 之后才跑)发生竞态,以
 * "No handler registered for 'seedance:get-config'" reject,页面随即被钉死在
 * 「人像库未就绪」,只能整页刷新才恢复。与 index.ts 里 agent IPC「在
 * createWindow 之前注册」的处理同理。
 *
 * 返回一个 disposer,用于解除 overlay 变更广播订阅。
 */
export function registerSeedanceRendererIpc(getWindow: () => BrowserWindow | null): () => void {
  // ============ 设置(API Key / Secret) ============
  ipcMain.removeHandler('seedance:get-config')
  ipcMain.handle('seedance:get-config', () => getSeedanceKeyState())
  ipcMain.removeHandler('seedance:set-config')
  ipcMain.handle(
    'seedance:set-config',
    (
      _event,
      args: { apiKey?: unknown; apiSecret?: unknown; region?: unknown },
    ) => {
      const region =
        args?.region === 'global' || args?.region === 'cn' ? args.region : undefined
      try {
        setSeedanceCredentials({
          apiKey: typeof args?.apiKey === 'string' ? args.apiKey : undefined,
          apiSecret: typeof args?.apiSecret === 'string' ? args.apiSecret : undefined,
          region,
        })
      } catch (e) {
        // 防御：写入失败（fs/safeStorage 异常等）不让渲染端只看到笼统的
        // 「接口不可用」——细节进主进程日志，仍返回当前 keyState 供 UI 对账。
        console.error('[seedance] set-config failed:', e)
      }
      const state = getSeedanceKeyState()
      // 配置（尤其站点 region）可能同时被设置页和「生成视频」工作台修改——
      // 两边各自缓存 keyState 会漂移。广播变更让所有已挂载的消费者即时对齐
      // （工作台页 mount-once 只切 display,不会靠 remount 重新拉取）。
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        try {
          win.webContents.send('seedance:config-changed', state)
        } catch (e) {
          console.warn('[seedance] config-changed broadcast failed:', e)
        }
      }
      return state
    },
  )

  // ============ 素材库（人像库） ============
  const assetCreds = () => ({ apiKey: getSeedanceApiKey(), apiSecret: getSeedanceApiSecret() })
  ipcMain.removeHandler('seedance:assets-list')
  ipcMain.handle('seedance:assets-list', (_event, query: SeedanceAssetListQuery) =>
    listSeedanceAssets(query ?? {}, assetCreds()),
  )
  ipcMain.removeHandler('seedance:assets-import')
  ipcMain.handle('seedance:assets-import', async (_event, input: SeedanceAssetImportInput) => {
    // 人像库页面上传的两条来源:
    // - data: URL(剪贴板/网页拖拽的合成 File)先中转 COS 拿 https URL,避开上游
    //   `url is too long` 限制,同时比直传 base64 快得多;
    // - 本地路径(系统拖拽/文件选择器,渲染端优先传这个)走 resolveMediaUrl,
    //   即分片流式上传 —— 整个文件不进 Buffer,所以不需要体积闸门。
    const raw = input?.url ?? ''
    const url = !raw
      ? raw // 让 importSeedanceAsset 出它自己那句「缺 url」,别在这儿变成读文件失败
      : raw.startsWith('data:')
        ? await relayDataUrlToCos(raw)
        : /^(https?:|asset:)/i.test(raw)
          ? raw
          : await resolveMediaUrl(raw, 'assets-import.url')
    return importSeedanceAsset({ ...input, url }, assetCreds())
  })
  ipcMain.removeHandler('seedance:assets-capacity')
  ipcMain.handle('seedance:assets-capacity', () => getSeedanceAssetCapacity(assetCreds()))
  ipcMain.removeHandler('seedance:assets-delete')
  ipcMain.handle('seedance:assets-delete', (_event, args: { assetIds?: unknown }) => {
    const ids = Array.isArray(args?.assetIds)
      ? args.assetIds.filter((x): x is string => typeof x === 'string')
      : []
    return deleteSeedanceAssets(ids, assetCreds())
  })
  // 官方素材库（文档 5,只读):工作台素材选择器的「官方素材/虚拟人像」tab。
  ipcMain.removeHandler('seedance:official-materials')
  ipcMain.handle('seedance:official-materials', (_event, query: SeedanceOfficialMaterialsQuery) =>
    listSeedanceOfficialMaterials(query ?? {}, assetCreds()),
  )

  // ============ 叠加层(改名/分组/隐藏)IPC + 广播 ============
  // 主进程是单一真相源:渲染端 UI 与 MCP agent 共享同一份。任何变更都广播给
  // 渲染端,使人像库页面实时反映 agent 的编辑。
  ipcMain.removeHandler('seedance:overlay-get')
  ipcMain.handle('seedance:overlay-get', () => getPortraitOverlay())
  ipcMain.removeHandler('seedance:overlay-mutate')
  ipcMain.handle('seedance:overlay-mutate', (_event, mutation: PortraitOverlayMutation) =>
    mutatePortraitOverlay(mutation),
  )
  const unsubscribeOverlay = onPortraitOverlayChange((state) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send('seedance:overlay-changed', state)
      } catch (e) {
        console.warn('[seedance/overlay] broadcast failed:', e)
      }
    }
  })

  return () => unsubscribeOverlay()
}

export function initSeedanceRuntime(opts: {
  router: ToolRouter
  attachments: AttachmentService
  getWindow: () => BrowserWindow | null
}): SeedanceRuntime {
  const { router, attachments, getWindow } = opts

  const taskManager = new SeedanceTaskManager({
    client: seedanceClient,
    getApiKey: getSeedanceApiKey,
    broadcast: (update) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        try {
          win.webContents.send('seedance:task-update', update)
        } catch (e) {
          console.warn('[seedance] broadcast failed:', e)
        }
      }
    },
    persistVideo: async (task) => {
      const buf = await seedanceClient.downloadVideo(task.videoUrl!)
      const name = `seedance-${task.model.replace('.', '_')}-${task.taskId.slice(-8)}.mp4`
      const [saved] = await attachments.ingest(task.threadId ?? FALLBACK_THREAD_ID, [
        {
          name,
          mime: 'video/mp4',
          size: buf.byteLength,
          buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
        },
      ])
      if (!saved) throw new Error('seedance persist: attachment ingest produced no file')
      // 转存到历史桶（COS）拿永久 https URL —— 聊天气泡 / 历史记录用它做持久
      // 来源,重启后不会因上游代理地址过期或本地文件清理而丢失。上传失败不致命:
      // 本地 mp4 仍在,降级用 file:// 路径。
      let remoteUrl: string | undefined
      try {
        remoteUrl = await relayBufferToCos(buf, 'video/mp4')
      } catch (e) {
        console.warn('[seedance] video COS upload failed, falling back to local path:', e)
      }
      return { localPath: saved.localPath, remoteUrl }
    },
  })

  router.registerMain('generate_video', async (params, threadId) => {
    const input = params as unknown as CreateVideoTaskInput
    // 关键：在任何 COS 中转 / 人像库导入 / createTask 之前，先广播一张「准备中」
    // 卡片。批量并发时每条任务都能瞬间出气泡，不再被前置大图上传压住（根因修复）。
    const clientId = taskManager.announcePreparing({ input, threadId })
    try {
      const content = await buildContent(input)
      await importImagesToPortraitLibrary(content)
      // 提交前防线:asset:// 引用在当前站点必须真实存在(素材按「海外/国内」
      // 站点隔离,导入后切站点必然 NOT_FOUND)——确认缺失时用中文报错拦下。
      await verifyContentAssetReferences(content, {
        apiKey: getSeedanceApiKey(),
        apiSecret: getSeedanceApiSecret(),
      })
      return await taskManager.submit({ input, content, threadId, clientId })
    } catch (e) {
      // 前置阶段（素材解析/导入/createTask，如 LOCAL_ASSET_IMPORT_FAILED）抛错时，
      // 把预备卡片落成 failed，避免气泡永远转圈；随后照旧把错误抛给工具层出横幅。
      // 上游裸错误(如 400 LOCAL_ASSET_NOT_FOUND)先翻译成人话再透出。
      const raw = e instanceof Error ? e.message : String(e)
      const message = translateSeedanceTaskError(raw)
      taskManager.announceFailed({ clientId, input, threadId, error: message })
      throw message === raw && e instanceof Error ? e : new Error(message)
    }
  })

  // ============ 「生成视频」工作台提交通道 ============
  // 与 generate_video 完全同一条生成链路（buildContent → 人像库导入 → 提交 →
  // 后台轮询 → persistVideo 本地落盘 + COS 转存），差异仅两点：
  // 1. clientId 由渲染端生成并透传 —— 广播先于 invoke 返回到达也能对齐卡片；
  // 2. source: 'workbench' —— SeedanceTaskListener 据此跳过聊天气泡，
  //    进度由工作台页自己消费 `seedance:task-update`。
  // 失败直接把错误带回渲染端（卡片落 failed），不走 announce* 合成广播。
  ipcMain.removeHandler('video-workbench:submit')
  ipcMain.handle('video-workbench:submit', async (_event, payload: Record<string, unknown>) => {
    const clientId = String(payload?.clientId ?? '')
    const asStringArray = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
    const seedRaw = Number(payload?.seed)
    const durationRaw = Number(payload?.duration)
    const input: CreateVideoTaskInput = {
      prompt: String(payload?.prompt ?? ''),
      model:
        payload?.model === '2.0-fast' || payload?.model === '2.0-mini' ? payload.model : '2.0',
      resolution: (['480p', '720p', '1080p'] as const).find((r) => r === payload?.resolution) ?? '720p',
      ratio: typeof payload?.ratio === 'string' ? payload.ratio : '16:9',
      // -1 = 智能时长(文档 8.1:模型自动决定输出时长);其余收敛到 4–15。
      duration: !Number.isFinite(durationRaw)
        ? 5
        : durationRaw === -1
          ? -1
          : Math.min(15, Math.max(4, Math.round(durationRaw))),
      generateAudio: payload?.generateAudio !== false,
      // 首帧/尾帧(图生视频/首尾帧模式)与 seed/联网:工作台新增,缺省不出现。
      ...(typeof payload?.firstFrame === 'string' && payload.firstFrame ? { firstFrame: payload.firstFrame } : {}),
      ...(typeof payload?.lastFrame === 'string' && payload.lastFrame ? { lastFrame: payload.lastFrame } : {}),
      ...(Number.isFinite(seedRaw) && seedRaw >= 0 ? { seed: Math.round(seedRaw) } : {}),
      ...(payload?.webSearch === true ? { webSearch: true } : {}),
      referenceImages: asStringArray(payload?.referenceImages),
      referenceVideos: asStringArray(payload?.referenceVideos),
      referenceAudios: asStringArray(payload?.referenceAudios),
    }
    try {
      if (!input.prompt.trim()) throw new Error('提示词不能为空')
      const content = await buildContent(input)
      await importImagesToPortraitLibrary(content)
      // 提交前防线:asset:// 引用在当前站点必须真实存在(素材按「海外/国内」
      // 站点隔离,导入后切站点必然 NOT_FOUND)——确认缺失时用中文报错拦下。
      await verifyContentAssetReferences(content, {
        apiKey: getSeedanceApiKey(),
        apiSecret: getSeedanceApiSecret(),
      })
      const state = await taskManager.submit({
        input,
        content,
        source: 'workbench',
        ...(clientId ? { clientId } : {}),
      })
      return { success: true, taskId: state.taskId }
    } catch (e) {
      // 上游裸错误(如 400 LOCAL_ASSET_NOT_FOUND)翻译成人话再回渲染端卡片。
      return {
        success: false,
        error: translateSeedanceTaskError(e instanceof Error ? e.message : String(e)),
      }
    }
  })

  // 取消。计费语义由 taskManager 按上游分档判定并原样带回渲染端（billed），
  // 卡片按钮据此显示「取消」还是「放弃结果（仍会计费）」。
  ipcMain.removeHandler('video-workbench:cancel')
  ipcMain.handle('video-workbench:cancel', async (_event, taskId: unknown) => {
    const id = String(taskId ?? '')
    if (!id) return { ok: false, billed: false, reason: '缺少 taskId' }
    return taskManager.cancel(id)
  })

  // 重启对账。任务表是纯内存的，应用重启后就空了，但上游任务还在跑 —— 工作台
  // 卡片（IndexedDB 持久化）启动时把进行中的 taskId 送回来重新接管，结果照旧
  // 走 persistVideo + 广播的正常回流路径（含写历史）。
  //
  // 接管前先探一次上游：taskId 可能早已过期/被删，此时直接告诉渲染端「查不到」，
  // 免得卡片又靠 pollLoop 的重试熬满 30 分钟才落 failed。判定逻辑见 adoption.ts
  // （暂时性失败不算「任务没了」，否则会错杀还在跑、已付费的任务）。
  ipcMain.removeHandler('video-workbench:reconcile')
  ipcMain.handle('video-workbench:reconcile', async (_event, rawItems: unknown) =>
    reconcileInFlightTasks(Array.isArray(rawItems) ? rawItems : [], {
      isTracked: (taskId) => Boolean(taskManager.get(taskId)),
      probe: (taskId) => seedanceClient.queryTask(taskId, getSeedanceApiKey()),
      adopt: (params) => { taskManager.adopt(params) },
      translateError: translateSeedanceTaskError,
    }),
  )

  router.registerMain('check_video_task', async (params) => {
    const taskId = String((params as { taskId?: unknown }).taskId ?? '')
    // 可选短轮询窗口：generate_video 在「已成功、落盘仍在跑」时用它做几秒的
    // 短等待，慢落盘绝不把回包拖到 25s（坑 3：bookkeeping 不配阻塞）。
    const rawPoll = Number((params as { pollMs?: unknown }).pollMs)
    const pollMs = Number.isFinite(rawPoll) && rawPoll > 0 ? Math.min(rawPoll, CHECK_LONG_POLL_MS) : CHECK_LONG_POLL_MS
    const task = await taskManager.waitForChange(taskId, pollMs)
    return task ? { found: true, task } : { found: false }
  })

  // 素材库（人像库）凭证 —— MCP 工具(list/add/download/edit_portrait_library)用它取
  // Key/Secret。渲染端面向的 IPC(seedance:get-config / set-config / assets-* /
  // overlay-*)已改为在窗口加载前由 `registerSeedanceRendererIpc()` 注册(见上),
  // 避免人像库页面挂载时调用比本函数(要等 `await startCatimationMcpServer` 之后
  // 才执行)更早而 reject,把页面永久钉死在「人像库未就绪」。
  const assetCreds = () => ({ apiKey: getSeedanceApiKey(), apiSecret: getSeedanceApiSecret() })

  // ============ MCP agent 人像库工具(自主上传/搜索/整理/下载) ============
  /** 把素材源(本地路径/data:/http/asset:)上传到人像库。 */
  async function addAsset(params: {
    source: string
    kind?: string
    name?: string
    imageCategory?: 'image_people' | 'image_environment'
  }): Promise<{ duplicated: boolean; assetId: string; assetUrl: string; name: string; kind: string }> {
    const source = String(params.source ?? '').trim()
    if (!source) throw new Error('add_to_portrait_library: source is required (local path / data: URL / https URL).')
    const kind = inferAssetKind(source, params.kind)
    const url = await resolveMediaUrl(source, 'add_to_portrait_library.source')
    const mime = /^data:([^;,]+)/i.exec(url)?.[1]
    const { duplicated, asset } = await importSeedanceAsset(
      {
        kind,
        url,
        ...(params.name ? { name: params.name } : {}),
        ...(kind === 'image' ? { imageCategory: params.imageCategory ?? 'image_people' } : {}),
        ...(mime ? { mimeType: mime } : {}),
      },
      assetCreds(),
    )
    return { duplicated, assetId: asset.assetId, assetUrl: asset.assetUrl, name: asset.name, kind: String(asset.kind) }
  }

  /** 下载素材文件到本地(走附件落盘,返回本地路径)。 */
  async function downloadAsset(params: { url: string; name?: string }): Promise<{ localPath: string; name: string }> {
    const url = String(params.url ?? '').trim()
    if (!/^https?:/i.test(url)) {
      throw new Error('download_portrait_asset: url must be an http(s) source URL (use sourceUrl from list_portrait_library).')
    }
    // 超时必须 < codex 默认 tool_timeout_sec(60s),否则会被 codex 直接砍掉,
    // 表现为「没反应」;主动超时则能返回可读错误。同时设体积上限避免 OOM。
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 45_000)
    let res: Awaited<ReturnType<typeof net.fetch>>
    try {
      res = await net.fetch(url, { signal: ac.signal })
    } catch (e) {
      clearTimeout(timer)
      if (ac.signal.aborted) {
        throw new Error('download_portrait_asset: download timed out after 45s — file too large or network too slow.')
      }
      throw e
    }
    if (!res.ok) {
      clearTimeout(timer)
      throw new Error(`download_portrait_asset: fetch failed ${res.status}`)
    }
    const declared = Number(res.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      clearTimeout(timer)
      throw new Error(
        `download_portrait_asset: file is ${(declared / 1024 / 1024).toFixed(0)}MB — exceeds ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB cap.`,
      )
    }
    let arr: ArrayBuffer
    try {
      arr = await res.arrayBuffer()
    } finally {
      clearTimeout(timer)
    }
    if (arr.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(
        `download_portrait_asset: file is ${(arr.byteLength / 1024 / 1024).toFixed(0)}MB — exceeds ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB cap.`,
      )
    }
    const buf = Buffer.from(arr)
    const ext = path.extname(new URL(url).pathname) || '.bin'
    const mime =
      res.headers.get('content-type')?.split(';')[0] ?? MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream'
    const name = params.name?.trim() || `portrait-${Date.now()}${ext}`
    const [saved] = await attachments.ingest(FALLBACK_THREAD_ID, [
      { name, mime, size: buf.byteLength, buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer },
    ])
    if (!saved) throw new Error('download_portrait_asset: attachment ingest produced no file')
    return { localPath: saved.localPath, name }
  }

  router.registerMain('list_portrait_library', async (params) => {
    const p = params as {
      query?: string
      kind?: string
      group?: string
      page?: number
      pageSize?: number
      includeHidden?: boolean
    }
    const page = p.page && p.page > 0 ? p.page : 1
    const pageSize = p.pageSize && p.pageSize > 0 ? Math.min(p.pageSize, 50) : 12
    const overlay = getPortraitOverlay()
    const baseQuery = {
      ...(p.query ? { q: p.query } : {}),
      ...(p.kind ? { kind: p.kind as SeedanceAssetKindFilter } : {}),
    }

    // 分组是「本地叠加层」元数据,上游素材接口不认识它 —— 不能把分页委托给
    // 上游(上游分页只会返回某一页全部素材,本地再筛分组就会漏掉其它页里的
    // 同组素材)。所以 group 筛选走有界扫描:从叠加层先拿到该组的目标 assetId
    // 集合(为空直接返回),再扫上游若干页凑齐这些 id 的详情,然后本地分页。
    // 扫描设页数上限 + 时间预算(< codex 60s 工具超时),凑齐即停。
    if (p.group) {
      const targetIds = new Set(
        Object.keys(overlay.entries).filter((id) => overlay.entries[id]?.group === p.group),
      )
      if (targetIds.size === 0) {
        return { items: [], total: 0, page: 1, totalPages: 1, hasMore: false, groups: overlay.groups }
      }
      const SCAN_PAGE_SIZE = 50
      const MAX_SCAN_PAGES = 30
      const deadline = Date.now() + 40_000
      const matched: SeedanceAssetItem[] = []
      const seen = new Set<string>()
      let scanCapped = false
      for (let pg = 1; pg <= MAX_SCAN_PAGES; pg++) {
        const res = await listSeedanceAssets({ page: pg, pageSize: SCAN_PAGE_SIZE, ...baseQuery }, assetCreds())
        for (const it of res.items) {
          if (targetIds.has(it.assetId) && !seen.has(it.assetId)) {
            seen.add(it.assetId)
            matched.push(it)
          }
        }
        if (seen.size >= targetIds.size) break
        if (pg >= (res.totalPages || 1)) break
        if (pg >= MAX_SCAN_PAGES || Date.now() > deadline) {
          scanCapped = true
          break
        }
      }
      let enriched = matched.map((a) => enrichWithOverlay(a, overlay))
      if (!p.includeHidden) enriched = enriched.filter((it) => !it.hidden)
      const total = enriched.length
      const totalPages = Math.max(1, Math.ceil(total / pageSize))
      const safePage = Math.min(page, totalPages)
      const start = (safePage - 1) * pageSize
      return {
        items: enriched.slice(start, start + pageSize),
        total,
        page: safePage,
        totalPages,
        hasMore: safePage < totalPages,
        scanCapped,
        groups: overlay.groups,
      }
    }

    // 常见路径(无分组筛选):直接信任上游分页,仅在本页过滤隐藏(软删项极少,
    // 计数略有偏差可接受,换取大库下每次只取一页的低开销)。
    const result = await listSeedanceAssets({ page, pageSize, ...baseQuery }, assetCreds())
    let enriched = result.items.map((a) => enrichWithOverlay(a, overlay))
    if (!p.includeHidden) enriched = enriched.filter((it) => !it.hidden)
    return {
      items: enriched,
      total: result.total,
      page: result.page,
      totalPages: result.totalPages,
      hasMore: result.page < result.totalPages,
      groups: overlay.groups,
    }
  })

  router.registerMain('add_to_portrait_library', (params) =>
    addAsset(params as Parameters<typeof addAsset>[0]),
  )

  router.registerMain('download_portrait_asset', (params) =>
    downloadAsset(params as Parameters<typeof downloadAsset>[0]),
  )

  router.registerMain('edit_portrait_library', async (params) => {
    const p = params as {
      action: 'rename' | 'move_group' | 'hide' | 'unhide' | 'new_group' | 'delete_group'
      assetId?: string
      assetIds?: string[]
      name?: string
      group?: string
    }
    const ids = p.assetIds ?? (p.assetId ? [p.assetId] : [])
    let mutation: PortraitOverlayMutation
    switch (p.action) {
      case 'rename':
        if (!p.assetId) throw new Error('edit_portrait_library rename: assetId is required.')
        mutation = { op: 'rename', assetId: p.assetId, name: p.name ?? '' }
        break
      case 'move_group':
        if (ids.length === 0) throw new Error('edit_portrait_library move_group: assetId(s) required.')
        mutation = { op: 'moveToGroup', assetIds: ids, group: p.group }
        break
      case 'hide':
        if (ids.length === 0) throw new Error('edit_portrait_library hide: assetId(s) required.')
        mutation = { op: 'setHidden', assetIds: ids, hidden: true }
        break
      case 'unhide':
        if (ids.length === 0) throw new Error('edit_portrait_library unhide: assetId(s) required.')
        mutation = { op: 'setHidden', assetIds: ids, hidden: false }
        break
      case 'new_group':
        if (!p.group) throw new Error('edit_portrait_library new_group: group name is required.')
        mutation = { op: 'addGroup', name: p.group }
        break
      case 'delete_group':
        if (!p.group) throw new Error('edit_portrait_library delete_group: group name is required.')
        mutation = { op: 'removeGroup', name: p.group }
        break
      default: {
        const _exhaustive: never = p.action
        throw new Error(`edit_portrait_library: unknown action ${String(_exhaustive)}`)
      }
    }
    const state = mutatePortraitOverlay(mutation)
    return { ok: true, action: p.action, affected: ids.length, groups: state.groups }
  })

  return {
    taskManager,
    dispose: () => {
      taskManager.dispose()
    },
  }
}

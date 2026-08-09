// Seedance 运行时接线：TaskManager 单例 + ToolRouter main handler + 设置 IPC。
// 由 index.ts 在 MCP runtime 就绪后调用一次。

import { app, ipcMain, net, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ToolRouter } from '../../mcp/ToolRouter'
import { MAX_PATH_ATTACHMENT_BYTES, type AttachmentService } from '../../agent/AttachmentService'
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
  withLocalThumbs,
} from './assets'
import {
  getPortraitOverlay,
  mutatePortraitOverlay,
  onPortraitOverlayChange,
} from './portraitOverlay'
import { normalizeSeedancePromptReferences } from './promptReferences'
import { SeedanceTaskManager } from './taskManager'
import { relayDataUrlToCos, relayFileToCos } from '../tencent/mediaRelay'
import { MIME_BY_EXT, resolveMediaUrl } from './mediaResolve'
import { cleanupOrphanParts } from './videoDownload'
import type {
  CreateVideoTaskInput,
  SeedanceContentItem,
  SeedanceModelAlias,
  SeedanceTaskMode,
} from './types'
import { capabilitiesFor, isSeedanceModelAvailable } from './types'
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
 * download_portrait_asset 的自定超时。必须 < codex 默认 tool_timeout_sec(60s),
 * 否则会被 codex 直接砍掉、表现为「没反应」;自己收口才能给出可读错误。
 * 这条时间预算才是这个工具真正的约束 —— 体积不是。
 */
const DOWNLOAD_DEADLINE_MS = 45_000

/** 无 threadId 的任务(手动 MCP 调用等)落到这个伪线程目录。 */
const FALLBACK_THREAD_ID = 'seedance'

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
 * 把本次用到的图片素材登记进人像库（人像分类 image_people），供后续复用与浏览。
 * 上游按内容 hash 去重，同图始终落到同一条记录。
 *
 * **在任务提交之后后台跑,不进提交关键路径**。理由是上游导入是异步的:返回那刻
 * 只有内部行 id、`status: 'pending'`,真 assetId 要等处理完成(实测数秒)才有 ——
 * 而生成本来就吃 https/data: 直传。让用户的卡片停在「准备中」等这串往返,等到的
 * 只是同一次生成,纯亏。
 *
 * 全程吞异常:这条链路只决定人像库里能不能看到这张图,不该影响生成成败。
 */
async function importImagesToPortraitLibrary(content: SeedanceContentItem[]): Promise<void> {
  const apiKey = getSeedanceApiKey()
  const apiSecret = getSeedanceApiSecret()
  if (!apiKey || !apiSecret) return
  const images = content.filter(
    (item): item is Extract<SeedanceContentItem, { type: 'image_url' }> =>
      item.type === 'image_url' && !item.image_url.url.startsWith('asset://'),
  )
  // 并发:参考图最多个位数,而串行会让每张图的 pending→ready 等待逐个累加。
  await Promise.all(
    images.map(async (item) => {
      try {
        const raw = item.image_url.url
        const mime = /^data:([^;,]+)/i.exec(raw)?.[1]
        // 上游素材接口对 url 长度有硬限制(`400 url is too long`),data: 一律
        // 先走 COS 中转(历史图片上传链路)换 https URL,再转存到素材库。
        const url = raw.startsWith('data:') ? await relayDataUrlToCos(raw) : raw
        const { asset } = await importSeedanceAsset(
          {
            kind: 'image',
            imageCategory: 'image_people',
            url,
            name: `视频参考-${item.role ?? 'reference_image'}-${Date.now()}`,
            ...(mime ? { mimeType: mime } : {}),
          },
          { apiKey, apiSecret },
        )
        rememberAssetThumb(asset, url)
      } catch (e) {
        console.warn('[seedance] portrait-library import failed (generation unaffected):', e)
      }
    }),
  )
}

/**
 * 记住素材的缩略图地址 —— 上游只对**带字节**导入(data: URL)生成 `previewUrl`;
 * 走远程 URL 导入的它不下载,`sizeBytes` 恒 0、`previewUrl` 恒 null(2026-08-03
 * 实测)。而 >512KB 必须走 COS(否则 `400 url is too long`),所以大图在人像库里
 * 只能靠这份我们自己传上去的地址显示。
 *
 * 行 id 与真 assetId 两个键都写:导入是异步的,返回那刻往往只有行 id,而列表里
 * 两者都在 —— 页面按哪个查都命中。data: 不入库(overlay 是明文 JSON,塞进去会
 * 把它撑成几 MB),那种情况上游本来就会给 previewUrl。
 */
function rememberAssetThumb(asset: SeedanceAssetItem, thumbUrl: string): void {
  if (!/^https?:/i.test(thumbUrl)) return
  const assetIds = [...new Set([asset.assetId, asset.id].filter((id): id is string => !!id))]
  if (assetIds.length === 0) return
  try {
    mutatePortraitOverlay({ op: 'setThumb', assetIds, thumbUrl })
  } catch (e) {
    console.warn('[seedance] 记录本地缩略图失败(不影响导入):', e)
  }
}

/**
 * 素材 → 可提交的 content[]。
 *
 * **顺序即编号,不可乱。** Seedance OpenAPI §2.3:「如果你在提示词中使用
 * `@参考N / @视频N / @音频N` 这类标签,请确保它们与 `content[]` 里的素材顺序
 * 一一对应」——「图片1」就是 content 里第一个 image_url,不是某个 ID。顺序错了
 * 上游照样受理,只是生成的内容跟用户想的不是一回事,不报任何错。
 *
 * 所以这里**先并发把 URL 收齐,再按输入次序拼数组**:`Promise.all` 的返回顺序
 * 等于入参顺序,与谁先完成无关。绝不能写成「谁 resolve 完就 push 谁」——那样
 * 数组顺序会变成完成顺序,一张 4MB 人物图配几张小场景图必然错位,而且网速一变
 * 顺序又变,同一张卡两次结果不同。回归测试见 `__tests__/buildContent.order.test.ts`。
 *
 * 并发的上限由 `mediaRelay` 的 4 槽全局闸兜底,这里不再自设。
 */
async function buildContent(input: CreateVideoTaskInput): Promise<SeedanceContentItem[]> {
  // 全能参考 / 视频编辑 / 视频延长：视频、音频均可多条（单数字段并入数组，向后兼容）。
  const refImages = input.referenceImages ?? []
  const refVideos = [...(input.referenceVideos ?? []), ...(input.referenceVideo ? [input.referenceVideo] : [])]
  const refAudios = [...(input.referenceAudios ?? []), ...(input.referenceAudio ? [input.referenceAudio] : [])]

  const [firstFrameUrl, lastFrameUrl, imageUrls, videoUrls, audioUrls] = await Promise.all([
    input.firstFrame ? resolveMediaUrl(input.firstFrame, 'firstFrame') : Promise.resolve(null),
    input.lastFrame ? resolveMediaUrl(input.lastFrame, 'lastFrame') : Promise.resolve(null),
    Promise.all(refImages.map((ref, i) => resolveMediaUrl(ref, `referenceImages[${i}]`))),
    Promise.all(refVideos.map((ref, i) => resolveMediaUrl(ref, `referenceVideos[${i}]`))),
    Promise.all(refAudios.map((ref, i) => resolveMediaUrl(ref, `referenceAudios[${i}]`))),
  ])

  const content: SeedanceContentItem[] = [
    { type: 'text', text: normalizeSeedancePromptReferences(input.prompt) },
  ]
  if (firstFrameUrl) {
    content.push({ type: 'image_url', role: 'first_frame', image_url: { url: firstFrameUrl } })
  }
  if (lastFrameUrl) {
    content.push({ type: 'image_url', role: 'last_frame', image_url: { url: lastFrameUrl } })
  }
  for (const url of imageUrls) {
    content.push({ type: 'image_url', role: 'reference_image', image_url: { url } })
  }
  // ⚠️ SDK 文档要求参考视频/音频必须带 reference_video / reference_audio role
  // （多模态参考、编辑视频、延长视频示例均如此）——漏掉会被当成非参考内容处理。
  for (const url of videoUrls) {
    content.push({ type: 'video_url', role: 'reference_video', video_url: { url } })
  }
  for (const url of audioUrls) {
    content.push({ type: 'audio_url', role: 'reference_audio', audio_url: { url } })
  }
  return content
}

/** Exposed for tests only — 顺序不变量的回归护栏需要直接调它。 */
export const __buildContentForTests = buildContent

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
  ipcMain.handle('seedance:assets-list', async (_event, query: SeedanceAssetListQuery) =>
    withLocalThumbs(
      await listSeedanceAssets(query ?? {}, assetCreds()),
      getPortraitOverlay().entries,
    ),
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
          : await resolveMediaUrl(raw, 'assets-import.url', input?.mimeType)
    const result = await importSeedanceAsset({ ...input, url }, assetCreds())
    // 走 COS 的(>512KB,即绝大多数图片)上游不会生成 previewUrl,自留一份地址
    // 当缩略图;内联 data: 的上游自己会给,rememberAssetThumb 内部已跳过。
    rememberAssetThumb(result.asset, url)
    return result
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

  // 清掉上次异常退出(崩溃 / 断电 / 进程被杀)留下的半截下载。失败不影响启动。
  void cleanupOrphanParts(path.join(app.getPath('userData'), 'agent', 'downloads')).then(
    (n) => {
      if (n > 0) console.log(`[seedance] 清理了 ${n} 个残留的 .part 下载文件`)
    },
    () => undefined,
  )

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
    persistVideo: (task) => persistVideoBytes(task),
  })

  /**
   * 把上游那条临时地址的字节抓下来:落本地 + 转存 COS。
   *
   * 抽成具名函数是为了能被**手动重试**复用(`video-workbench:repersist`)。
   * 自动重试有窗口上限(任务 30 分钟后从内存表清掉),而上游地址有效期一天 ——
   * 中间那段只能靠用户点一下。没有这条路,断网超过半小时视频就真的没了,
   * 而唯一的补救是花钱重生成。
   */
  async function persistVideoBytes(
    task: { videoUrl?: string; model: string; taskId: string; threadId?: string },
  ): Promise<{ localPath: string; remoteUrl?: string }> {
      const name = `seedance-${task.model.replace('.', '_')}-${task.taskId.slice(-8)}.mp4`
      const tmpDir = path.join(app.getPath('userData'), 'agent', 'downloads')
      await fs.mkdir(tmpDir, { recursive: true })
      const destPath = path.join(tmpDir, `${randomUUID()}-${name}`)

      const filePath = await seedanceClient.downloadVideo(task.videoUrl!, destPath)
      try {
        const { size } = await fs.stat(filePath)
        // 按 path 而非 buffer 交给 ingest。这不只是省内存 —— buffer 路径的上限是
        // 100MB(MAX_BUFFER_ATTACHMENT_BYTES),path 路径是 2GB。走 buffer 时任何
        // 超过 100MB 的视频都会 ingest 失败,本地和 COS 都留不下副本,只剩上游那条
        // 会过期的地址。
        const [saved] = await attachments.ingest(task.threadId ?? FALLBACK_THREAD_ID, [
          { name, mime: 'video/mp4', size, path: filePath },
        ])
        if (!saved) throw new Error('seedance persist: attachment ingest produced no file')

        // 转存到历史桶（COS）拿永久 https URL —— 聊天气泡 / 历史记录用它做持久
        // 来源,重启后不会因上游代理地址过期或本地文件清理而丢失。上传失败不致命:
        // 本地 mp4 仍在,降级用 file:// 路径。
        let remoteUrl: string | undefined
        try {
          remoteUrl = await relayFileToCos(filePath, 'video/mp4', { fileSize: size })
        } catch (e) {
          console.warn('[seedance] video COS upload failed, falling back to local path:', e)
        }
        return { localPath: saved.localPath, remoteUrl }
      } finally {
        // ingest 已经把内容拷进 attachments 目录,这份临时副本不必留。
        await fs.unlink(filePath).catch(() => undefined)
      }
  }

  /**
   * 手动「重新保存」。**不重新生成、不花钱** —— 只是拿卡片上还留着的那条上游
   * 地址(有效期约一天)再抓一次字节。
   *
   * 这是降级路径的最后一环:即时重试约 75 秒、后台重试到 21 分钟,再往后任务
   * 就从内存表清掉了,而地址还能用二十多个小时。断网超过半小时的情况只能靠这里。
   */
  ipcMain.removeHandler('video-workbench:repersist')
  ipcMain.handle('video-workbench:repersist', async (_event, payload: Record<string, unknown>) => {
    const videoUrl = typeof payload?.videoUrl === 'string' ? payload.videoUrl : ''
    if (!videoUrl) return { ok: false, error: '这张卡没有可用的视频地址，只能重新生成' }
    try {
      const { localPath, remoteUrl } = await persistVideoBytes({
        videoUrl,
        model: String(payload?.model ?? '2.0'),
        taskId: String(payload?.taskId ?? randomUUID()),
        threadId: typeof payload?.threadId === 'string' ? payload.threadId : undefined,
      })
      return { ok: true, localPath, remoteUrl }
    } catch (e) {
      // 失败原因如实带回:多半是地址已过期或仍然断网，两者的下一步不同
      // （前者只能重新生成，后者等一会儿再点一次就行）。
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  router.registerMain('generate_video', async (params, threadId) => {
    const input = params as unknown as CreateVideoTaskInput
    // 关键：在任何 COS 中转 / 人像库导入 / createTask 之前，先广播一张「准备中」
    // 卡片。批量并发时每条任务都能瞬间出气泡，不再被前置大图上传压住（根因修复）。
    const clientId = taskManager.announcePreparing({ input, threadId })
    try {
      const content = await buildContent(input)
      // 提交前防线:asset:// 引用在当前站点必须真实存在(素材按「海外/国内」
      // 站点隔离,导入后切站点必然 NOT_FOUND)——确认缺失时用中文报错拦下。
      await verifyContentAssetReferences(content, {
        apiKey: getSeedanceApiKey(),
        apiSecret: getSeedanceApiSecret(),
      })
      const state = await taskManager.submit({ input, content, threadId, clientId })
      void importImagesToPortraitLibrary(content)
      return state
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
    // 别名与时长/分辨率的收敛都必须**按模型**来 —— 2.5 能到 30 秒但只到 720p,
    // 写死 15 会把用户选的 30 秒悄悄夹成 15，成片比预期短一半还不报错。
    const model: SeedanceModelAlias = isSeedanceModelAvailable(payload?.model as SeedanceModelAlias)
      ? (payload.model as SeedanceModelAlias)
      : '2.0'
    const caps = capabilitiesFor(model)
    const taskMode: SeedanceTaskMode | undefined =
      (payload?.taskMode === 'edit' || payload?.taskMode === 'extend') &&
      caps.taskModes.includes(payload.taskMode)
        ? payload.taskMode
        : undefined
    const input: CreateVideoTaskInput = {
      prompt: String(payload?.prompt ?? ''),
      model,
      resolution:
        (caps.resolutions.find((r) => r === payload?.resolution) as
          | '480p'
          | '720p'
          | '1080p'
          | undefined) ?? '720p',
      ratio: typeof payload?.ratio === 'string' ? payload.ratio : '16:9',
      // -1 = 智能时长(文档 8.1:模型自动决定输出时长);其余按该模型的区间收敛。
      duration: !Number.isFinite(durationRaw)
        ? 5
        : durationRaw === -1
          ? -1
          : Math.min(caps.duration.max, Math.max(caps.duration.min, Math.round(durationRaw))),
      generateAudio: payload?.generateAudio !== false,
      ...(taskMode ? { taskMode } : {}),
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
      void importImagesToPortraitLibrary(content)
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

  /**
   * 下载素材文件到本地(走附件落盘,返回本地路径)。
   *
   * 分块落盘,整个文件不进内存 —— 与上传方向的 relayFileToCos 口径一致。写法照
   * AttachmentService.ingestOne:pipeline 到临时文件,失败就清掉(Windows 上
   * pipeline 不保证替你 unlink)。
   *
   * 这里**没有产品意义上的体积上限**:真正的约束是时间。本工具由 codex 调用,
   * 默认 tool_timeout_sec 是 60s,超了会被直接砍掉、表现为「没反应」,所以我们
   * 自己在 45s 主动收口并给出可读错误。剩下那个字节闸门只是与下游 AttachmentService
   * 的 path 上限对齐(它接不下就别白写一遍磁盘),不是我们另立的规矩。
   */
  async function downloadAsset(params: { url: string; name?: string }): Promise<{ localPath: string; name: string }> {
    const url = String(params.url ?? '').trim()
    if (!/^https?:/i.test(url)) {
      throw new Error('download_portrait_asset: url must be an http(s) source URL (use sourceUrl from list_portrait_library).')
    }
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), DOWNLOAD_DEADLINE_MS)
    const timedOut = (): Error =>
      new Error(
        `download_portrait_asset: download timed out after ${DOWNLOAD_DEADLINE_MS / 1000}s — file too large or network too slow.`,
      )
    let res: Awaited<ReturnType<typeof net.fetch>>
    try {
      res = await net.fetch(url, { signal: ac.signal })
    } catch (e) {
      clearTimeout(timer)
      if (ac.signal.aborted) throw timedOut()
      throw e
    }
    const tooBig = (bytes: number): Error =>
      new Error(
        `download_portrait_asset: file is ${(bytes / 1024 / 1024).toFixed(0)}MB — exceeds the ${MAX_PATH_ATTACHMENT_BYTES / 1024 / 1024 / 1024}GB local-attachment limit.`,
      )
    try {
      if (!res.ok) throw new Error(`download_portrait_asset: fetch failed ${res.status}`)
      const declared = Number(res.headers.get('content-length') ?? '')
      // 声明了体积就先否决,省下一次注定作废的下载。
      if (Number.isFinite(declared) && declared > MAX_PATH_ATTACHMENT_BYTES) throw tooBig(declared)
      if (!res.body) throw new Error('download_portrait_asset: response has no body')

      const ext = path.extname(new URL(url).pathname) || '.bin'
      const mime =
        res.headers.get('content-type')?.split(';')[0] ?? MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream'
      const name = params.name?.trim() || `portrait-${Date.now()}${ext}`

      const tmpDir = path.join(app.getPath('userData'), 'agent', 'downloads')
      await fs.mkdir(tmpDir, { recursive: true })
      const tmpPath = path.join(tmpDir, `_dl_${randomUUID()}${ext}`)

      let written = 0
      // 没有 content-length 时(chunked)边下边数,超了立刻中断,别把磁盘写满。
      const guard = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          written += chunk.byteLength
          if (written > MAX_PATH_ATTACHMENT_BYTES) {
            cb(tooBig(written))
            return
          }
          cb(null, chunk)
        },
      })
      try {
        await pipeline(Readable.fromWeb(res.body as never), guard, createWriteStream(tmpPath))
      } catch (e) {
        await fs.unlink(tmpPath).catch(() => undefined)
        if (ac.signal.aborted) throw timedOut()
        throw e
      }

      try {
        const [saved] = await attachments.ingest(FALLBACK_THREAD_ID, [
          { name, mime, size: written, path: tmpPath },
        ])
        if (!saved) throw new Error('download_portrait_asset: attachment ingest produced no file')
        return { localPath: saved.localPath, name }
      } finally {
        // ingest 会把内容按 hash 重新落到 uploads 目录,临时件留着只是垃圾。
        await fs.unlink(tmpPath).catch(() => undefined)
      }
    } finally {
      clearTimeout(timer)
    }
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

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
import { coerceVideoBillingSource, createVideoBillingResolver } from './billing'
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
import { persistVideoBytes, type PersistVideoDeps } from './persistVideo'
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
  VideoBillingSource,
} from './types'
import { capabilitiesFor, isSeedanceModelAvailable } from './types'
import type { VideoWorkbenchMode } from '../../../types/videoModes'
import { upstreamAcceptsInlineMedia, usesSeedanceAssetLibrary } from './assetLibraryPolicy'
import { gatewayPlatformHeaders, getActivePool, getActivePoolToken } from '../auth/gatewayToken'
import { resolveGatewayOrigin } from '../auth/gatewayHeaderInjector'
import { notePlatformSpend } from '../auth/platformSpend'
import { ensureAsset } from '../portraitLibrary/ensureAsset'
import { createWan3Client } from '../wan3/client'
import { getWan3ApiKey } from '../wan3/credentials'
import { createSeedanceGatewayClient } from '../seedanceGateway/client'
import { createSeedanceGatewayTokenResolver } from '../seedanceGateway/credentials'
import type { SeedanceGatewayTokenSources } from '../seedanceGateway/credentials'
import {
  createSeedanceGatewayTransport,
  createSeedanceTransport,
  createWan3Transport,
  transportFor,
} from '../videoTransport'
import { translateVideoTaskError } from '../videoTaskError'
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

/**
 * 网关视频的两枚候选凭据。**决策本身不在这里** —— 见
 * `seedanceGateway/credentials.ts`,那份文件解释了为什么不走
 * `gatewayHeaderInjector`、以及主进程这份 activePool 与渲染层状态之间的已知缺口。
 */
const gatewayTokenSources: SeedanceGatewayTokenSources = {
  platformToken: getActivePoolToken,
  ownKey: getWan3ApiKey,
}

/**
 * 这一次的钱从哪出。路由与取 token 共用这一个结论,理由见
 * `billing.ts` 的 `createVideoBillingResolver`。
 */
const resolveVideoBilling = createVideoBillingResolver(gatewayTokenSources)

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
 * 「默认上传人像库」总闸 —— 渲染端工具栏那个药丸的当前值。
 *
 * 真相源在渲染端(localStorage `vw-auto-import-portrait`),这里只是给**没有载荷
 * 可带**的那条路(agent 的 generate_video)留的一份镜像:渲染端在开关变化时和
 * store 初始化时各推一次。工作台自己的提交不读它,读 payload 里的字段 —— 那条
 * 路不该依赖「推送到没到」。
 *
 * 默认开(与渲染端一致):只影响**生成后兜底登记**,上传时不再顺带入库。
 */
let autoImportPortraitEnabled = true

export function setAutoImportPortraitEnabled(enabled: boolean): void {
  autoImportPortraitEnabled = enabled
}

/**
 * 把本次用到的图片素材登记进人像库（人像分类 image_people），供后续复用与浏览。
 * 上游按内容 hash 去重，同图始终落到同一条记录。
 *
 * **人像库入库唯一自动路径**(卡片上传不再顺带)。受「默认上传人像库」开关管:
 * 关着时整个函数直接返回。调用方传入开关值(工作台从提交载荷取、agent 路从
 * 上面那份镜像取);默认开。
 *
 * **在任务提交之后后台跑,不进提交关键路径**。理由是上游导入是异步的:返回那刻
 * 只有内部行 id、`status: 'pending'`,真 assetId 要等处理完成(实测数秒)才有 ——
 * 而生成本来就吃 https/data: 直传。让用户的卡片停在「准备中」等这串往返,等到的
 * 只是同一次生成,纯亏。
 *
 * 全程吞异常:这条链路只决定人像库里能不能看到这张图,不该影响生成成败。
 */
async function importImagesToPortraitLibrary(
  content: SeedanceContentItem[],
  enabled: boolean,
): Promise<void> {
  if (!enabled) return
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
 * 上面那条的**平台余额版**。同一件事,换一个库。
 *
 * 为什么必须有它:`usesSeedanceAssetLibrary` 在平台模式下返回 false,把
 * `verifyContentAssetReferences` 与 `importImagesToPortraitLibrary` **一起**关掉了。
 * 关前者是必须的(拿 vvdance 凭据去校验平台 asset id 会硬拦下整次提交);
 * 关后者是过度 —— 结果是平台用户生成用的参考图不会自动成为可复用的 `asset://`
 * 锚点,下次跨镜锁同一张脸得手动再传一次,而 vvdance 用户有这个自动化。
 *
 * 池取**主进程的 `activePool`**,不是渲染层递来的:提交用的 token 就来自它,
 * 两者不同源的话素材会登记进一个与计费池不同的组,而跨池的 asset 读不出来。
 * 完整论证见 `auth/gatewayToken.ts` 的 `getActivePool()`。
 *
 * 走 `ensureAsset` 而不是直接 `registerAsset`:前者自带同图同池去重(进程内 +
 * 落盘绑定),否则同一张脸出现在几个镜头里就会在上游留下几份真实副本 ——
 * 占配额、占列表分页预算,而配额只有显式 purge 才回收。
 *
 * 与上面那条一样全程吞异常、在提交之后后台跑。`ensureAsset` 等不到就绪时会抛
 * `ASSET_NOT_READY`,这里当没发生:登记本身已经落库了,只是还没 Active,
 * 下一次引用它时会自愈。
 */
async function importImagesToPlatformLibrary(
  content: SeedanceContentItem[],
  enabled: boolean,
): Promise<void> {
  if (!enabled) return
  const pool = getActivePool()
  if (!pool) return
  const scope = {
    projectId: pool.projectId,
    ...(pool.producerProjectId !== null ? { producerProjectId: pool.producerProjectId } : {}),
  }
  const images = content.filter(
    (item): item is Extract<SeedanceContentItem, { type: 'image_url' }> =>
      item.type === 'image_url' && !item.image_url.url.startsWith('asset://'),
  )
  await Promise.all(
    images.map(async (item) => {
      try {
        const raw = item.image_url.url
        // 平台库只收公网 URL(上游火山要能自己去拉),data: 一律先过 COS 换永久链。
        const url = raw.startsWith('data:') ? await relayDataUrlToCos(raw) : raw
        await ensureAsset(
          { url, name: `视频参考-${item.role ?? 'reference_image'}-${Date.now()}` },
          scope,
        )
      } catch (e) {
        console.warn('[seedance] platform-library import failed (generation unaffected):', e)
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

  // 万相只认公网 URL —— 必须跳过 ≤512KB 的内联捷径。
  //
  // 默认策略是小素材直接读成 base64 内联进 content[](见 mediaResolve 的
  // MAX_INLINE_FILE_BYTES,注释里明说「视频路径不传这个开关,保留内联线」)。
  // Seedance 吃这一套,DashScope 不吃:它只接受可下载的 https 地址。不开这个开关
  // 的后果很隐蔽 —— 大图正常、小图报错,而用户完全想不到是体积的问题。
  const mediaOptions = upstreamAcceptsInlineMedia(input.model) ? undefined : { alwaysRelay: true }

  const [firstFrameUrl, lastFrameUrl, imageUrls, videoUrls, audioUrls] = await Promise.all([
    input.firstFrame
      ? resolveMediaUrl(input.firstFrame, 'firstFrame', undefined, mediaOptions)
      : Promise.resolve(null),
    input.lastFrame
      ? resolveMediaUrl(input.lastFrame, 'lastFrame', undefined, mediaOptions)
      : Promise.resolve(null),
    Promise.all(refImages.map((ref, i) => resolveMediaUrl(ref, `referenceImages[${i}]`, undefined, mediaOptions))),
    Promise.all(refVideos.map((ref, i) => resolveMediaUrl(ref, `referenceVideos[${i}]`, undefined, mediaOptions))),
    Promise.all(refAudios.map((ref, i) => resolveMediaUrl(ref, `referenceAudios[${i}]`, undefined, mediaOptions))),
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
  // 「默认上传人像库」总闸的镜像推送。单向 send/on(Electron 的 Pattern 1)——
  // 渲染端只是告知,不等回执,没有值得 await 的返回。
  //
  // 注册在这里而不是 initSeedanceRuntime 里:渲染端 store 一初始化就推,那时
  // MCP server 还没起来,晚注册的话首推直接落空,开关状态要等用户手点一次才同步。
  ipcMain.removeAllListeners('video-workbench:set-auto-import-portrait')
  ipcMain.on('video-workbench:set-auto-import-portrait', (_event, enabled: unknown) => {
    setAutoImportPortraitEnabled(enabled === true)
  })

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

  // 万相那条路。fetch 在这里注入而不是由客户端默认取,是为了让 wan3/client.ts
  // 不必顶层 import electron —— 那会让它在 Electron 之外根本加载不了。
  const wan3Transport = createWan3Transport(
    createWan3Client({ fetchImpl: (url, init) => net.fetch(url, init as Parameters<typeof net.fetch>[1]) }),
    getWan3ApiKey,
  )

  /**
   * 平台余额下的 Seedance —— 与 vvdance 直连**平行**的第三条路。fetch 同样注入,
   * 理由与万相一致(顶层 import electron 会让客户端在 Electron 之外加载不了)。
   *
   * 取 token 的意向**钉死成 platform**:能走到这条 transport 就说明分派已经判定
   * 「这一次花平台余额」。再让它按「手上有什么用什么」兜底的话,影子 token 一旦
   * 恰好取不到就会静默换成用户自填的 Miau Key —— 那正是 credentials.ts 明令禁止
   * 的跨模式回落。钉死之后那种情况会在 requireApiKey 抛出「请先选择计费池」。
   */
  const seedanceGatewayTransport = createSeedanceGatewayTransport(
    createSeedanceGatewayClient({
      fetchImpl: (url, init) => net.fetch(url, init as Parameters<typeof net.fetch>[1]),
      // 与出网注入器**共用同一个** origin 解析(开发构建才认 `CATIMATION_GATEWAY_ORIGIN`,
      // 打包产物读都不读 —— 理由见 `gatewayHeaderInjector.resolveGatewayOrigin`)。
      //
      // 各写各的话会分叉成「注入器盯着 A、视频提交打到 B」:测试服签的影子 token
      // 发到生产网关一律 401,而错误里不会有任何一个字提到是地址配错了。
      // `MIAU_BASE_URL` 自带 `/v1`,这里的 origin 没有,所以要补上。
      baseUrl: `${resolveGatewayOrigin()}/v1`,
      // 整份组头。少了里面的归属那几个,钱扣对了但用量流水一条都查不到 ——
      // 上游按请求头认归属,而这个函数刻意不给只取 Authorization 的入口。
      authHeaders: gatewayPlatformHeaders,
      // 这条 transport 是**平台余额专用**的(下面那个 resolver 写死 `'platform'`),
      // 所以它的每一次计费往返都该让余额跟着刷新。自填 Key 走的是 wan3 /
      // seedance 直连那两条,不经过这里。
      onBilledExchange: notePlatformSpend,
    }),
    createSeedanceGatewayTokenResolver(
      gatewayTokenSources,
      () => 'platform',
    ),
  )

  /**
   * 按模型 + 计费模式选上游。除了提交与轮询(taskManager 内部自己选),另外两条路
   * 也认 taskId —— **重启接管**与**按任务号重取过期地址** —— 它们此前写死了
   * Seedance:万相的任务在 Ark 那边查不到,前者会把一条还在跑、已付费的任务
   * 错杀成失败卡片,后者会让「重新保存」报一句「任务不存在」。平台余额那条任务
   * 是影子 token 建的,不带 billing 去问会撞上同一组症状。
   */
  const transportOf = (model: string | undefined, billing: VideoBillingSource | undefined) =>
    transportFor(
      {
        seedance: createSeedanceTransport(seedanceClient, getSeedanceApiKey),
        wan3: wan3Transport,
        seedanceGateway: seedanceGatewayTransport,
      },
      model,
      { ...(billing ? { billing } : {}) },
    )

  const taskManager = new SeedanceTaskManager({
    client: seedanceClient,
    getApiKey: getSeedanceApiKey,
    wan3Transport,
    seedanceGatewayTransport,
    resolveBilling: resolveVideoBilling,
    // 轮询失败原先完全没翻译 —— 而它恰恰是上游错误最常出现的地方
    // （提交只走一次，轮询要走几十次）。
    translateError: translateVideoTaskError,
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
    persistVideo: (task) => persistVideoBytes(task, persistDeps),
  })

  const persistDeps: PersistVideoDeps = {
    downloadVideo: (url, dest) => seedanceClient.downloadVideo(url, dest),
    refreshVideoUrl: async (taskId, model, billing) => {
      const r = await transportOf(model, billing).queryTask(taskId)
      return r.content?.video_url
    },
    ingest: (threadId, files) => attachments.ingest(threadId, files),
    relayFileToCos: (p, mime, opts) => relayFileToCos(p, mime, opts),
    stat: (p) => fs.stat(p),
    mkdir: (p) => fs.mkdir(p, { recursive: true }),
    unlink: (p) => fs.unlink(p),
    downloadsDir: path.join(app.getPath('userData'), 'agent', 'downloads'),
    fallbackThreadId: FALLBACK_THREAD_ID,
    uuid: randomUUID,
    join: path.join,
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
    const videoUrl = typeof payload?.videoUrl === 'string' ? payload.videoUrl : undefined
    const taskId = typeof payload?.taskId === 'string' ? payload.taskId : ''
    // taskId 是持久句柄，凭它就能重查出一条新签发的地址；旧地址只是兜底。
    // 两个都没有才是真没救。
    if (!taskId && !videoUrl) {
      return { ok: false, error: '这张卡既没有任务号也没有视频地址，只能重新生成' }
    }
    // 卡片记着自己是哪种计费模式建的。少了它这次重查会打错通道,回一句
    // 「任务不存在」—— 而重查恰恰是上游地址过期后唯一不用花钱的补救。
    const billing = coerceVideoBillingSource(payload?.billing)
    try {
      const { localPath, remoteUrl } = await persistVideoBytes({
        videoUrl,
        model: String(payload?.model ?? '2.0'),
        taskId: taskId || randomUUID(),
        threadId: typeof payload?.threadId === 'string' ? payload.threadId : undefined,
        ...(billing ? { billing } : {}),
      }, taskId ? persistDeps : { ...persistDeps, refreshVideoUrl: undefined })
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
      // agent 这条路没有渲染层、拿不到用户的意向,所以在这里用与 taskManager 同一个
      // resolver 落一次锤。**必须在这里落而不是交给 submit 内部兜底** —— 下面的素材库
      // 守卫要用同一个结论;各判各的会长出「按平台余额提交、却拿 vvdance 凭据校验」
      // 这种组合,而它的表现是一句关于素材不存在的中文错误,根因完全看不出来。
      // 那个 resolver 自身的已知缺口写在 seedanceGateway/credentials.ts。
      const billing = resolveVideoBilling()
      // 提交前防线:asset:// 引用在当前站点必须真实存在(素材按「海外/国内」
      // 站点隔离,导入后切站点必然 NOT_FOUND)——确认缺失时用中文报错拦下。
      // 只对 vvdance 直连那条路做:万相不认识素材库、平台余额用的是另一个池,
      // 理由见 usesSeedanceAssetLibrary。
      if (usesSeedanceAssetLibrary(input.model, billing)) {
        await verifyContentAssetReferences(content, {
          apiKey: getSeedanceApiKey(),
          apiSecret: getSeedanceApiSecret(),
        })
      }
      const state = await taskManager.submit({ input, content, threadId, clientId, billing })
      // agent 这条路没有载荷可带,用渲染端推过来的那份开关镜像。
      if (usesSeedanceAssetLibrary(input.model, billing)) {
        void importImagesToPortraitLibrary(content, autoImportPortraitEnabled)
      } else if (billing === 'platform') {
        void importImagesToPlatformLibrary(content, autoImportPortraitEnabled)
      }
      return state
    } catch (e) {
      // 前置阶段（素材解析/导入/createTask，如 LOCAL_ASSET_IMPORT_FAILED）抛错时，
      // 把预备卡片落成 failed，避免气泡永远转圈；随后照旧把错误抛给工具层出横幅。
      // 上游裸错误(如 400 LOCAL_ASSET_NOT_FOUND)先翻译成人话再透出。
      const raw = e instanceof Error ? e.message : String(e)
      const message = translateVideoTaskError(raw)
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
    // 🚨 意向必须从渲染层带过来,主进程**不能自己猜**。主进程手上那份 activePool
    // 只是渲染层 `billingSource` 的镜像,而 `setBillingSource('own-key')` 先落
    // 本地状态、再尽力调 `clearBillingPool()`,那一步失败时被吞掉 —— 于是存在
    // 一个窗口:渲染层已是自填 Key,主进程仍握着 activePool。此刻去猜,猜出来的
    // 是平台余额,用户在不知情的情况下花掉组织的钱。
    // (完整论证见 seedanceGateway/credentials.ts 的「已知缺口」。)
    const billing = coerceVideoBillingSource(payload?.billing)
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
      // 卡片原始模式。只认该模型能力表里开放的模式 —— 载荷是渲染端来的,不能
      // 当成可信输入;不认识就不带,由 resolveVideoMode 按素材形状兜底。
      ...(typeof payload?.mode === 'string' && (caps.modes as readonly string[]).includes(payload.mode)
        ? { mode: payload.mode as VideoWorkbenchMode }
        : {}),
      // 文档/网页链接槽(仅万相)。原样带过去,由组包层解析与校验。
      ...(typeof payload?.documentOrLink === 'string' && payload.documentOrLink
        ? { documentOrLink: payload.documentOrLink }
        : {}),
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
      // 同上:只有 vvdance 直连那条路才碰它的素材库 / 人像库。见 usesSeedanceAssetLibrary。
      // `billing` 缺省(旧渲染层的载荷没有这个字段)时按自填 Key 处理,行为不变。
      if (usesSeedanceAssetLibrary(input.model, billing)) {
        await verifyContentAssetReferences(content, {
          apiKey: getSeedanceApiKey(),
          apiSecret: getSeedanceApiSecret(),
        })
      }
      const state = await taskManager.submit({
        input,
        content,
        source: 'workbench',
        ...(billing ? { billing } : {}),
        ...(clientId ? { clientId } : {}),
      })
      // 缺省开(与 UI 默认一致);只有显式 false 才跳过。
      if (usesSeedanceAssetLibrary(input.model, billing)) {
        void importImagesToPortraitLibrary(content, payload?.autoImportPortrait !== false)
      } else if (billing === 'platform') {
        void importImagesToPlatformLibrary(content, payload?.autoImportPortrait !== false)
      }
      return { success: true, taskId: state.taskId }
    } catch (e) {
      // 上游裸错误(如 400 LOCAL_ASSET_NOT_FOUND)翻译成人话再回渲染端卡片。
      return {
        success: false,
        error: translateVideoTaskError(e instanceof Error ? e.message : String(e)),
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
      probe: (taskId, model, billing) => transportOf(model, billing).queryTask(taskId),
      adopt: (params) => { taskManager.adopt(params) },
      translateError: translateVideoTaskError,
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

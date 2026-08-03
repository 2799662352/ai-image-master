// mediaRelay - 把本地字节(data: URL / Buffer)中转到 COS 历史图片桶,换取一个
// 可公网访问的 https URL。
//
// 为什么需要:Seedance 素材库 / 视频任务接口对 data: URL 有长度上限
// (实测 ~2.8MB 原图就触发 `API 400: url is too long`),而我们的 COS
// 历史图片上传链路(`cos:upload-image-history` 同款)稳定且快。所以
// 统一策略:大于阈值的本地素材 → 先传 COS → 用 https URL 提交上游。
//
// 桶/Key 规则与 src/main/index.ts 的 image-history IPC 完全一致,
// 视频/音频也落同一个桶(仅扩展名不同),便于排查与生命周期管理。
//
// ⚠️ Key 必须落在 `image-history/` 前缀下:生产环境走 STS 临时凭证
// (uploadBufferToBucket → getStsCosInstance),该 token 只授权
// `image-history/*` 的 PutObject(见 stsCredentials.ts)。换任何别的前缀
// (如曾用的 `media-relay/`)都会被 COS 拒为 `AccessDenied`。

import { randomBytes } from 'node:crypto'
import { uploadBufferToBucket, uploadStreamToBucket } from './cosClient'
import { describeCosError, isRetryableCosError, isStaleCredentialError } from './cosErrors'
import { clearStsCache } from './stsCredentials'

const MEDIA_RELAY_BUCKET = 'image-master-1345773498'
const MEDIA_RELAY_REGION = 'ap-guangzhou'

/**
 * 中转是「用户按了生成」这条链路上的前置步骤,一次网络抖动就废掉整张卡片,
 * 代价远高于多等几秒。所以瞬时失败(5xx / 429 / 408 / DNS / TLS / 超时)重试,
 * 确定性失败(请求非法、权限不足)立即放弃 —— 那类重试只会把失败推迟。
 *
 * 例外是票据失效的 403:它看着像鉴权失败,实则重签一张就好,所以额外给一次不
 * 占预算的重签机会(见 relayWithRetry 与 isStaleCredentialError)。
 */
const RELAY_ATTEMPTS = 3
const RELAY_BASE_DELAY_MS = 500
const RELAY_MAX_DELAY_MS = 8_000

/**
 * 第 `attempt` 次失败后该等多久 —— 指数退避 + 等量抖动。
 *
 * 指数退避是 AWS SDK / @google-cloud/storage 的共同做法(后者的
 * `retryDelayMultiplier` 默认就是 2,并配 `maxRetryDelay` 封顶)。抖动这一半在
 * 我们这儿有具体的用处:工作台批量启动时几十张卡会同时上传素材,一起撞上服务端
 * 抖动后,没有抖动的固定退避会让它们继续步调一致地重试,把同一时刻的压力原样
 * 复制一遍。
 *
 * 用等量抖动而非满抖动:满抖动可能给出接近 0 的等待,三次尝试会在一瞬间烧完,
 * 对 DNS 这种需要一点时间才恢复的故障反而更糟。保底一半间隔,同时仍然打散。
 */
export function relayRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(RELAY_MAX_DELAY_MS, RELAY_BASE_DELAY_MS * 2 ** (attempt - 1))
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
}

/**
 * @param preferredExt 不带点的扩展名。有真实文件名时**优先用它** —— mime 反查
 *   是个有限表,`.mkv` / `.avi` / `.flac` 这类没收录的类型会退化成 `.bin`,
 *   而上游按 URL 后缀判断素材类型,一个 `.bin` 链接可能被直接拒掉。文件自己的
 *   扩展名是现成的、也更准,没必要绕道 mime 再猜回来。
 */
function relayKey(mimeType: string, preferredExt?: string): string {
  const ext = preferredExt || EXT_BY_MIME[mimeType] || 'bin'
  const now = new Date()
  const yyyy = String(now.getFullYear())
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const id = randomBytes(8).toString('hex')
  // 必须 `image-history/` 前缀 —— STS 临时凭证仅授权此前缀(见文件头注释)。
  return `image-history/media-relay/${yyyy}/${mm}/${dd}/${id}.${ext}`
}

/**
 * 中转上传的全局并发闸。
 *
 * 为什么需要:视频工作台的 `startCards` 对卡片是**无上限**的 `Promise.all`,每张
 * 卡内部还要传若干素材,乘起来轻易几十个并发 PutObject。仓库里另外两道 COS 闸都
 * 够不到这条路 —— 主进程那道 12 槽只包住 `enqueueUpload()`,渲染层那道 4 槽在
 * 另一个进程里,而 mediaRelay 是直接调 cosClient 的。
 *
 * 取 4:与渲染层 `cosImageUpload.ts` 同值。那边的实测结论是「4 个并发足够把网络
 * 打满,多了也不会更快 —— 瓶颈在 COS 单连接带宽,不在客户端」。
 *
 * 槽位覆盖**整个重试周期**(含退避等待),而不只是单次 PutObject。退避期间放行新
 * 请求,等于把刚压下去的压力原样顶回服务端;而服务端正在抖动的时候,慢下来才是
 * 对的做法。代价是失败期间会有空转的槽位 —— 那正是我们想要的减速。
 */
export const MAX_CONCURRENT_RELAYS = 4
let relaysInFlight = 0
const relayWaiters: Array<() => void> = []

function acquireRelaySlot(): Promise<void> {
  if (relaysInFlight < MAX_CONCURRENT_RELAYS) {
    relaysInFlight += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    relayWaiters.push(() => {
      relaysInFlight += 1
      resolve()
    })
  })
}

function releaseRelaySlot(): void {
  relaysInFlight -= 1
  relayWaiters.shift()?.()
}

/** Exposed for tests; do not call from production code. */
export function __resetRelayConcurrencyForTests(): void {
  relaysInFlight = 0
  relayWaiters.length = 0
}

/**
 * 带重试地跑一次中转上传,并把失败统一收敛成**真 Error**。
 *
 * 为什么必须收敛:COS SDK 的失败是裸对象而非 Error,原样冒泡时调用方那句
 * `e instanceof Error ? e.message : String(e)` 会渲成 `[object Object]`——
 * 用户看到的报错里没有任何可诊断信息(见 describeCosError 的注释)。
 *
 * 每次重试都重新生成 Key,避免上一次失败留下的分片状态干扰下一次。
 */
async function relayWithRetry(op: string, run: () => Promise<string>): Promise<string> {
  await acquireRelaySlot()
  try {
    return await retryLoop(op, run)
  } finally {
    releaseRelaySlot()
  }
}

async function retryLoop(op: string, run: () => Promise<string>): Promise<string> {
  let lastError: unknown
  let attempt = 0
  let attemptsLeft = RELAY_ATTEMPTS
  let resignUsed = false

  while (attemptsLeft > 0) {
    attempt += 1
    attemptsLeft -= 1
    try {
      return await run()
    } catch (e) {
      lastError = e
      // 票据过期/签名失败:丢掉缓存里那张票、立刻重签一次。不占瞬时故障的重试
      // 预算,也不用退避 —— 它压根不是网络问题,等再久也不会自己好。
      if (!resignUsed && isStaleCredentialError(e)) {
        resignUsed = true
        attemptsLeft += 1
        clearStsCache()
        console.warn(`[mediaRelay] ${op} 票据失效,重签后立即重试:${describeCosError(e)}`)
        continue
      }
      if (attemptsLeft === 0 || !isRetryableCosError(e)) break
      const delay = relayRetryDelayMs(attempt)
      console.warn(
        `[mediaRelay] ${op} 第 ${attempt}/${RELAY_ATTEMPTS} 次失败,${delay}ms 后重试:${describeCosError(e)}`,
      )
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw new Error(describeCosError(lastError))
}

/** 上传 Buffer 到中转桶,返回公网 https URL。 */
export async function relayBufferToCos(body: Buffer, mimeType: string): Promise<string> {
  if (body.byteLength === 0) throw new Error('media relay: empty buffer')
  return relayWithRetry('relayBufferToCos', () =>
    uploadBufferToBucket({
      bucket: MEDIA_RELAY_BUCKET,
      region: MEDIA_RELAY_REGION,
      key: relayKey(mimeType),
      body,
      contentType: mimeType,
    }),
  )
}

/**
 * 把一个**本机文件**流式分片上传到中转桶,返回公网 https URL。
 *
 * 与 relayBufferToCos 的区别:不把整文件读进 Buffer —— 用 COS sliceUploadFile
 * 从磁盘流式上传(STS 鉴权,生产可用)。这样视频理解能支持到上游的客观上限
 * (qwen3.7 系列 2GB / 2 小时),而不再被「整文件读进内存」逼出的 200MB 闸门卡住。
 *
 * `fileSize` 仅用于给总时长保险丝定一个随体积放大的保底值(慢网下 2GB 也不会被
 * 提前掐断);不传则用 cosClient 的默认 10 分钟。
 */
export async function relayFileToCos(
  filePath: string,
  mimeType: string,
  opts?: { fileSize?: number },
): Promise<string> {
  // 保底 15 分钟;按 0.5MB/s 的悲观下行估算放大(2GB ≈ 68 分钟),取两者较大值。
  const FLOOR_MS = 15 * 60 * 1000
  const sizeBasedMs =
    opts?.fileSize && opts.fileSize > 0
      ? Math.ceil(opts.fileSize / (0.5 * 1024 * 1024)) * 1000
      : 0
  const hardTimeoutMs = Math.max(FLOOR_MS, sizeBasedMs)
  const sourceExt = /\.([A-Za-z0-9]{1,8})$/.exec(filePath)?.[1]?.toLowerCase()

  return relayWithRetry('relayFileToCos', () =>
    uploadStreamToBucket({
      bucket: MEDIA_RELAY_BUCKET,
      region: MEDIA_RELAY_REGION,
      key: relayKey(mimeType, sourceExt),
      filePath,
      contentType: mimeType,
      hardTimeoutMs,
    }),
  )
}

/** 解析 base64 data: URL 为 { buffer, mimeType };非 data: URL 返回 null。 */
export function parseDataUrl(input: string): { buffer: Buffer; mimeType: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/i.exec(input)
  if (!m) return null
  return { buffer: Buffer.from(m[2], 'base64'), mimeType: m[1] || 'application/octet-stream' }
}

/** data: URL → COS https URL。非 data: URL 原样返回。 */
export async function relayDataUrlToCos(url: string): Promise<string> {
  const parsed = parseDataUrl(url)
  if (!parsed) return url
  return relayBufferToCos(parsed.buffer, parsed.mimeType)
}

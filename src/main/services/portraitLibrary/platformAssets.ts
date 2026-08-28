// 平台人像库(火山资产)客户端 —— `/api/volcengine-asset` 协议,平台计费模式下的素材库。
//
// 与 `seedance/assets.ts`(vvdance 直连,HMAC 签名 + 站点隔离)**平级共存,不替换**:
// 两条链路的素材互不可见,按计费模式二选一。
//
// 契约来源是**后端** `sora-ui-backend/src/controllers/volcengineAssetController.ts` 与
// `routes/volcengineAsset.ts`。网页版前端 `sora-ui/src/api/volcengineAsset.ts` 的类型
// 与限额**多处与后端不符**(见下面各处注释),不作为依据。
//
// 这批端点的失败模式几乎全是**静默**的 —— 后端不报错,只是悄悄换掉你的入参。所以下面
// 每一处看起来多余的客户端校验,挡的都是一个「测试全绿、真机出怪事」的坑。

import { AuthError, requireString, requireToken, sendJson } from '../auth/httpJson'

const PREFIX = '/api/volcengine-asset'

/**
 * 服务端长轮询的上限(`volcengineAssetService.ts:11` 的 `POLL_TIMEOUT_MAX`)。
 * 后端把入参 clamp 到 [5s, 90s] —— service 那句 docstring 写的 30s 是过期注释。
 */
const POLL_SERVER_TIMEOUT_MS = 90_000
const POLL_INTERVAL_MS = 3_000

/**
 * poll 的 HTTP 超时必须**大于**服务端自己的 90s 上限。
 *
 * 它是一次长连接请求(后端在请求里循环等),不是客户端 setInterval。用默认的 15s,
 * 客户端会在服务端还没答完时自己 abort —— 表现成「等就绪永远失败」,而服务端日志里
 * 一切正常,两边都看不出问题在哪。
 */
const POLL_HTTP_TIMEOUT_MS = 95_000

/** 上传 50MB 走完整条公网链路要时间,15s 默认必然中途 abort。 */
const UPLOAD_HTTP_TIMEOUT_MS = 120_000

/**
 * 列表一次拿全量,不做服务端分页(与网页版同口径)。搜索 / 类型过滤 / `Hidden` 过滤
 * 全在本地做。上限来自后端的 `MAX_TOTAL_ITEMS`(controller:229)。
 */
const LIST_PAGE_SIZE = 2000

/** 后端 `name` 字段的硬上限:createAsset 静默截断,updateAsset 直接 400。 */
const NAME_MAX_LENGTH = 64

export type PlatformAssetType = 'Image' | 'Video' | 'Audio'

/**
 * 大小写敏感。后端是 `ALLOWED_ASSET_TYPES.has(assetType) ? assetType : 'Image'`
 * (controller:171)—— 传 `'video'` **不报错**,被静默降级成 `Image`,于是一段视频
 * 在素材库里、在画布上、在提交时全程被当作图片。宁可在这里响亮地拒掉。
 */
const ASSET_TYPES: readonly PlatformAssetType[] = ['Image', 'Video', 'Audio']

/**
 * 后端 multer 的 `MEDIA_MIME_WHITELIST`(controller:592-596),**只有 13 种**。
 *
 * 网页版的后缀正则却放行 `video/webm` / `audio/ogg` / `audio/aac` —— 用户选完文件、
 * 等字节传完,才在服务端被 fileFilter 拒掉。在客户端就拒,省掉那趟白跑的上传。
 */
const MIME_WHITELIST: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/bmp',
  'image/tiff',
  'image/gif',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/quicktime',
  'audio/mpeg',
  'audio/wav',
  'audio/mp3',
])

const MB = 1024 * 1024

/**
 * 以**后端** `MEDIA_SIZE_LIMITS`(controller:610-615)为准,另有 multer 的 50MB 硬闸
 * (routes:36-40)兜在更外面。
 *
 * ⚠️ 网页版 `mediaLimits.ts:29` 写的是 200MB 视频,那是**错的**:50–200MB 的视频会在
 * 服务端 400,而用户是在把 200MB 传完之后才知道。
 */
const SIZE_LIMITS: Record<PlatformAssetType, number> = {
  Image: 50 * MB,
  Video: 50 * MB,
  Audio: 15 * MB,
}

export interface PlatformAssetScope {
  projectId: number
  /** producer 池才有。**它是池键的另一半**,只按 projectId 认会把两个池悄悄合并。 */
  producerProjectId?: number
}

/**
 * 列表 / 详情 / poll 的条目。除 `Id` 外一律可选 —— 这些字段直接来自火山上游,
 * 而上游漏字段是这个代码库反复踩过的事(见 `seedance/assets.ts:normalizeListedAsset`)。
 */
export interface PlatformAsset {
  Id: string
  GroupId?: string
  Name?: string
  Status?: string
  /** 缩略图优先取它,回落 `URL`。命中后端 COS 旁挂表时两者都已是永久公网链。 */
  PreviewUrl?: string
  URL?: string
  cosUrl?: string
  AssetType?: string
  CreateTime?: string
  UpdateTime?: string
  Error?: { Code?: string; Message?: string }
  /** 已「移出素材库」(软删)。后端只打标不过滤 —— 过滤是展示层的事。 */
  Hidden?: boolean
}

export interface PlatformAssetList {
  Items: PlatformAsset[]
  /** ⚠️ 不等于 `Items.length`,也不是上游总数。要显示「N 可用」请自己数 `Status === 'Active'`。 */
  TotalCount: number
  /** 回收站条数。 */
  HiddenCount: number
  /** 素材过多、上游分页被截断,列表并不完整。 */
  Truncated: boolean
}

/**
 * `POST /assets` 的返回 —— **只有这四个字段**。
 *
 * controller:189 是 `{...result, URL, PreviewUrl, cosUrl}`,而 `result` 的类型是
 * `{Id: string}`。网页版的 `VolcAsset` 声明这里会回 `Status`/`Name`/`AssetType`/
 * `CreateTime`,**那是假的**;照抄它会让下游写出 `if (r.Status === 'Active')` 这种
 * 永远走不到的分支。要那些字段得自己 poll。
 */
export interface RegisteredPlatformAsset {
  Id: string
  URL: string
  PreviewUrl: string
  cosUrl: string
}

export interface UploadedMedia {
  url: string
  cosKey: string
  fileSize: number
  /** 后端按 MIME 前缀判定,已是首字母大写形态,可直接喂给 `registerAsset`。 */
  assetType: PlatformAssetType
}

export interface PlatformMediaFile {
  /**
   * 泛参必须钉成 `ArrayBuffer`:`BlobPart` 只收 `ArrayBufferView<ArrayBuffer>`,
   * 而裸 `Uint8Array` 默认是 `ArrayBufferLike`(可能由 SharedArrayBuffer 支撑)。
   * `fs.readFile` 回的 `Buffer` 满足这个签名,不用调用方转换。
   */
  data: Uint8Array<ArrayBuffer>
  filename: string
  mimeType: string
}

/**
 * 三个头每次都带。缺 `X-Project-Id` 或它 ≤0 时后端 400(`requireProjectId`,controller:21-27),
 * 本地先拦一道:错误话术能指向「没选计费池」,比后端那句更接近用户能做的事。
 *
 * ⚠️ `upload-media` 是**例外** —— 它整条 handler 都不调 `requireProjectId`(controller:618-653),
 * 不选池也能把字节推上去。这里仍然对它一视同仁地拦,但理由换成另一条:上传后紧跟的
 * `registerAsset` 一定要池,**在推 50MB 之前失败比之后失败好**。
 * 别据此在 UI 上加「不选池就不给选文件」的前置门 —— 后端并不要求,那是我们自己的取舍。
 */
function scopeHeaders(scope: PlatformAssetScope): Record<string, string> {
  if (!Number.isFinite(scope.projectId) || scope.projectId <= 0) {
    throw new AuthError(
      'INVALID_POOL',
      400,
      `X-Project-Id 不合法(当前 ${String(scope.projectId)})—— 请先选择计费池`,
    )
  }
  const ppId = scope.producerProjectId
  return {
    'X-Project-Id': String(Math.floor(scope.projectId)),
    // 只在 >0 时带上:0 不是一个合法的池键成分,带上去反而会被后端当成 producer 池。
    ...(typeof ppId === 'number' && ppId > 0 ? { 'X-Producer-Project-Id': String(ppId) } : {}),
  }
}

/**
 * 这批端点的错误信封是**第三种**形状,`session.ts:toAuthError` 认的那两种都不是它:
 *
 *   - controller 自己的校验:`{success:false, error:'缺少 url 参数'}` —— `error` 是**字符串**
 *   - 上游 502:`{success:false, error:'…', code:'…', requestId:'…'}` —— `code` 与 `error` **平级**
 *
 * 直接套 `toAuthError` 会把字符串当成 `{code,message}` 对象去读属性,两个都拿到
 * `undefined`:错误码退化成 `HTTP_400` 还算走运,**后端说的那句话整条丢失** ——
 * 用户看到「请求失败(HTTP 400)」,而后端明明写了「缺少 url 参数」。
 *
 * 反过来,配对路由那套嵌套形状(`{error:{code,message}}`,desktopAuth.ts:17)今天并不挂在
 * `/api/volcengine-asset/*` 上,但也一并认了:漏掉它就是上面那句话反着再犯一遍。
 *
 * `code` 保证是非空字符串:IPC 层的信封按 code 分支,落到 undefined 就成了「未知错误」。
 */
function toAssetError(status: number, body: Record<string, unknown>): AuthError {
  const nested =
    typeof body.error === 'object' && body.error !== null
      ? (body.error as { code?: unknown; message?: unknown })
      : null
  const upstreamCode =
    (typeof body.code === 'string' && body.code) ||
    (typeof nested?.code === 'string' && nested.code) ||
    null
  const detail =
    (typeof body.error === 'string' && body.error) ||
    (typeof nested?.message === 'string' && nested.message) ||
    (typeof body.message === 'string' && body.message) ||
    null
  // requestId 是向上游提工单时唯一的抓手,丢了就查不动了。
  const requestId = typeof body.requestId === 'string' && body.requestId ? body.requestId : null
  const message = detail ?? `请求失败(HTTP ${status})`
  return new AuthError(
    upstreamCode ?? `HTTP_${status}`,
    status,
    requestId ? `${message}(requestId: ${requestId})` : message,
  )
}

async function assetRequest(
  path: string,
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  scope: PlatformAssetScope,
  opts: { body?: Record<string, unknown>; form?: FormData; timeoutMs?: number } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = scopeHeaders(scope)
  const token = requireToken()
  const { status, body } = await sendJson(`${PREFIX}${path}`, method, { token, headers, ...opts })
  if (status >= 400) throw toAssetError(status, body)
  return { status, body }
}

/**
 * 成功信封的负载。`data` 不是对象(整个缺席、或被网关换成了别的东西)时回空对象 ——
 * 这一层不猜,该不该抛交给各调用点对**必填**字段的校验。
 */
function payload(body: Record<string, unknown>): Record<string, unknown> {
  const data = body.data
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
}

/**
 * `Id` 是 `PlatformAsset` 上唯一的必填字段,校验掉它这个类型就不再撒谎了(其余字段
 * 本来就声明成可选,`undefined` 在类型内)。
 *
 * 刻意**不**拿入参 `assetId` 兜底:`pollAsset` 的调用方按 `Status` 分支,合成一个
 * `Status` 为 undefined 的对象与「还在处理中」完全无法区分 —— 等就绪会永远转圈,
 * 而两边日志都干净。宁可响亮地抛。
 */
function requireAsset(body: Record<string, unknown>, status: number): PlatformAsset {
  const data = body.data
  const asset = (typeof data === 'object' && data !== null ? data : {}) as PlatformAsset
  requireString(asset.Id, 'Id', status)
  return asset
}

/**
 * 没有 `Id` 的列表条目直接丢掉。**本仓踩过**:`seedance/assets.ts:245-253` 记着线上实测
 * 部分条目 `assetId` 为 null,原样透传让渲染层的 key / 多选字典撞 null key,表现成网格
 * 重复渲染 + 点一张全带 ✓。没有 `Id` 的条目连一次引用都构造不出来,留着只会去污染 key。
 */
function hasId(item: unknown): item is PlatformAsset {
  if (typeof item !== 'object' || item === null) return false
  const id = (item as { Id?: unknown }).Id
  return typeof id === 'string' && id.length > 0
}

/** 后端 createAsset 的 `name.slice(0,64)` 是静默的,updateAsset 则直接 400。两边都自己先截。 */
function clampName(name: string): string {
  return name.slice(0, NAME_MAX_LENGTH)
}

function assertAssetType(assetType: PlatformAssetType): void {
  if (!ASSET_TYPES.includes(assetType)) {
    throw new AuthError(
      'INVALID_ASSET_TYPE',
      400,
      `assetType 必须是 ${ASSET_TYPES.join(' / ')} 之一(大小写敏感,当前 ${String(assetType)})`,
    )
  }
}

/**
 * 登记一条已在公网可达的素材。本地文件要先过 `uploadMedia` 换永久 COS 链(两步串行)。
 *
 * 登记是**异步**的:返回那一刻只有 `Id`,`Status` 要靠 `pollAsset` 等。
 */
export async function registerAsset(
  input: { url: string; assetType: PlatformAssetType; name?: string },
  scope: PlatformAssetScope,
): Promise<RegisteredPlatformAsset> {
  assertAssetType(input.assetType)
  const { status, body } = await assetRequest('/assets', 'POST', scope, {
    body: {
      url: input.url,
      assetType: input.assetType,
      ...(input.name === undefined ? {} : { name: clampName(input.name) }),
    },
  })
  // 四个都校验而不只校验 `Id`:controller:189 是 `{...result, URL: url, PreviewUrl: url,
  // cosUrl: url}`,三个 URL 是同一个已校验入参的回声,在一条对象字面量里同生共死。
  // 少校验一个,类型就又开始撒谎 —— 而 `<img src={undefined}>` 是不报错的。
  const data = payload(body)
  return {
    Id: requireString(data.Id, 'Id', status),
    URL: requireString(data.URL, 'URL', status),
    PreviewUrl: requireString(data.PreviewUrl, 'PreviewUrl', status),
    cosUrl: requireString(data.cosUrl, 'cosUrl', status),
  }
}

/**
 * 一次拿全量。
 *
 * ⚠️ 服务端那层 Redis 缓存在素材超 500 条后**永久命中不了**(缓存最多存 500,而这里
 * 固定要 2000,命中条件恒不成立),首屏会退化成多次串行上游调用、最长 30 秒。
 * 桌面端要自建本地缓存,别指望它。
 */
export async function listAssets(
  scope: PlatformAssetScope,
  options: { hidden?: boolean } = {},
): Promise<PlatformAssetList> {
  const query = new URLSearchParams({
    pageSize: String(LIST_PAGE_SIZE),
    sortBy: 'CreateTime',
    // ⚠️ 必须是大写 `Desc`。后端白名单是 `new Set(['Asc','Desc'])`(controller:47),
    // 小写落不进去就被换成 undefined(controller:284)—— **排序静默丢失**,列表变成
    // 上游的天然顺序,而用户以为最新的在最前。
    sortOrder: 'Desc',
    // 回收站视图,与正常列表口径相反。
    ...(options.hidden ? { hidden: '1' } : {}),
  })

  const { body } = await assetRequest(`/assets?${query}`, 'GET', scope)
  const data = payload(body)
  return {
    // `TotalCount` 不跟着减:它是后端算的可见总数,本来就不等于 `Items.length`。
    Items: Array.isArray(data.Items) ? data.Items.filter(hasId) : [],
    TotalCount: typeof data.TotalCount === 'number' ? data.TotalCount : 0,
    // 缺省要有确定的回落值,否则「回收站 (N)」会渲染成 "回收站 (undefined)"。
    HiddenCount: typeof data.HiddenCount === 'number' ? data.HiddenCount : 0,
    Truncated: data.Truncated === true,
  }
}

export async function getAsset(assetId: string, scope: PlatformAssetScope): Promise<PlatformAsset> {
  const { status, body } = await assetRequest(`/assets/${encodeURIComponent(assetId)}`, 'GET', scope)
  return requireAsset(body, status)
}

/**
 * 等素材就绪。**服务端长轮询** —— 一次请求,后端在里面循环等到 `Active`/`Failed` 或超时。
 * 别在外面再包一层 setInterval。
 */
export async function pollAsset(assetId: string, scope: PlatformAssetScope): Promise<PlatformAsset> {
  const query = new URLSearchParams({
    interval: String(POLL_INTERVAL_MS),
    timeout: String(POLL_SERVER_TIMEOUT_MS),
  })
  const { status, body } = await assetRequest(
    `/assets/${encodeURIComponent(assetId)}/poll?${query}`,
    'GET',
    scope,
    { timeoutMs: POLL_HTTP_TIMEOUT_MS },
  )
  return requireAsset(body, status)
}

/**
 * 「移出素材库」—— **软删**。只在后端隐藏表打标(controller:450-459),不动火山、
 * **不释放配额**,画布上已引用它的 `asset://` 继续解析得到,可从回收站恢复。
 *
 * UI 文案要写「移出素材库」而不是「删除」,否则用户会困惑为什么删了还提示素材过多。
 */
export async function hideAsset(
  assetId: string,
  scope: PlatformAssetScope,
): Promise<{ purged: boolean }> {
  const { body } = await assetRequest(`/assets/${encodeURIComponent(assetId)}`, 'DELETE', scope)
  return { purged: body.purged === true }
}

/** 「彻底删除」—— 真删上游,**不可逆**,且是唯一能回收火山配额与列表分页预算的操作。 */
export async function purgeAsset(
  assetId: string,
  scope: PlatformAssetScope,
): Promise<{ purged: boolean }> {
  const { body } = await assetRequest(
    `/assets/${encodeURIComponent(assetId)}?purge=1`,
    'DELETE',
    scope,
  )
  return { purged: body.purged === true }
}

/**
 * 重命名(`{name}`)与从回收站恢复(`{hidden:false}`)的唯一入口。恢复之后必须重拉列表。
 *
 * 两个字段都不给、或 `name` 为空 / 超 64,后端都是 400(controller:486-493)——
 * 这几条与 createAsset 的静默截断不同,是会响亮失败的,所以本地先拦掉。
 */
export async function patchAsset(
  assetId: string,
  patch: { name?: string; hidden?: boolean },
  scope: PlatformAssetScope,
): Promise<{ Id: string }> {
  const wantsRename = patch.name !== undefined
  const wantsVisibility = typeof patch.hidden === 'boolean'
  if (!wantsRename && !wantsVisibility) {
    throw new AuthError('INVALID_PATCH', 400, 'patchAsset 需要 name 或 hidden 至少提供一个')
  }
  if (wantsRename && !patch.name) {
    throw new AuthError('INVALID_PATCH', 400, 'name 不能为空')
  }

  const { status, body } = await assetRequest(
    `/assets/${encodeURIComponent(assetId)}`,
    'PATCH',
    scope,
    {
      body: {
        ...(wantsRename ? { name: clampName(patch.name as string) } : {}),
        ...(wantsVisibility ? { hidden: patch.hidden } : {}),
      },
    },
  )
  return { Id: requireString(payload(body).Id, 'Id', status) }
}

/** 与后端 `uploadMedia` 的判定同口径(controller:626-628):按 MIME 前缀,不看后缀。 */
function detectAssetType(mimeType: string): PlatformAssetType {
  if (mimeType.startsWith('video/')) return 'Video'
  if (mimeType.startsWith('audio/')) return 'Audio'
  return 'Image'
}

/**
 * 本地文件两步走的第一步:把字节换成永久 COS 公网链,再交给 `registerAsset`。
 *
 * 走这条路进来的素材是**永久链、零处理**;直接拿远程 URL 登记的则可能是会过期的
 * 签名 TOS 链,而前端对过期没有任何兜底。
 */
export async function uploadMedia(
  file: PlatformMediaFile,
  scope: PlatformAssetScope,
): Promise<UploadedMedia> {
  if (!MIME_WHITELIST.has(file.mimeType)) {
    throw new AuthError('UNSUPPORTED_MEDIA_TYPE', 400, `不支持的文件类型: ${file.mimeType}`)
  }
  const assetType = detectAssetType(file.mimeType)
  const limit = SIZE_LIMITS[assetType]
  if (file.data.byteLength > limit) {
    throw new AuthError('FILE_TOO_LARGE', 400, `${assetType} 文件不能超过 ${limit / MB}MB`)
  }

  // 必须是**原生** FormData + Blob。`Content-Type` 交给 fetch 自己生成 —— 手写一个就丢了
  // boundary,后端 multer 解不出 `file` 字段,回「未收到文件」400(不设的保证在
  // `httpJson.sendJson` 里由构造兜住)。
  const form = new FormData()
  form.append('file', new Blob([file.data], { type: file.mimeType }), file.filename)

  const { status, body } = await assetRequest('/upload-media', 'POST', scope, {
    form,
    timeoutMs: UPLOAD_HTTP_TIMEOUT_MS,
  })
  const data = payload(body)
  // `assetType` 是接力棒的一部分(下一步直接喂给 `registerAsset`)。在这里就拒,
  // 免得它一路走到 registerAsset 才以 `INVALID_ASSET_TYPE` 的面目出现 —— 那个码
  // 的意思是「调用方传错了」,会把排查引向错的一侧。
  const returnedType = data.assetType
  if (!ASSET_TYPES.includes(returnedType as PlatformAssetType)) {
    throw new AuthError(
      'MALFORMED_RESPONSE',
      status,
      `响应的 assetType 不在白名单内(${String(returnedType)})`,
    )
  }
  if (typeof data.fileSize !== 'number' || !Number.isFinite(data.fileSize)) {
    throw new AuthError('MALFORMED_RESPONSE', status, '响应缺少字段 fileSize')
  }
  return {
    // `url` 是两步走的接力棒:缺了而不抛,发出去的是 `{url: undefined}`,换回后端一句
    // 「缺少 url 参数」400 —— 报错点离真正的病灶隔了一整个网络往返。
    url: requireString(data.url, 'url', status),
    cosKey: requireString(data.cosKey, 'cosKey', status),
    fileSize: data.fileSize,
    assetType: returnedType as PlatformAssetType,
  }
}

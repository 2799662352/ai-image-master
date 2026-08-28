// `window.electronAPI.portraitLibrary` 的契约。主进程、preload、渲染层同吃这一份。
//
// 单独立文件的理由与 `authApi.ts` 顶部那条相同:这家代码库已经为 AgentApi 吃过一次教训 ——
// 渲染层照抄了一份 preload 的 DTO,两份定义随后各自漂移。
//
// ⚠️ **这批 DTO 的真源在主进程** `services/portraitLibrary/platformAssets.ts`。这里重新
// 声明是因为渲染层不能 import 主进程模块(那会把 `electron` / `net` 拖进渲染层的依赖图),
// 但**形状必须逐字一致**,那边改了这里要跟着改。同一处权衡与写法见 `authApi.ts:41-44`
// 对 `session.ts` 那批类型的处理。
//
// 这里**不含任何凭据**:人像库的平台 JWT 只活在主进程,由 `auth/httpJson.requireToken()`
// 在 `platformAssets` 那一层就地取用。IPC 回包里出现它是一条被测试盯住的红线。

import type { QuotaRpc } from './authApi'

/**
 * 与额度那批**刻意是同一个信封类型**,不是复制品。
 *
 * 取个域内的名字只是为了在人像库的调用点上读得通;底下是同一个 `QuotaRpc`,所以两边
 * 不可能漂移。渲染层按 `error.code` 分支的写法在两个子系统之间可以原样搬。
 */
export type PortraitRpc<T> = QuotaRpc<T>

/**
 * 素材所属的计费池引用。**主进程侧的真源是 `platformAssets.ts` 的 `PlatformAssetScope`。**
 *
 * 🚨 **`projectId` 单独不构成池键。** 上游把 group 按 `project-<id>` 或
 * `project-<id>-pp-<ppId>` 懒创建,一个池下登记的 asset 在另一个池下**读不出来**
 * (不是陈旧,是不存在)。两个不同的 producer project 可以共用一个 `projectId` ——
 * 只按 `projectId` 认会把两个池悄悄合并,素材记到错的组里。
 *
 * `producerProjectId` 写成 `number | null | undefined` 三种都收,是为了让渲染层能把
 * `BillingPoolRef`(那边是 `number | null`)**原样递过来**,不必在调用点做
 * `?? undefined` 的转换 —— 那种转换每多写一处,就多一个把池键另一半丢掉的地方。
 * 三种「没有」在主进程边界上归一成同一个缺省,归一只发生一次。
 *
 * ⚠️ 无法归一的值(字符串数字、负数、小数)会被**拒绝**而不是当成「没有」:
 * 静默降级的后果是一批登记进错组、再也查不出来的素材。
 */
export interface PortraitScopeRef {
  projectId: number
  producerProjectId?: number | null
}

/**
 * **大小写敏感。** 上游是 `ALLOWED_ASSET_TYPES.has(t) ? t : 'Image'` —— 传 `'video'`
 * 不报错,被静默降级成图片,于是一段视频在素材库、画布、提交时全程被当作图片。
 */
export type PortraitAssetType = 'Image' | 'Video' | 'Audio'

/**
 * 列表 / 详情 / poll 的条目。除 `Id` 外一律可选 —— 这些字段直接来自火山上游,
 * 而上游漏字段是这个代码库反复踩过的事。
 */
export interface PortraitAsset {
  Id: string
  GroupId?: string
  Name?: string
  /** 终态只有 `Active` / `Failed`,其余(含 `undefined`)都按「还在处理中」处置。 */
  Status?: string
  /** 缩略图优先取它,回落 `URL`。 */
  PreviewUrl?: string
  URL?: string
  cosUrl?: string
  AssetType?: string
  CreateTime?: string
  UpdateTime?: string
  Error?: { Code?: string; Message?: string }
  /**
   * 已「移出素材库」(软删)。
   *
   * **后端的行为按端点不同,别记成一句话**(逐条核对过 `volcengineAssetController.ts`):
   *
   *   - `GET /assets` 列表:**真过滤**。正常视图 `filter(!hidden)`、回收站 `filter(hidden)`
   *     (`:348-350`)。所以正常视图里**不会**出现 `Hidden: true` 的条目。
   *   - `GET /assets/:id` 与 `/poll`:**只打标不过滤**(`:218-221`、`:398-403`),
   *     注释写明「画布上已有节点的 asset:// 必须继续解析得到」。
   *
   * 🚨 **所以过滤只能在展示层做,数据源层与 store 层严禁过滤。** 那个数组同时用于解析
   * 已有引用的 `asset://` —— 在源头过滤会让画布上已经引用它的素材直接失效
   * (解析退化成 `undefined`),而这条路正是靠 `getAsset`/`poll` 那两个**不过滤**的端点
   * 才成立的。展示层多过滤一道是无害的冗余(列表本来就不会给),源头少过滤一道则是 bug。
   */
  Hidden?: boolean
}

export interface PortraitAssetList {
  Items: PortraitAsset[]
  /** ⚠️ 不等于 `Items.length`,也不是上游总数。要显示「N 可用」请自己数 `Status === 'Active'`。 */
  TotalCount: number
  /** 回收站条数。 */
  HiddenCount: number
  /** 素材过多、上游分页被截断,列表并不完整。 */
  Truncated: boolean
}

/**
 * `register` 的返回 —— **只有这四个字段**,没有 `Status` / `Name` / `CreateTime`。
 *
 * 登记是异步的:返回那一刻只有 `Id`,要 `poll` 才拿得到状态。三个 URL 都等于提交的那条
 * (已是永久 COS 链),所以缩略图立刻可用,只缺元数据。
 */
export interface PortraitRegisteredAsset {
  Id: string
  URL: string
  PreviewUrl: string
  cosUrl: string
}

export interface PortraitUploadedMedia {
  url: string
  cosKey: string
  fileSize: number
  /** 已是首字母大写形态,可直接喂给 `register`。 */
  assetType: PortraitAssetType
}

/**
 * 本地文件上传的载荷。
 *
 * 🚨 **`data` 必须是 `ArrayBuffer`(或 TypedArray),绝不能直接塞 `File` / `Blob`。**
 * 结构化克隆认得前者,而 Electron 的序列化器不支持后者 —— `File` 到主进程是个 `{}`,
 * 上传照常发出但是 0 字节,隔一整个网络往返才换回一句「未收到文件」400。
 * 渲染层的写法是 `data: await file.arrayBuffer()`。
 *
 * ⚠️ **在调用之前先按后端口径拦一次大小**:图片 50MB / 视频 50MB / 音频 15MB。
 * 主进程也会拦(`FILE_TOO_LARGE`),但那时 IPC 的整份拷贝已经发生了 —— 一个 500MB 的
 * 误选会先把 500MB 复制过进程边界,再被拒。
 */
export interface PortraitUploadFile {
  data: ArrayBuffer
  filename: string
  mimeType: string
}

export interface PortraitRegisterInput {
  /** 必须是上游拉得到的公网地址。本地文件要先走 `upload` 换永久 COS 链。 */
  url: string
  assetType: PortraitAssetType
  /** 超 64 字会被截断(后端 `POST` 静默截、`PATCH` 直接 400,客户端两边都先截)。 */
  name?: string
}

export interface PortraitEnsureInput {
  url: string
  name?: string
  /** 默认 `Image`。 */
  assetType?: PortraitAssetType
}

/**
 * 重命名(`name`)与从回收站恢复(`hidden: false`)的唯一入口。
 *
 * ⚠️ `hidden: false` 是最容易被 falsy 判断吞掉的取值,而它恰好就是「恢复」那个动作。
 */
export interface PortraitPatch {
  name?: string
  hidden?: boolean
}

/**
 * 渲染层可用的人像库能力(平台计费模式)。自填 Key 模式走的是另一条 vvdance 链路,
 * 两边的素材互不可见。
 *
 * 一律回 `{ ok, data } | { ok: false, error }` 信封 —— 主进程刻意不裸抛,裸抛经 IPC 会被
 * 包成 "Error invoking remote method '…'",error code 全部丢失。而 UI 必须按 code 分支:
 *
 *   `ASSET_NOT_READY`    → 「稍等几秒再试」
 *   `ASSET_FAILED`       → 「换一张或重新导入」(**不是**稍等:上游的终态判决,重试无用)
 *   `NOT_AUTHENTICATED`  → 引导登录
 *   `HTTP_403` / 权限类  → 引导换组织(多半是「还没加入那个组织」)
 *   `INVALID_POOL`       → 池参数不对,先选计费池
 *   `FILE_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` → 换个文件
 *
 * `scope` 每次显式传,主进程**不猜**当前池:池错了不是计费错,是素材登记进错的组,
 * 而跨池的 asset 根本读不出来。
 */
export interface PortraitLibraryApi {
  list: (
    scope: PortraitScopeRef,
    options?: { hidden?: boolean },
  ) => Promise<PortraitRpc<PortraitAssetList>>
  /**
   * 按 id 兜底解析一条素材(列表里没有时才用)。取不到是 `{ ok: true, data: null }`
   * 而不是错误信封 —— 展示层拿不到就是一张占位图,不该弹错误提示。
   *
   * 主进程侧带 in-flight 去重与 404/403 负缓存(按池分键),所以可以放心在渲染循环里调。
   */
  resolve: (
    scope: PortraitScopeRef,
    assetId: string,
  ) => Promise<PortraitRpc<PortraitAsset | null>>
  /**
   * 等素材就绪。**服务端长轮询**(一次请求最长 90s),不要在外面再包 setInterval。
   * 已是终态时后端短路直接返回,所以对已就绪的素材这是一次快往返。
   */
  poll: (scope: PortraitScopeRef, assetId: string) => Promise<PortraitRpc<PortraitAsset>>
  register: (
    scope: PortraitScopeRef,
    input: PortraitRegisterInput,
  ) => Promise<PortraitRpc<PortraitRegisteredAsset>>
  /** 本地文件两步走的第一步:字节换永久 COS 链,再交给 `register`。 */
  upload: (
    scope: PortraitScopeRef,
    file: PortraitUploadFile,
  ) => Promise<PortraitRpc<PortraitUploadedMedia>>
  /**
   * 「移出素材库」—— **软删**。不动上游、**不释放配额**,已引用它的 `asset://` 继续可用,
   * 可从回收站恢复。UI 文案要写「移出素材库」而不是「删除」,否则用户会困惑为什么删了
   * 还提示素材过多。
   */
  hide: (scope: PortraitScopeRef, assetId: string) => Promise<PortraitRpc<{ purged: boolean }>>
  /** 「彻底删除」—— 真删上游,**不可逆**,且是唯一能回收配额与列表分页预算的操作。 */
  purge: (scope: PortraitScopeRef, assetId: string) => Promise<PortraitRpc<{ purged: boolean }>>
  patch: (
    scope: PortraitScopeRef,
    assetId: string,
    patch: PortraitPatch,
  ) => Promise<PortraitRpc<{ Id: string }>>
  /**
   * 「这张图在这个池里有没有一个可用的 `asset://` id?没有就现登记一个」,并等它就绪。
   *
   * 拿不到就是错误信封,**绝不会降级成图片 URL** —— 降级会产出「同一套衣服换了张脸」,
   * 比等待贵得多。所以失败时不要自己回落去用原图 URL。
   */
  ensure: (scope: PortraitScopeRef, input: PortraitEnsureInput) => Promise<PortraitRpc<string>>
  /** 只读本地绑定,不发请求。用来在不打网络的情况下显示「这张图已在本池登记过」。 */
  lookupBinding: (
    scope: PortraitScopeRef,
    url: string,
  ) => Promise<PortraitRpc<string | null>>
  /**
   * 清空按 id 解析的那两件缓存(in-flight 去重 + 404/403 负缓存)。
   *
   * **切池 / 登出 / 用户手动刷新时调。** 是全局的、不带 scope:按池清会把刚切走的那个池
   * 的负缓存留下,而那恰恰是最该重查的 ——「不属于当前池」正是 403 最常见的成因。
   */
  clearResolutionCache: () => Promise<PortraitRpc<null>>
}

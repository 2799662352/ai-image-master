// 人像库暴露给渲染层的 IPC 编排。
//
// 这一层**只做编排与信封**:把渲染层递来的 `unknown` 窄化成下游要的形状,把结果包成
// `{ ok, data } | { ok: false, error }`。所有业务判断在 `platformAssets`(HTTP 形状、
// 大小写、限额、白名单)与 `ensureAsset`(池键成对、等就绪、缓存)里,这里一条都不重复 ——
// 重复一条就是一处会漂移的常量。
//
// ── 为什么一律回信封,绝不裸抛 ──────────────────────────────────────────────
//
// 裸抛经 IPC 会被 Electron 包成 "Error invoking remote method '…'",后端的 error code
// **全部丢失**。而 UI 至少有四种动作完全不同的分支要靠 code 分流:
//
//   `ASSET_NOT_READY`   → 「稍等几秒再试」
//   `ASSET_FAILED`      → 「换一张或重新导入」(**不是**稍等 —— 那是上游的终态判决,
//                          再重试一万次也还是 Failed,只会一直造垃圾)
//   `NOT_AUTHENTICATED` → 引导登录
//   403 / 池不匹配      → 引导换组织
//
// 形状与理由都照 `auth/ipc.ts` 的 `quotaRpc`。`code` 保证是非空字符串:非 `AuthError`
// (断网、DNS 失败、超时)也合成一个,否则渲染层的 switch 落到 `undefined` 分支,
// 表现成「什么提示都没有」。
//
// ⚠️ 今天本层不需要 `auth/ipc.ts:requireGatewayToken` 那种「把领域错误翻译成 `AuthError`」
// 的适配器,因为下游两层抛的**全是** `AuthError`。这不是永久成立的:哪天有人在人像库这条
// 路上引入自己的错误类(`PortraitError` 之类),它的 code 会被下面那个 catch 压成
// `PORTRAIT_REQUEST_FAILED` —— 而那正是不裸抛要解决的那个问题。届时补一个翻译层,
// 别改这里的兜底分支。
//
// ── scope 由渲染层显式传,且**不与主进程当前 armed 的池比对** ──────────────
//
// 每个操作都要 `PlatformAssetScope`。两条路都考虑过:
//
//   (a) 渲染层每次显式传 —— 与 `platformAssets` 的签名一致,主进程不猜
//   (b) 主进程自己读 `gatewayToken.ts` 的 activePool —— 渲染层不用管,但两边会失步
//
// 选 (a)。理由不是「与签名一致」那么轻,是 **(b) 读的根本不是同一个东西**:activePool 是
// 网关影子 token 的**计费**池;人像库这条路用的是平台 JWT(`platformAssets` 里的
// `requireToken()`),池只经 `X-Project-Id` / `X-Producer-Project-Id` 两个头表达。两者今天
// 通常相等,但不是同一个概念 —— 自填 Key 模式下 activePool 是 null,而「清理回收站腾配额」
// 与「一键搬家到工作室池」都得在那时候照常能用。绑死等于把这两件事一起关掉。
//
// 更进一步:**连「把传来的 scope 与 activePool 比一比,不一致就拒」都不做。** 这一条是
// 刻意的,不是省事:
//
//   1. **它挡不住真正想挡的错。** 渲染层的池认知与调 `auth:set-billing-pool` 的是同一个
//      store;store 错了两边同向错,比对照样通过。
//   2. **而这个仓库里已知存在的那个失步窗口,陈旧的恰恰是主进程这一侧。**
//      `useQuotaStore.setBillingSource('own-key')` 把 `clearBillingPool()` 的失败吞掉了
//      (Task 4 记在 `seedanceGateway/credentials.ts` 的那条)。按 activePool 校验会把一个
//      **正确**的渲染层请求拒掉 —— 方向正好反了。
//   3. **「asset 与池必须成对」这条不变量已经被结构性地守住了。** `ensureAsset` 把池键两半
//      与 assetId 一起存,读时两半都比,不等即视为不存在。在这里再加一道拿可能陈旧的值做的
//      弱比对,加不出任何强度,只会新增一类假拒绝。
//
// 所以这一层只做**形状**窄化(下面几个 `to*`),不做归属判断。
//
// ── 参数顺序:scope 一律在最前 ──────────────────────────────────────────────
//
// `platformAssets` 自己是混的(`listAssets(scope, …)` 在前,`getAsset(id, scope)` 在后)。
// 跨过 IPC 就不能混:窄化在这一层是逐通道手写的,位置一变就有人把 assetId 当 scope 递下去,
// 而那读出来是 `undefined` 的 projectId —— 撞上 `INVALID_POOL` 算走运。统一成 scope 在最前,
// `toScope(args[0])` 就成了每条通道结构上相同的第一步。

import { ipcMain } from 'electron'
import { AuthError } from '../auth/httpJson'
import {
  hideAsset,
  listAssets,
  patchAsset,
  pollAsset,
  purgeAsset,
  registerAsset,
  uploadMedia,
  type PlatformAssetScope,
  type PlatformAssetType,
  type PlatformMediaFile,
} from './platformAssets'
import {
  clearAssetResolutionCache,
  ensureAsset,
  lookupAssetBinding,
  resolveAsset,
  type EnsureAssetInput,
} from './ensureAsset'

// ⚠️ 新增通道必须同时加进这个数组 —— 它是 dispose 时逐个 `removeHandler` 的唯一依据。
// 漏加的症状不是「某个功能不工作」,而是热重载后 `ipcMain.handle` 对同一通道抛
// 「second handler」,第一次遇到时很难归因。
const PORTRAIT_CHANNELS = [
  'portrait:list',
  'portrait:resolve',
  'portrait:poll',
  'portrait:register',
  'portrait:upload',
  'portrait:hide',
  'portrait:purge',
  'portrait:patch',
  'portrait:ensure',
  'portrait:lookup-binding',
  'portrait:clear-resolution-cache',
] as const

type PortraitRpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

async function portraitRpc<T>(work: () => T | Promise<T>): Promise<PortraitRpcResult<T>> {
  try {
    return { ok: true, data: await work() }
  } catch (e) {
    if (e instanceof AuthError) {
      return { ok: false, error: { code: e.code, message: e.message } }
    }
    return {
      ok: false,
      // `message` 也要保证非空:抛出来的可能是字符串、`null`、甚至 `undefined`
      // (`Promise.reject()` 无参),那时 `String(e)` 给的 "undefined" 至少还能进日志,
      // 而空串会让 UI 弹一个没有正文的错误框。
      error: {
        code: 'PORTRAIT_REQUEST_FAILED',
        message: (e instanceof Error ? e.message : String(e)) || '人像库请求失败',
      },
    }
  }
}

// ── 窄化 ────────────────────────────────────────────────────────────────────
//
// 全部**抛 `AuthError`**、由 `portraitRpc` 兜成信封,不在 handler 开头裸抛 ——
// 那正是 code 会被 Electron 吞掉的那条路径,而 UI 对 `INVALID_POOL` /
// `INVALID_ASSET_ID` / `INVALID_ASSET_URL` / `INVALID_UPLOAD` 的动作各不相同。

function asRecord(raw: unknown, err: () => never): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) err()
  return raw as Record<string, unknown>
}

/**
 * 池键的另一半。
 *
 * 「没有 producer 池」有**三种**合法拼法,三种都要归一成同一个缺省:渲染层的
 * `BillingPoolRef` 写 `null`、`PlatformAssetScope` 写缺省、而 `scopeHeaders` 与
 * `normalizePool` 都把 `0` 当作没有。留着 `null` 会让盘上的绑定过不了
 * `ensureAsset.isBinding`(那条绑定下次启动就被丢掉,于是每次重新登记);留着 `0`
 * 会造出一个线上不存在的池键。
 *
 * 但**无法归一的垃圾一律拒**,刻意不照抄 `auth/ipc.ts:toBillingPool` 的「一律归一成
 * null」:那边算错了是钱记到别的池,这边算错了是**素材登记进错的组**,而跨池的 asset
 * 根本读不出来(不是陈旧,是不存在)。把 `'7'` 静默变成「没有 producer 池」等于把一次
 * 渲染层的类型手滑变成一批查不出来的素材,且没有任何报错。
 */
function toProducerProjectId(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
    return raw > 0 ? raw : undefined
  }
  throw new AuthError(
    'INVALID_POOL',
    400,
    `producerProjectId 不合法(当前 ${JSON.stringify(raw)})—— 没有 producer 池请传 null 或省略`,
  )
}

function toScope(raw: unknown): PlatformAssetScope {
  const src = asRecord(raw, () => {
    throw new AuthError('INVALID_POOL', 400, '计费池参数必须是对象')
  })
  const projectId = src.projectId
  if (typeof projectId !== 'number' || !Number.isInteger(projectId) || projectId <= 0) {
    throw new AuthError(
      'INVALID_POOL',
      400,
      `projectId 不合法(当前 ${JSON.stringify(projectId)})—— 请先选择计费池`,
    )
  }
  const producerProjectId = toProducerProjectId(src.producerProjectId)
  // 逐字段重建而不是透传原对象:渲染层多送的字段必须在这里被丢掉,否则它们会一路
  // 流进 `ensureAsset` 的持久化池键里。
  return { projectId, ...(producerProjectId === undefined ? {} : { producerProjectId }) }
}

function toAssetId(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) {
    throw new AuthError('INVALID_ASSET_ID', 400, `assetId 无效(当前 ${JSON.stringify(raw)})`)
  }
  return raw
}

function toAssetUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) {
    throw new AuthError('INVALID_ASSET_URL', 400, `素材 URL 无效(当前 ${JSON.stringify(raw)})`)
  }
  return raw
}

function toOptionalName(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new AuthError('INVALID_ASSET_NAME', 400, `素材名必须是字符串(当前 ${JSON.stringify(raw)})`)
  }
  return raw
}

/**
 * 白名单校验**不在这里** —— `platformAssets.assertAssetType` 是那张表的唯一持有者,
 * 在这里再抄一份必然漂移成两张表,而漂移的症状是上游把拼错的类型静默降级成 `Image`。
 * 这里只保证它是个字符串,让那个 `INVALID_ASSET_TYPE` 有机会被抛出来。
 */
function toAssetType(raw: unknown): PlatformAssetType | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new AuthError('INVALID_ASSET_TYPE', 400, `assetType 必须是字符串(当前 ${JSON.stringify(raw)})`)
  }
  return raw as PlatformAssetType
}

/**
 * 字节由**渲染层**读出来、以 `ArrayBuffer` 递过来,主进程这边只做包装。
 *
 * 🚨 **不要把 `File`/`Blob` 塞进 IPC。** 结构化克隆的 `ArrayBuffer` / TypedArray 过得去,
 * 但 Electron 的序列化器不支持 `File`/`Blob` —— 它们到这边是个 `{}`,而 `new Uint8Array({})`
 * 是 0 字节:上传照常发出,隔一整个网络往返换回后端一句「未收到文件」400,报错点离病灶
 * 隔着 50MB。所以这里对形状响亮地拒。
 *
 * 也不走 base64(仓里 `cos:*` / `audio-history:*` 那批的老写法):对 50MB 的素材,base64
 * 要多背 33% 的体积,外加编解码两趟全缓冲区变换 —— 而 `ArrayBuffer` 本来就是结构化克隆的
 * 一等公民,直接递即可。
 *
 * **大小限制刻意只在 `platformAssets` 拦一道。** 字节走到这里时 IPC 那次拷贝已经发生了,
 * 在这儿再拦省不下任何东西;而两处各写一个 50MB 必然漂移。真正省事的那道闸在渲染层,
 * 要在 `file.arrayBuffer()` 之前拦 —— 那是 Task 5 的事,见本次报告。
 */
function toUploadFile(raw: unknown): PlatformMediaFile {
  const bad = (why: string): never => {
    throw new AuthError('INVALID_UPLOAD', 400, why)
  }
  const src = asRecord(raw, () => bad('上传参数必须是对象'))

  const { filename, mimeType, data } = src
  if (typeof filename !== 'string' || !filename) bad(`文件名无效(当前 ${JSON.stringify(filename)})`)
  if (typeof mimeType !== 'string' || !mimeType) bad(`MIME 类型无效(当前 ${JSON.stringify(mimeType)})`)

  let bytes: Uint8Array<ArrayBuffer>
  if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data)
  } else if (ArrayBuffer.isView(data)) {
    // 只取视图自己那一段。直接拿 backing buffer 会把邻居的字节一起发上去 ——
    // `subarray()` 出来的视图 byteOffset 不为 0,而那正是渲染层切片时的常见形态。
    const { buffer, byteOffset, byteLength } = data
    bytes = new Uint8Array(buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer)
  } else {
    return bad(`文件字节必须是 ArrayBuffer 或 TypedArray(当前 ${JSON.stringify(data)})`)
  }

  return { data: bytes, filename: filename as string, mimeType: mimeType as string }
}

function toRegisterInput(raw: unknown): {
  url: string
  assetType: PlatformAssetType
  name?: string
} {
  const src = asRecord(raw, () => {
    throw new AuthError('INVALID_ASSET_URL', 400, '登记参数必须是对象')
  })
  const name = toOptionalName(src.name)
  return {
    url: toAssetUrl(src.url),
    // 缺省交给下游的白名单去拒 —— 这里替它选一个默认值等于替调用方猜类型。
    assetType: toAssetType(src.assetType) as PlatformAssetType,
    ...(name === undefined ? {} : { name }),
  }
}

function toEnsureInput(raw: unknown): EnsureAssetInput {
  const src = asRecord(raw, () => {
    throw new AuthError('INVALID_ASSET_URL', 400, 'ensure 参数必须是对象')
  })
  const name = toOptionalName(src.name)
  const assetType = toAssetType(src.assetType)
  return {
    url: toAssetUrl(src.url),
    ...(name === undefined ? {} : { name }),
    ...(assetType === undefined ? {} : { assetType }),
  }
}

/**
 * 「两个字段都没给」与「name 为空」由 `platformAssets.patchAsset` 判(`INVALID_PATCH`)。
 *
 * 这里只负责**不凭空造字段**:下游判的是 `patch.name !== undefined` 与
 * `typeof patch.hidden === 'boolean'`,造一个 `hidden: undefined` 出来不影响它,
 * 但反过来把 `hidden: false` 用 falsy 判断吞掉就会 —— 那正是「从回收站恢复」的取值,
 * 吞掉之后用户看到的是「恢复失败」,而错误码指向「两个字段都没给」。
 */
function toPatch(raw: unknown): { name?: string; hidden?: boolean } {
  const src = asRecord(raw, () => {
    throw new AuthError('INVALID_PATCH', 400, 'patch 参数必须是对象')
  })
  const name = toOptionalName(src.name)
  return {
    ...(name === undefined ? {} : { name }),
    ...(typeof src.hidden === 'boolean' ? { hidden: src.hidden } : {}),
  }
}

function toListOptions(raw: unknown): { hidden?: boolean } {
  if (raw === undefined || raw === null) return {}
  const src = asRecord(raw, () => {
    throw new AuthError('INVALID_LIST_OPTIONS', 400, '列表选项必须是对象')
  })
  return typeof src.hidden === 'boolean' ? { hidden: src.hidden } : {}
}

// ── 注册 ────────────────────────────────────────────────────────────────────

/**
 * 注册全部人像库通道,返回 disposer。
 *
 * 与 `registerAuthIpc` 不同,这里**没有**启动副作用也不需要 `getWindow`:本层不广播、
 * 不读盘(`ensureAsset` 的绑定文件是懒读的,第一次调用时才碰盘),所以它可以在
 * app ready 之后的任意时点挂上。
 */
export function registerPortraitLibraryIpc(): () => void {
  // 先摘一遍再挂。真 `ipcMain` 对同一通道二次 `handle` 会抛「second handler」,
  // 而热重载会走到这条路上。
  for (const ch of PORTRAIT_CHANNELS) {
    ipcMain.removeHandler(ch)
  }

  ipcMain.handle('portrait:list', (_e, scope: unknown, options: unknown) =>
    portraitRpc(() => listAssets(toScope(scope), toListOptions(options))),
  )

  // 渲染层拿到的是**带缓存的** `resolveAsset`,不是裸 `getAsset` —— 后者刻意不含缓存
  // (Task 1 的决定),把它开给渲染层就是把「列表里没有的 id」交给一个会重渲染的循环去打。
  // in-flight 去重与 404/403 负缓存正是为这条路存在的。所以没有 `portrait:get`。
  ipcMain.handle('portrait:resolve', (_e, scope: unknown, assetId: unknown) =>
    portraitRpc(() => resolveAsset(toAssetId(assetId), toScope(scope))),
  )

  ipcMain.handle('portrait:poll', (_e, scope: unknown, assetId: unknown) =>
    portraitRpc(() => pollAsset(toAssetId(assetId), toScope(scope))),
  )

  ipcMain.handle('portrait:register', (_e, scope: unknown, input: unknown) =>
    portraitRpc(() => registerAsset(toRegisterInput(input), toScope(scope))),
  )

  ipcMain.handle('portrait:upload', (_e, scope: unknown, file: unknown) =>
    portraitRpc(() => uploadMedia(toUploadFile(file), toScope(scope))),
  )

  // 软删与真删是两条通道,不是一个带 flag 的通道:两者语义完全不同(前者可恢复、
  // 不释放配额,后者不可逆、是唯一能回收配额的),而一个 boolean 参数在窄化失手时
  // 会把「移出素材库」变成「彻底删除」。
  ipcMain.handle('portrait:hide', (_e, scope: unknown, assetId: unknown) =>
    portraitRpc(() => hideAsset(toAssetId(assetId), toScope(scope))),
  )
  ipcMain.handle('portrait:purge', (_e, scope: unknown, assetId: unknown) =>
    portraitRpc(() => purgeAsset(toAssetId(assetId), toScope(scope))),
  )

  ipcMain.handle('portrait:patch', (_e, scope: unknown, assetId: unknown, patch: unknown) =>
    portraitRpc(() => patchAsset(toAssetId(assetId), toPatch(patch), toScope(scope))),
  )

  ipcMain.handle('portrait:ensure', (_e, scope: unknown, input: unknown) =>
    portraitRpc(() => ensureAsset(toEnsureInput(input), toScope(scope))),
  )

  // 同步的下游也包成信封:渲染层不该为了一条通道换一种返回形状,而 `lookupAssetBinding`
  // 读盘失败时照样会抛(它内部吞了 JSON 解析,但 `app.getPath` 不吞)。
  ipcMain.handle('portrait:lookup-binding', (_e, scope: unknown, url: unknown) =>
    portraitRpc(() => lookupAssetBinding(toAssetUrl(url), toScope(scope))),
  )

  // 清缓存是**全局**的(切池 / 登出 / 手动刷新),刻意不带 scope:按池清会把刚切走的
  // 那个池的负缓存留下,而那恰恰是最该重查的一个 ——「不属于当前池」正是 403 最常见的成因。
  ipcMain.handle('portrait:clear-resolution-cache', () =>
    portraitRpc(() => {
      clearAssetResolutionCache()
      return null
    }),
  )

  return () => {
    for (const ch of PORTRAIT_CHANNELS) {
      ipcMain.removeHandler(ch)
    }
  }
}

// 平台人像库的数据源适配层 —— 渲染层与 `window.electronAPI.portraitLibrary` 之间唯一的一层。
//
// 三件事:
//
//  1. **把两种失败收成同一种。** 主进程刻意回信封而不裸抛,但桥本身仍可能 reject
//     (preload 没挂上、方法不存在、IPC 断开)。调用点全是组件里的 `void handleX()`,
//     所以判失败必须**同时看 rejected 与 `ok === false`** —— 只看其中一个,另一个
//     就成了 unhandled rejection(vitest 因此判整轮失败,生产里用户一句提示都没有)。
//
//  2. **把 error code 翻成动作。** 翻译表在 `platformPortraitCard.portraitErrorHint`,
//     这里只负责把 code 送进去。
//
//  3. **三个删除动作各占一个函数。** 不是一个带 flag 的 `remove(id, { purge })` ——
//     软删可恢复不释放配额、恢复之后必须重拉、彻底删除不可逆且是唯一能回收配额与
//     分页预算的操作。一个 boolean 传错就是数据事故,而三个函数名传错编译不过。
//
// **这里不做任何展示层过滤**:`Hidden` 条目原样带回(它同时用于解析画布上已有引用的
// `asset://`),非 `Active` 也原样带回。过滤在 `visibleCards`。

import type {
  PortraitAssetType,
  PortraitLibraryApi,
  PortraitRpc,
  PortraitScopeRef,
} from '../../../../types/portraitApi'
import {
  cardFromRegistered,
  portraitCardsFromPlatform,
  portraitErrorHint,
  rejectUploadReason,
  type PortraitCard,
} from './platformPortraitCard'

/** 后端 `name` 的硬上限:`POST` 静默截断,`PATCH` 直接 400。两边都自己先截。 */
const NAME_MAX_LENGTH = 64

export type PortraitOpResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string }

export interface PortraitCardPage {
  cards: PortraitCard[]
  /** ⚠️ 不等于 `cards.length`。要显示「N 可用」请自己数 `status === 'Active'`。 */
  totalCount: number
  hiddenCount: number
  /** 素材过多、上游分页被截断,列表并不完整。 */
  truncated: boolean
}

function bridge(): PortraitLibraryApi | undefined {
  return (window as Window & { electronAPI?: { portraitLibrary?: PortraitLibraryApi } }).electronAPI
    ?.portraitLibrary
}

/**
 * 把一次调用收成 `PortraitOpResult`。
 *
 * `r.ok !== true` 而不是 `!r.ok`:桥回了 `undefined`(方法不存在时 `safeInvoke` 的
 * 退化形态)时前者会走失败分支,后者会在下一行读 `r.data` 时抛。
 */
async function call<T>(
  work: (api: PortraitLibraryApi) => Promise<PortraitRpc<T>>,
): Promise<PortraitOpResult<T>> {
  const api = bridge()
  if (!api) {
    return { ok: false, code: 'PORTRAIT_BRIDGE_MISSING', message: '人像库接口不可用(preload 未加载)' }
  }
  let r: PortraitRpc<T>
  try {
    r = await work(api)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, code: 'PORTRAIT_BRIDGE_FAILED', message: message || '人像库请求失败' }
  }
  if (!r || r.ok !== true) {
    const code = r?.ok === false ? r.error.code : 'MALFORMED_RESPONSE'
    const raw = r?.ok === false ? r.error.message : '人像库返回了无法识别的内容'
    return { ok: false, code, message: portraitErrorHint(code, raw) }
  }
  return { ok: true, data: r.data }
}

/**
 * 拉一页素材。
 *
 * 回收站与正常视图是上游的两次不同查询(`hidden=1`),不是同一份数据的两种过滤 ——
 * 但**正常视图回来的条目仍可能带 `Hidden: true`**(后端只打标不过滤),所以这里
 * 一条都不丢,由 `visibleCards` 在展示层分。
 */
export async function loadPortraitCards(
  scope: PortraitScopeRef,
  opts: { trash: boolean },
): Promise<PortraitOpResult<PortraitCardPage>> {
  const r = await call((api) => api.list(scope, opts.trash ? { hidden: true } : undefined))
  if (!r.ok) return r
  return {
    ok: true,
    data: {
      cards: portraitCardsFromPlatform(r.data.Items ?? []),
      totalCount: r.data.TotalCount ?? 0,
      hiddenCount: r.data.HiddenCount ?? 0,
      truncated: r.data.Truncated === true,
    },
  }
}

/**
 * 本地文件入库 —— **两步,串行**。
 *
 * ```
 * ① upload(字节)  → 永久 COS 链 + 已归一的 assetType
 * ② register(①的 url, ①的 assetType)
 * ```
 *
 * 🚨 `data` 必须是 `ArrayBuffer`:`File`/`Blob` 过不了结构化克隆,到主进程是个 `{}`,
 * 上传照发但 0 字节,隔一整个网络往返才换回一句 400。
 *
 * 体积闸在 `file.arrayBuffer()` **之前** —— 之后就晚了,那一刻整份字节已经在内存里,
 * 递出去还要再复制一遍过 IPC。
 */
export async function uploadAndRegister(
  scope: PortraitScopeRef,
  file: File,
): Promise<PortraitOpResult<PortraitCard>> {
  const rejected = rejectUploadReason({ name: file.name, type: file.type, size: file.size })
  if (rejected) return { ok: false, code: 'FILE_REJECTED_LOCALLY', message: rejected }

  let data: ArrayBuffer
  try {
    data = await file.arrayBuffer()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, code: 'FILE_READ_FAILED', message: `读取「${file.name}」失败:${message}` }
  }

  const uploaded = await call((api) =>
    api.upload(scope, { data, filename: file.name, mimeType: file.type }),
  )
  if (!uploaded.ok) return uploaded

  const assetType: PortraitAssetType = uploaded.data.assetType
  const registered = await call((api) =>
    api.register(scope, { url: uploaded.data.url, assetType, name: file.name }),
  )
  if (!registered.ok) return registered

  // 回包的三个 URL 都是刚提交的那条永久 COS 链,所以这张卡**立刻有图**,
  // 只缺元数据 —— 而名字、类型、上传时刻本来就在手上。
  return {
    ok: true,
    data: cardFromRegistered(registered.data, {
      name: file.name,
      assetType,
      createTime: new Date().toISOString(),
    }),
  }
}

/**
 * 「移出素材库」—— **软删**。不动上游、**不释放配额**,已引用它的 `asset://` 继续可用。
 *
 * UI 文案必须写「移出素材库」而不是「删除」,否则用户会困惑为什么删了还提示素材过多。
 */
export async function removeFromLibrary(
  scope: PortraitScopeRef,
  assetId: string,
): Promise<PortraitOpResult<null>> {
  const r = await call((api) => api.hide(scope, assetId))
  return r.ok ? { ok: true, data: null } : r
}

/**
 * 「从回收站恢复」。
 *
 * ⚠️ 成功之后**必须重拉列表** —— 恢复只回一个 `{ Id }`,本地手里那张卡的其余字段
 * (状态、上游可能已经改过的名字)都不保证还是对的。
 */
export async function restoreFromTrash(
  scope: PortraitScopeRef,
  assetId: string,
): Promise<PortraitOpResult<null>> {
  // `hidden: false` 是最容易被 falsy 判断吞掉的取值,而它恰好就是「恢复」那个动作。
  const r = await call((api) => api.patch(scope, assetId, { hidden: false }))
  return r.ok ? { ok: true, data: null } : r
}

/** 「彻底删除」—— 真删上游,**不可逆**,且是唯一能回收配额与列表分页预算的操作。 */
export async function deleteForever(
  scope: PortraitScopeRef,
  assetId: string,
): Promise<PortraitOpResult<null>> {
  const r = await call((api) => api.purge(scope, assetId))
  return r.ok ? { ok: true, data: null } : r
}

/** 重命名。**只发 `name`** —— 顺手带上 `hidden` 会把回收站里的素材悄悄恢复。 */
export async function renamePortraitAsset(
  scope: PortraitScopeRef,
  assetId: string,
  name: string,
): Promise<PortraitOpResult<null>> {
  const r = await call((api) => api.patch(scope, assetId, { name: name.slice(0, NAME_MAX_LENGTH) }))
  return r.ok ? { ok: true, data: null } : r
}

/**
 * 等一条素材就绪并回一张更新过的卡片。
 *
 * **服务端长轮询**(一次请求最长 90s),不要在外面再包 `setInterval`;已是终态时
 * 后端短路直接返回,所以对已就绪的素材这只是一次快往返。
 */
export async function awaitCardReady(
  scope: PortraitScopeRef,
  assetId: string,
): Promise<PortraitOpResult<PortraitCard>> {
  const r = await call((api) => api.poll(scope, assetId))
  if (!r.ok) return r
  const [card] = portraitCardsFromPlatform([r.data])
  if (!card) {
    return { ok: false, code: 'MALFORMED_RESPONSE', message: '人像库返回了无法识别的素材' }
  }
  return { ok: true, data: card }
}

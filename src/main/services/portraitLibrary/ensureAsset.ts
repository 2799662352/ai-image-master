// 「这张图在当前计费池里,有没有一个可用的 `asset://` id?没有就去弄一个。」
//
// 这一层只回答那一个问题。HTTP 形状归 `platformAssets.ts`,IPC 信封归 `auth/ipc.ts`。
//
// ── 为什么 asset id 必须和 pool 成对存 ──────────────────────────────────────
//
// 上游把 group 按 `project-<id>` / `project-<id>-pp-<ppId>` **懒创建**,一个 pool 下
// 登记的 asset 在另一个 pool 下**读不出来** —— 不是陈旧,是不存在:
//
//   shortdrama-mvp/src/lib/portrait/library.ts:10-13
//    * Registration is scoped to a billing project: the group is created lazily as
//    * `project-<id>`, and an asset registered under one pool does not resolve for
//    * a request billed to another. That is why the pool is stored next to the id.
//
// 只存 assetId 会串号:换个池就把别人的 id 发出去,上游拒是走运,静默用错素材是更糟的
// 那一半。而**池键是两半** —— `projectId` 与 `producerProjectId`。两个不同的 producer
// project 可以共用一个 `projectId`,只按 `projectId` 认会把两个池悄悄合并
// (同一条教训见 `auth/session.ts:170-175`)。
//
// ── 持久化形状:`url → 每个池一条`,且池键保持结构化 ────────────────────────
//
//   { "bindings": { "<公网 URL>": [ { projectId, producerProjectId?, assetId }, … ] } }
//
// 三个决定,各有理由:
//
//   1. **键是源图的公网 URL**。生成图落 COS 后就有永久链,那是这张图在跨进程、跨重启
//      之后仍然认得出来的唯一自然标识(本地路径会变,内存里的对象 id 活不过重启)。
//      **刻意不做归一化**(不剥 query):剥多了 `?imageMogr2/thumbnail/400x` 的缩略图
//      会和原图撞成一条,剥少了等于没剥 —— 猜哪些 query 承载身份,猜错的代价比偶尔
//      多登记一次大。调用方知道自己拿的是签名链时,应该传那条永久链。
//
//   2. **一张图对多条绑定**,而不是 `url → id`。同一张脸在「个人池」和「工作室池」下
//      各有一个 id,两条都有效、都该留着 —— 用户在两个池之间来回切是常态,顶掉另一条
//      等于每切一次就重新登记一次。
//
//   3. **池键在盘上保持两个数字,不压成 `"42:7"` 这种派生串**。派生串是**有损**的:
//      哪天有人把 `poolKey()` 写成只取 `projectId`,文件看上去照样合法,两个池就此
//      静默合并且**再也分不开** —— 而这正是本模块存在的理由那个 bug。留着两个字段,
//      同样的错误至多让比较逻辑出错(那有测试兜),盘上的数据仍然是可诊断、可修复的。
//      (进程内那两个缓存用派生串是另一回事:它们不落盘、不给人读、当场算当场丢。)

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { AuthError } from '../auth/httpJson'
import {
  getAsset,
  pollAsset,
  registerAsset,
  type PlatformAsset,
  type PlatformAssetScope,
  type PlatformAssetType,
} from './platformAssets'

const FILENAME = 'portrait-asset-bindings.json'

/**
 * 负缓存的存活时间。
 *
 * 网页版那份是会话级的裸 `Set`(`sora-ui/src/stores/volcengineAssetStore.ts:42`),
 * 因为浏览器标签页的「会话」以小时计。桌面端的会话以**天**计:403 的常见成因是
 * 「还没加入那个组织」,用户去加入了,而缓存要等到他重启 app 才松口 —— 补救措施是
 * 「重启」的 bug 比多打一次接口贵。
 */
export const MISSING_TTL_MS = 5 * 60_000

/** 上游终态。其余(含 `undefined`)一律按「还在处理中」处置。 */
const READY = 'Active'
const FAILED = 'Failed'

export interface AssetBinding {
  projectId: number
  producerProjectId?: number
  assetId: string
}

interface BindingState {
  bindings: Record<string, AssetBinding[]>
}

export interface EnsureAssetInput {
  /** 源图的公网 URL。必须是上游拉得到的地址,本地路径要先过 `uploadMedia`。 */
  url: string
  name?: string
  /** 默认 `Image`。大小写敏感,拼错会被上游静默降级(见 `platformAssets`)。 */
  assetType?: PlatformAssetType
}

// ── 池键 ────────────────────────────────────────────────────────────────────

/** 归一化后的池键,与线路上实际发出的那两个头一一对应。 */
type Pool = Pick<AssetBinding, 'projectId' | 'producerProjectId'>

/**
 * `producerProjectId: 0` 与「没给」同义 —— 与 `platformAssets.scopeHeaders` 的 `ppId > 0`
 * 同一口径。两边不一致的后果不是报错,是**缓存与线路对不上**:请求打的是 42 号池,
 * 绑定却记在「42 + pp0」这个线上不存在的池上,于是每一次都重新登记。
 */
function normalizePool(scope: PlatformAssetScope): Pool {
  const pp = scope.producerProjectId
  return {
    projectId: scope.projectId,
    ...(typeof pp === 'number' && pp > 0 ? { producerProjectId: pp } : {}),
  }
}

/** 两半都要相等。少比一半就是本文件顶部那个串号 bug。 */
function samePool(binding: AssetBinding, pool: Pool): boolean {
  return (
    binding.projectId === pool.projectId && binding.producerProjectId === pool.producerProjectId
  )
}

/** 进程内缓存的键。**不落盘**,所以派生串在这里是安全的(理由见文件顶部第 3 条)。 */
function poolKey(pool: Pool): string {
  return `${pool.projectId}:${pool.producerProjectId ?? ''}`
}

// ── 持久化 ──────────────────────────────────────────────────────────────────

let cached: BindingState | null = null

function filePath(): string {
  return path.join(app.getPath('userData'), FILENAME)
}

function isBinding(v: unknown): v is AssetBinding {
  if (typeof v !== 'object' || v === null) return false
  const b = v as Partial<AssetBinding>
  if (typeof b.assetId !== 'string' || !b.assetId) return false
  if (typeof b.projectId !== 'number' || !Number.isFinite(b.projectId)) return false
  return b.producerProjectId === undefined || typeof b.producerProjectId === 'number'
}

/**
 * 坏条目**按条丢**,不整体丢弃。
 *
 * 整体丢弃的代价不是「少一条缓存」,而是每一张图在每一个池里都重新登记一遍 ——
 * 上游多出等量的副本、等量的配额占用,而配额只有显式 purge 才回收。
 */
function read(): BindingState {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8')) as Partial<BindingState>
    const raw = parsed.bindings
    if (typeof raw !== 'object' || raw === null) return { bindings: {} }
    const bindings: Record<string, AssetBinding[]> = {}
    for (const [url, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue
      const kept = list.filter(isBinding)
      if (kept.length > 0) bindings[url] = kept
    }
    return { bindings }
  } catch {
    return { bindings: {} }
  }
}

function state(): BindingState {
  if (!cached) cached = read()
  return cached
}

/**
 * 写盘失败只 warn。这份文件是**加速器不是真相** —— 丢了最坏的结果是下次重新登记一遍,
 * 而为它抛异常会把一次「用户主目录只读」变成「视频生成用不了」。
 */
function commit(next: BindingState): void {
  cached = next
  try {
    fs.writeFileSync(filePath(), JSON.stringify(next, null, 2), 'utf8')
  } catch (e) {
    console.warn('[portrait/bindings] write failed:', e)
  }
}

/** 当前池下这张图的 asset id。只读,不发请求。 */
export function lookupAssetBinding(url: string, scope: PlatformAssetScope): string | null {
  const pool = normalizePool(scope)
  return state().bindings[url]?.find((b) => samePool(b, pool))?.assetId ?? null
}

function putBinding(url: string, pool: Pool, assetId: string): void {
  const cur = state().bindings
  // 同池只留一条:写路径做去重,读路径就不必猜「两条同池的绑定哪条算数」。
  const others = (cur[url] ?? []).filter((b) => !samePool(b, pool))
  commit({ bindings: { ...cur, [url]: [...others, { ...pool, assetId }] } })
}

function dropBinding(url: string, pool: Pool): void {
  const cur = state().bindings
  const rest = (cur[url] ?? []).filter((b) => !samePool(b, pool))
  const bindings = { ...cur }
  if (rest.length > 0) bindings[url] = rest
  else delete bindings[url]
  commit({ bindings })
}

// ── ensure ──────────────────────────────────────────────────────────────────

/** 上游「这个 id 在这个池里取不到」。不属于当前池与已被彻底删除同码,处置也相同。 */
function isGone(e: unknown): boolean {
  const status = (e as { status?: unknown })?.status
  return status === 404 || status === 403
}

/**
 * 等就绪。`pollAsset` 是**服务端长轮询**(一次请求,后端在里面循环等),不要在外面
 * 再包 setInterval。
 *
 * 拿不到就抛,**绝不回落成图片 URL**:
 *
 *   shortdrama-mvp/src/app/api/segments/[id]/video/route.ts:256-264
 *    // No silent downgrade to the image URL. The portrait library is what holds
 *    // a face across shots, and a render that quietly used the weaker channel
 *    // would come back subtly wrong — a different person in the same costume —
 *    // which costs more than the wait.
 *
 * 这也是本函数返回 `void` 而不是 `boolean` 的原因:给调用方一个「没就绪」的返回值,
 * 就是给它一条把 URL 塞回去的路。
 *
 * `ASSET_NOT_READY` 与 `ASSET_FAILED` 分成两个码:前者重试有用,后者是上游对这张图的
 * 终态判决,重试只会再造一份垃圾。UI 要能说出「换一张」而不是「稍等」。
 * (这两个码没有对应的 HTTP 响应,409 是本地合成的:资源在、但状态不允许这次使用。)
 */
async function waitReady(assetId: string, scope: PlatformAssetScope): Promise<void> {
  const asset = await pollAsset(assetId, scope)
  if (asset.Status === READY) return
  if (asset.Status === FAILED) {
    throw new AuthError('ASSET_FAILED', 409, '这张素材在上游处理失败了,请换一张或重新导入')
  }
  throw new AuthError('ASSET_NOT_READY', 409, '素材还在处理中,请稍等几秒后重试')
}

/**
 * 同一张图 + 同一个池的并发去重。
 *
 * 一次多镜提交里同一张脸出现在好几个镜头上是常态,而重复登记不是「多打一次接口」——
 * 它在上游留下一份**真实的副本**,占配额、占列表分页预算,且只有显式 purge 能收回。
 */
const inFlightEnsure = new Map<string, Promise<string>>()

/**
 * 当前计费池下这张图可用的 `asset://` id;没有就现登记一个。
 *
 * ```
 * 读缓存 → 校验池键两半都相等(不等 = 不存在,不是陈旧)
 *        → 无效则 registerAsset
 *        → 立刻落库(不等就绪就存)
 *        → 每次都 pollAsset 等就绪(**包括复用旧 id 时**)
 *        → 等不到 → 抛,绝不降级成图片 URL
 * ```
 */
export async function ensureAsset(
  input: EnsureAssetInput,
  scope: PlatformAssetScope,
): Promise<string> {
  const pool = normalizePool(scope)
  const key = `${poolKey(pool)}|${input.url}`
  const running = inFlightEnsure.get(key)
  if (running) return running

  const task = ensureOnce(input, scope, pool).finally(() => inFlightEnsure.delete(key))
  inFlightEnsure.set(key, task)
  return task
}

async function ensureOnce(
  input: EnsureAssetInput,
  scope: PlatformAssetScope,
  pool: Pool,
): Promise<string> {
  const stored = state().bindings[input.url]?.find((b) => samePool(b, pool))?.assetId ?? null

  let assetId = stored
  if (!assetId) {
    const { Id } = await registerAsset(
      {
        url: input.url,
        assetType: input.assetType ?? 'Image',
        ...(input.name === undefined ? {} : { name: input.name }),
      },
      scope,
    )
    assetId = Id
    // **立刻落库,不等就绪。** id 签发那一刻就有效,只是早;这里丢掉它意味着每次重试
    // 都重新登记同一张图,上游因此多一份副本 —— 而配额只有显式 purge 才回收
    // (`shortdrama-mvp/src/lib/portrait/ensure.ts:58-64`)。
    putBinding(input.url, pool, assetId)
  }

  try {
    // **每次都等,包括复用旧 id 时。** 引用一个还在处理中的 asset 不是让效果变弱,是让
    // 整次提交被拒 —— 「我们有 id」不足以发出去。首次 wait 超时的 asset 否则会永久毒化
    // 后续每一次生成(`ensure.ts:67-72`)。
    //
    // 它比听起来便宜:后端在 `Status` 已是 Active/Failed 时直接返回、不进长轮询循环
    // (controller:401),所以复用路径上这是一个快往返,不是 90 秒。
    await waitReady(assetId, scope)
  } catch (e) {
    // 只驱逐**复用**的 id。「彻底删除」就在人像库 UI 上,删掉之后这条绑定指向一个不
    // 存在的 asset,不驱逐的话这张图在这个池里永远用不了、而用户没有任何补救 ——
    // 驱逐后下一次调用会重新登记,所以「稍等重试」这句话届时真的有用。
    //
    // 刚登记的 id 就 404 则**不**驱逐:那更可能是上游的传播竞态,而立刻重登记会在每次
    // 失败上再叠一个孤儿。它仍然自愈,只是慢一步 —— 下一次调用时它已经是「复用的 id」,
    // 走上面那条路。
    if (stored && isGone(e)) dropBinding(input.url, pool)
    throw e
  }
  return assetId
}

// ── resolveAsset:单查的两件缓存(Task 1 的客户端刻意不含缓存) ──────────────

/**
 * 两件缓存都**按池分开**。
 *
 * 网页版的 `missingIds` 是个裸 `Set<string>`(`volcengineAssetStore.ts:42`),靠 store
 * 自己在切项目时调 `clearAssetResolutionCache()` 兜住 —— 它能这么写,是因为项目选择
 * 就在它手里。本模块是主进程的叶子:`scope` 每次调用现传,它**永远不会知道池换了**。
 * 照抄那个形状的后果是,一个 id 在 A 池 404 之后在 B 池也被判缺失 —— 而「不属于当前池」
 * 恰恰是 404/403 最常见的成因,等于把最该重查的那种情况变成永不重查。
 */
const inFlightGet = new Map<string, Promise<PlatformAsset | null>>()
const missingUntil = new Map<string, number>()

/** 池切换 / 登出 / 手动刷新时清空。 */
export function clearAssetResolutionCache(): void {
  inFlightGet.clear()
  missingUntil.clear()
}

/**
 * 按 id 兜底解析一条素材(列表里没有时才用)。取不到回 `null`,不抛。
 *
 * 与 `ensureAsset` 的「绝不降级」不矛盾:那条约束管的是**提交前**的必需品,这里是
 * 缩略图/元数据的展示,拿不到就是一张占位图,不会让渲染悄悄用错素材。
 */
export async function resolveAsset(
  assetId: string,
  scope: PlatformAssetScope,
): Promise<PlatformAsset | null> {
  const key = `${poolKey(normalizePool(scope))}|${assetId}`

  const until = missingUntil.get(key)
  if (until !== undefined) {
    if (Date.now() < until) return null
    missingUntil.delete(key)
  }

  const running = inFlightGet.get(key)
  if (running) return running

  const task = (async () => {
    try {
      return await getAsset(assetId, scope)
    } catch (e) {
      // 只负缓存「这个 id 在这个池里取不到」与彻底问不到(网络断)。
      // **5xx / 超时不进** —— 那是上游此刻不舒服,不是 id 不存在;缓存它等于把一次抖动
      // 放大成 TTL 那么久的假性缺失,而缺失在展示层就是一张裂图。
      const status = (e as { status?: unknown })?.status
      if (isGone(e) || typeof status !== 'number') {
        missingUntil.set(key, Date.now() + MISSING_TTL_MS)
      }
      console.warn('[portrait/bindings] resolve by id failed:', assetId, e)
      return null
    } finally {
      inFlightGet.delete(key)
    }
  })()
  inFlightGet.set(key, task)
  return task
}

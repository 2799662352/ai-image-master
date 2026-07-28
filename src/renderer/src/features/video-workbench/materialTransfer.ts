// 外链素材转存 —— 把用户/agent 挂进工作台的第三方图片地址换成我们自己的副本。
//
// 为什么需要:渲染端是**直连**那个第三方图床的(`materialThumbTarget` 对图片
// 素材返回 src,`useResolvedMediaSrc` 对非本地路径原样透传),对方慢或不可达时
// `<img>` 就 onError 退回文件名占位 —— 这正是「挂了 X 图不出缩略图」的成因。
// 而且提交生成时主进程的 `resolveMediaUrl` 对 http(s) 同样原样透传,等于把
// 「这张图能不能用」押在第三方服务器上。
//
// 做法是复用生成图片那条已经存在、且已带重试的主进程管道:
// `cos:enqueue-upload-from-url` → 主进程抓字节(fetchImageBytes,失败退避重试)
// → 落本地副本 → 传 COS → 事件回推。拿到 COS 地址后把素材的 src 换掉,缩略图
// 与提交从此都不依赖对方。
//
// 全程 fire-and-forget:转存失败不影响这张素材继续以外链形式使用。

import { isCosUrl } from '../../utils/cosThumb'
import { enqueueCosUpload, registerCosUploadHandler, type CosResult } from '../../utils/cosUploadDispatcher'
import type { MaterialKind } from './cardSpec'

/** 转存请求的 requestId 前缀(事件按它路由回本模块)。 */
const SOURCE = 'vwmaterial'

/**
 * 这个素材源需要转存吗?
 *
 * 只认第三方 http(s):我们自己的 COS 已经是持久地址,再传一遍纯属浪费;
 * 本地路径 / data: / blob: / asset:// 都不经第三方,渲染与提交各有既有通路。
 */
export function isTransferableMaterialSrc(src: string): boolean {
  if (typeof src !== 'string') return false
  const trimmed = src.trim()
  if (!/^https?:\/\//i.test(trimmed)) return false
  return !isCosUrl(trimmed)
}

export interface MaterialTransferTarget {
  cardId: string
  kind: MaterialKind
  /** 转存发起时的原始外链 —— 回填时按它匹配素材(下标会因增删改变)。 */
  originalSrc: string
}

/** 按 requestId 记住「这次转存是给哪张卡的哪条素材」。 */
const pending = new Map<string, MaterialTransferTarget>()

let nextId = 0

/**
 * 发起一次转存。同步返回,不持有 promise。
 * 已经是持久地址的素材直接跳过。
 */
export function startMaterialTransfer(target: MaterialTransferTarget, name: string): void {
  if (!isTransferableMaterialSrc(target.originalSrc)) return
  const id = `${Date.now().toString(36)}-${nextId++}`
  pending.set(id, target)
  enqueueCosUpload(id, target.originalSrc, { source: SOURCE, name })
}

export type MaterialTransferApply = (target: MaterialTransferTarget, cosUrl: string) => void

/**
 * 装载结果回调。store 传入它自己的更新函数 —— 本模块不反向 import store,
 * 免得和 store 互相引用。
 */
export function mountMaterialTransferHandler(apply: MaterialTransferApply): () => void {
  return registerCosUploadHandler(`${SOURCE}:`, (result: CosResult) => {
    const id = result.requestId.slice(SOURCE.length + 1)
    const target = pending.get(id)
    if (!target) return
    pending.delete(id)
    // 失败就保持外链原样:它也许仍能加载,至少不比现在差。
    if (!result.success) return
    apply(target, result.url)
  })
}

/** 测试用:清空未完成的转存登记。 */
export function resetMaterialTransfersForTest(): void {
  pending.clear()
}

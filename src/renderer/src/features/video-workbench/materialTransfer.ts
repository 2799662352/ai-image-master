// 素材转存 —— 把挂进工作台的「不属于我们的地址」换成我们自己的 COS 副本。
//
// 两类源要换,理由不同:
//
// ① **第三方外链**:渲染端是**直连**那个第三方图床的(`materialThumbTarget` 对图片
//    素材返回 src,`useResolvedMediaSrc` 对非本地路径原样透传),对方慢或不可达时
//    `<img>` 就 onError 退回文件名占位 —— 这正是「挂了 X 图不出缩略图」的成因。
//    而且提交生成时主进程的 `resolveMediaUrl` 对 http(s) 同样原样透传,等于把
//    「这张图能不能用」押在第三方服务器上。
//
// ② **内联 data:**(粘贴的图、高级编辑拍平的标注帧):它不依赖任何人,但会把整段
//    base64 拖进 IndexedDB,还会让提交与人像库登记各自中转一遍同一批字节。
//    详见 isTransferableMaterialSrc 的说明。
//
// 做法是复用生成图片那条已经存在、且已带重试的主进程管道:外链走
// `cos:enqueue-upload-from-url`(主进程自己抓字节,失败退避重试),内联字节走
// `cos:enqueue-upload-bytes`(ArrayBuffer 结构化克隆,base64 字符串不跨进程)
// → 落本地副本 → 传 COS → 事件回推。拿到 COS 地址后把素材的 src 换掉,缩略图
// 与提交从此都不依赖对方。
//
// 全程 fire-and-forget:转存失败不影响这张素材继续以原样使用。

import { isCosUrl } from '../../utils/cosThumb'
import {
  enqueueCosUpload,
  enqueueCosUploadBytes,
  registerCosUploadHandler,
  type CosResult,
} from '../../utils/cosUploadDispatcher'
import type { MaterialKind } from './cardSpec'

/** 转存请求的 requestId 前缀(事件按它路由回本模块)。 */
const SOURCE = 'vwmaterial'

/**
 * 这个素材源需要转存吗?
 *
 * ① **第三方 http(s)**:别把「这张图能不能用」押在对方服务器上。我们自己的 COS
 *    已经是持久地址,再传一遍纯属浪费。
 * ② **内联 data: 图片**:必须换掉,否则预传(只认本地路径)和转存(原本只认外链)
 *    会双双跳过,于是四件事同时发生而一个错都不报——整段 base64 落进 IndexedDB
 *    (base64 还要再胖三分之一);提交时 `resolveMediaUrl` 才发现它超过 512KB 去
 *    中转,那份等待正好落在用户按下「生成」的一刻;生成后的人像库登记又把同一批
 *    字节中转第二遍。换成 https 之后这些一起消失。
 *
 *    刻意**不设体积下限**。「小图反正会内联提交,转它多此一举」听着成立,但
 *    「base64 留在库里」和「人像库登记要单独中转」这两笔账与大小无关,而一次小
 *    上传的代价可以忽略。
 *
 *    **只认 image/**:主进程那条 fire-and-forget 字节通道是图片专用的 ——
 *    `cos:enqueue-upload-bytes` 把非 image/* 的 mime 一律改写成 image/png,一条
 *    mp4 会被存成 `.png`、带 image/png 的 Content-Type 上 COS,而 src 还被换成那个
 *    地址:看着转存成功,实际是一份坏素材。视频/音频的内联字节因此原样留着,提交时
 *    由 `resolveMediaUrl → relayDataUrlToCos` 按真实 mime 中转(那条路 mime 是诚实
 *    的,EXT_BY_MIME 收了 mp4/mov/webm/mp3/wav)。要让它们也享受提前转存,得先有一条
 *    mime 诚实的渲染端入口,而不是把它们塞进图片通道。
 *
 * 本地路径走预传(materialPreupload),blob:/asset:// 各有既有通路,都不在这里管。
 */
export function isTransferableMaterialSrc(src: string): boolean {
  if (typeof src !== 'string') return false
  const trimmed = src.trim()
  if (/^data:/i.test(trimmed)) return /^data:image\//i.test(trimmed)
  if (!/^https?:\/\//i.test(trimmed)) return false
  return !isCosUrl(trimmed)
}

/**
 * `data:<mime>;base64,<payload>` → 原始字节。解不开返回 null,调用方跳过转存 ——
 * 卡片继续用内联那份,转存从来都是纯优化。
 */
function decodeDataUrl(dataUrl: string): { bytes: ArrayBuffer; mime: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/is.exec(dataUrl)
  if (!match) return null
  try {
    const binary = atob(match[2])
    if (binary.length === 0) return null
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return { bytes: bytes.buffer, mime: match[1] }
  } catch {
    return null
  }
}

export interface MaterialTransferTarget {
  cardId: string
  kind: MaterialKind
  /** 转存发起时的原始地址 —— 回填时按它匹配素材(下标会因增删改变)。 */
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
  const src = target.originalSrc.trim()
  const id = `${Date.now().toString(36)}-${nextId++}`

  // 内联字节走**字节通道**:ArrayBuffer 结构化克隆,两侧都不占 V8 字符串堆。
  // 与批量/生成页那次 P0 闪退修复同一条路(见 cosUploadDispatcher)。
  if (/^data:/i.test(src)) {
    const decoded = decodeDataUrl(src)
    if (!decoded) return
    // 入队失败(老 preload 没有字节通道)就别登记 —— 登记了却永远等不到回调
    // 就是一条泄漏,而卡片用内联那份本来也能跑。
    if (enqueueCosUploadBytes(id, decoded.bytes, decoded.mime, { source: SOURCE, name })) {
      pending.set(id, target)
    }
    return
  }

  // 外链让主进程自己去抓,渲染端连字节都不必碰。
  pending.set(id, target)
  enqueueCosUpload(id, src, { source: SOURCE, name })
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
    // 失败就保持原样:外链也许仍能加载,内联那份本来就能用,至少不比现在差。
    if (!result.success) return
    apply(target, result.url)
  })
}

/** 测试用:清空未完成的转存登记。 */
export function resetMaterialTransfersForTest(): void {
  pending.clear()
}

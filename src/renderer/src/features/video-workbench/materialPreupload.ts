// 本地参考图「拖入即传」—— 把上传挪进用户写提示词的那段时间。
//
// 为什么值得做:工作台此前只把**本地绝对路径**记在卡片上,一直等到提交才由主进程
// `buildContent` → `resolveMediaUrl` 逐张传。9 张参考图几十 MB 的上传于是整块压在
// 「点了生成」和「任务真的建起来」之间;store 自己在 startCards 里就写过,一板卡片
// 「轻易堆到几分钟」。而这段时间用户本来就在打字,拿来传文件是白捡的。
//
// 与隔壁 materialTransfer 的分工(两者很容易混):
// - 转存(transfer)针对**第三方外链**,目的是别把「这张图能不能用」押在对方服务器上,
//   做法是**换掉 src**;
// - 预传(preupload,本模块)针对**本地路径**,目的纯粹是省提交时的等待,做法是
//   **另挂 uploadedUrl**、src 原样留着 —— 预传没跑完 / 跑挂了,提交都照旧走主进程
//   那条路。所以它是纯优化,不引入新的失败模式。
//
// 发起点由 store 决定(`startPreuploadsFor` / `resumePreuploadsForBoard`):拖入、
// agent 加卡换素材,以及**重启和切页**。地址不落库(可能是死链),所以重启后是
// 重新传一遍拿新地址,而不是把上次的存下来。
//
// 用的是 `attachments.resolveRefMedia`(MCP 生图 `resolveRefImage` 的同源兄弟,白名单
// 放宽到图片/视频/音频):给主进程一个**路径**,主进程从磁盘**流式**传 COS,整个文件
// 既不进 Node Buffer 也不进渲染进程堆。刻意不照抄批量生成页的
// `uploadRefImageOriginalFirst` —— 那条先把整个文件读成未压缩 base64 塞进渲染进程再过
// IPC,12MB 的图就是 16MB 的字符串。Electron 官方对 IPC 也是同一口径:参数走结构化
// 克隆,大字节应当留在主进程用 createReadStream 流式处理,跨进程只传路径。
//
// 并发不用本模块管:底层 `relayFileToCos` 有 4 路全局闸,渲染端一次发几十个 invoke
// 也只会在主进程排队。
//
// 全程 fire-and-forget:失败只是回到今天的行为,不弹错、不拦用户。
//
// 有一个刻意不处理的浪费:拖进去立刻点生成,预传还在路上,提交就会拿 src 让主进程
// 再传一次,同一个文件传了两遍(后到的预传结果没人用)。要消掉它得让提交去 await
// 在途的预传 —— 那等于把等待又搬回点击之后,正好是本模块要解决的那件事。多传一次
// 的代价远小于让用户重新等。

import type { MaterialKind } from './cardSpec'

type ResolveResult = { ok: true; url: string } | { ok: false; reason: string }

type PreuploadApi = {
  attachments?: {
    resolveRefMedia?: (p: string) => Promise<ResolveResult>
  }
}

function getApi(): PreuploadApi | undefined {
  return (window as Window & { electronAPI?: PreuploadApi }).electronAPI
}

/**
 * 这个素材源需要预传吗?
 *
 * 只认**本地路径**:https 已经是可提交地址,data: 内联本来就没有上传这一步,
 * asset:// 是人像库的上游引用,blob:/file: 主进程读不到。
 *
 * 判空不能用「有没有 `xxx:` 前缀」—— Windows 盘符 `D:\pics\a.png` 会被当成
 * scheme 为 `D` 的 URL 一起误杀。所以只按显式的 scheme 列表排除。
 */
export function isPreuploadableMaterialSrc(src: string): boolean {
  if (typeof src !== 'string') return false
  const trimmed = src.trim()
  if (trimmed.length === 0) return false
  return !/^(https?|data|asset|blob|file):/i.test(trimmed)
}

export interface MaterialPreuploadTarget {
  cardId: string
  kind: MaterialKind
  /** 发起预传时的本地路径 —— 回填按它匹配(下标会因增删改变)。 */
  originalSrc: string
}

/**
 * 一次预传的结果。**发起时也回报一次**(`uploading`),界面才画得出转圈 ——
 * 只回报成功的话,「在传」「传失败」「根本不用传」在界面上是同一个样子。
 */
export type MaterialPreuploadOutcome =
  | { state: 'uploading' }
  | { state: 'uploaded'; url: string }
  | { state: 'failed'; reason: string }

export type MaterialPreuploadApply = (
  target: MaterialPreuploadTarget,
  outcome: MaterialPreuploadOutcome,
) => void

let apply: MaterialPreuploadApply | null = null

/**
 * 发起一次预传。同步返回,不持有 promise。
 *
 * **同一路径出现两次就发两次**,各拿各的地址。省一次上传听着划算,但上游按下标
 * 解析 `@参考N`(Seedance OpenAPI §2.3),两个槽位共用一个地址有可能被折叠成一个
 * 参考 —— 后面的编号全体前移,画面看着「像那么回事」,不报任何错。同款理由让
 * `mediaResolve` 里那版「按路径缓存中转结果」的优化被撤掉过一次。
 */
export function startMaterialPreupload(target: MaterialPreuploadTarget): void {
  if (!isPreuploadableMaterialSrc(target.originalSrc)) return
  const resolve = getApi()?.attachments?.resolveRefMedia
  if (!resolve) return
  apply?.(target, { state: 'uploading' })
  void resolve(target.originalSrc)
    .then((result) => {
      // 失败不影响能否出片:src 还在,提交时主进程照旧上传。但要让界面知道,
      // 否则转圈会一直转下去。
      if (!result.ok) {
        console.warn(`[vwPreupload] 预传失败,提交时再传: ${target.originalSrc} (${result.reason})`)
        apply?.(target, { state: 'failed', reason: result.reason })
        return
      }
      // **只收 http(s)。** COS 不可达时主进程会对小文件降级成内联 data URL
      // (mediaResolve 的 relayOrInline),那对生图那条路是有用的兜底,对预传却是
      // 净亏:什么都没上传成,却往卡片状态里塞了一坨 base64 —— 而卡片对象在 store
      // 里每次更新都要浅拷贝一遍。丢掉它,回到「提交时主进程从磁盘现传」。
      if (!/^https?:\/\//i.test(result.url)) {
        apply?.(target, { state: 'failed', reason: 'COS 不可达,已降级为提交时上传' })
        return
      }
      apply?.(target, { state: 'uploaded', url: result.url })
    })
    .catch((err: unknown) => {
      apply?.(target, { state: 'failed', reason: err instanceof Error ? err.message : String(err) })
    })
}

/**
 * 装载回填回调。store 传入它自己的更新函数 —— 本模块不反向 import store,
 * 免得和 store 互相引用。
 */
export function mountMaterialPreuploadHandler(fn: MaterialPreuploadApply): () => void {
  apply = fn
  return () => {
    if (apply === fn) apply = null
  }
}

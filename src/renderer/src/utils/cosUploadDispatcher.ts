/**
 * cosUploadDispatcher — 真 fire-and-forget COS 上传调度器。
 *
 * 设计目标:
 *   - 调用方 0 promise / 0 .then 微任务: 触发后立即返回, 不持有任何上下文。
 *   - 上传成功/失败结果通过 main → renderer 的事件统一推回, 然后路由
 *     到每个 store 注册的回调上, 各 store 按自己的 id schema 更新状态。
 *   - 主进程负责所有 fetch / base64 / putObject / 并发控制, 渲染主线程
 *     全程不阻塞。
 *
 * 与 uploadImageUrlToCos 的区别:
 *   uploadImageUrlToCos 走 await IPC, 调用方拿得到返回值;
 *   本调度器是事件驱动, 调用方拿不到 promise — 适合 batch / generate
 *   这种"我只是告诉你存一下, 别拖累我"的场景。
 */

export type CosResult =
  | { requestId: string; success: true; url: string; key: string; localPath?: string }
  | { requestId: string; success: false; error: string; localPath?: string }

interface ElectronAPILike {
  cos?: {
    enqueueUploadFromUrl?: (
      requestId: string,
      sourceUrl: string,
      mimeType?: string,
      metadata?: Record<string, unknown>,
    ) => Promise<{ queued: true } | { queued: false; error: string }>
    enqueueUploadBytes?: (
      requestId: string,
      bytes: ArrayBuffer,
      mimeType?: string,
      metadata?: Record<string, unknown>,
    ) => Promise<{ queued: true } | { queued: false; error: string }>
    onUploadResult?: (cb: (result: CosResult) => void) => () => void
  }
}

function getBridge(): ElectronAPILike['cos'] | undefined {
  const api = (window as unknown as { electronAPI?: ElectronAPILike }).electronAPI
  return api?.cos
}

// 每个 store / domain 注册一个前缀 + 处理函数。requestId 必须以前缀打头,
// 这样多个 store(useBatchStore / useGenerateStore)可以共用同一个事件流
// 而互不串扰。
type Handler = (result: CosResult) => void
const handlers: Array<{ prefix: string; fn: Handler }> = []
let listenerInstalled = false

function ensureListener(): void {
  if (listenerInstalled) return
  const bridge = getBridge()
  if (!bridge?.onUploadResult) return
  bridge.onUploadResult((result) => {
    for (const { prefix, fn } of handlers) {
      if (result.requestId.startsWith(prefix)) {
        try {
          fn(result)
        } catch (err) {
          console.error('[cosUploadDispatcher] handler threw:', err)
        }
        return
      }
    }
  })
  listenerInstalled = true
}

/**
 * 注册一个 domain handler。重复注册同前缀会覆盖。
 * 返回 unsubscribe(便于测试; 生产期不需要调用)。
 */
export function registerCosUploadHandler(prefix: string, fn: Handler): () => void {
  ensureListener()
  // 去重: 同前缀只保留最后一次注册, 避免热重载叠加多个 listener。
  for (let i = handlers.length - 1; i >= 0; i--) {
    if (handlers[i].prefix === prefix) handlers.splice(i, 1)
  }
  handlers.push({ prefix, fn })
  return () => {
    for (let i = handlers.length - 1; i >= 0; i--) {
      if (handlers[i].prefix === prefix && handlers[i].fn === fn) {
        handlers.splice(i, 1)
      }
    }
  }
}

/**
 * 入队一个 COS 上传请求。调用方传业务 id(item.id), 内部会包一个 prefix
 * 作为 requestId, 主进程上传完成后通过事件按 requestId 路由回业务 store。
 *
 * 这个函数本身 100% 同步返回(没有 await, 没有 .then), IPC 入队也设计为
 * 立即 resolve, 所以即使你忘了 await 也不会出问题。
 */
export function enqueueCosUpload(
  itemId: string,
  sourceUrl: string,
  metadata?: Record<string, unknown>,
): void {
  const bridge = getBridge()
  if (!bridge?.enqueueUploadFromUrl) {
    // 浏览器预览模式 / 老 preload: 直接吞掉, 不抛错。
    return
  }
  const source = typeof metadata?.source === 'string' ? metadata.source : 'unknown'
  const requestId = `${source}:${itemId}`
  // 故意 void: IPC promise resolve 只表示"入队成功", 不代表上传完成。
  // 调用方不关心入队结果, 上传结果走 onUploadResult 事件。
  void bridge.enqueueUploadFromUrl(requestId, sourceUrl, undefined, metadata)
}

/**
 * 字节版入队 (P0 闪退修复, 2026-07-09): 直接传 Blob 的二进制, 不再让
 * 40MB 级 base64 字符串跨 IPC。ArrayBuffer 走结构化克隆是原始字节拷贝,
 * 体积比 base64 小 25%, 且两侧都不占 V8 字符串堆。
 *
 * 与 enqueueCosUpload 一样是 fire-and-forget: 内部的 blob.arrayBuffer()
 * 是异步的, 但调用方无需等待 —— 上传结果统一走 onUploadResult 事件。
 * 旧 preload(无 enqueueUploadBytes)时回退 base64 通道, 保证版本错配可用。
 */
export function enqueueCosUploadBlob(
  itemId: string,
  blob: Blob,
  metadata?: Record<string, unknown>,
): void {
  const bridge = getBridge()
  if (!bridge) return
  const source = typeof metadata?.source === 'string' ? metadata.source : 'unknown'
  const requestId = `${source}:${itemId}`
  const mimeType = blob.type || undefined

  if (bridge.enqueueUploadBytes) {
    const send = bridge.enqueueUploadBytes
    void blob
      .arrayBuffer()
      .then((bytes) => send(requestId, bytes, mimeType, metadata))
      .catch((err) => console.warn('[cosUploadDispatcher] blob→bytes 入队失败:', err))
    return
  }

  if (bridge.enqueueUploadFromUrl) {
    // 降级通道: 老 preload 只认 sourceUrl 字符串, 只能转回 dataURL。
    const send = bridge.enqueueUploadFromUrl
    const fr = new FileReader()
    fr.onload = () => {
      void send(requestId, fr.result as string, mimeType, metadata)
    }
    fr.readAsDataURL(blob)
  }
}

/**
 * 已经握着字节时用这个,别再包一层 Blob。
 *
 * 调用方(如工作台的内联素材转存)是从 data: URL 解出来的 `ArrayBuffer`,
 * `enqueueCosUploadBlob` 会把它包成 Blob 再 `arrayBuffer()` 拆回来 —— 一次
 * 无谓的往返,而且 Blob 在 jsdom 里没有 `arrayBuffer()`,单测还得为它让路。
 *
 * 返回**是否真的入队**:字节通道不存在(老 preload / 浏览器预览)时返回 false,
 * 调用方据此决定是登记等回调还是干脆放弃 —— 登记了却永远等不到结果就是内存泄漏。
 */
export function enqueueCosUploadBytes(
  itemId: string,
  bytes: ArrayBuffer,
  mimeType?: string,
  metadata?: Record<string, unknown>,
): boolean {
  const send = getBridge()?.enqueueUploadBytes
  if (!send) return false
  const source = typeof metadata?.source === 'string' ? metadata.source : 'unknown'
  void send(`${source}:${itemId}`, bytes, mimeType, metadata)
  return true
}

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

type CosResult =
  | { requestId: string; success: true; url: string; key: string }
  | { requestId: string; success: false; error: string }

interface ElectronAPILike {
  cos?: {
    enqueueUploadFromUrl?: (
      requestId: string,
      sourceUrl: string,
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

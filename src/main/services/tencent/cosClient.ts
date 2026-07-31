import COS from 'cos-nodejs-sdk-v5'
import { getCredentials, onCredentialsInvalidated } from './credentials'
import { getStsCredentials, getMediaStsCredentials } from './stsCredentials'
import { getMediaAuth } from './mediaAuth'

type CosInstance = {
  putObject: (params: any, cb: any) => void
  sliceUploadFile: (params: any, cb: any) => void
  cancelTask: (id: string) => void
  getObjectUrl: (params: any, cb: any) => void
  deleteMultipleObject: (params: any, cb: any) => void
}

let cosInstance: CosInstance | null = null
let stsCosInstance: CosInstance | null = null
let mediaStsCosInstance: CosInstance | null = null

onCredentialsInvalidated(() => {
  cosInstance = null
})

function getCosInstance(): CosInstance {
  if (!cosInstance) {
    const creds = getCredentials()
    cosInstance = new (COS as any)({
      SecretId: creds.secretId,
      SecretKey: creds.secretKey,
      Protocol: 'https:',
      Timeout: 120000,
    })
  }
  return cosInstance!
}

/**
 * A COS instance authorized with **temporary STS credentials** fetched from
 * the SCF endpoint (see ./stsCredentials). Unlike `getCosInstance`, this never
 * touches the permanent master/sub-account key on the client — the SDK calls
 * `getAuthorization` on every signed request and we hand back a short-lived
 * token scoped to `image-history/*` PutObject.
 *
 * This is what makes image-history uploads work for *all* end users in
 * production, where no permanent COS key is bundled. The callback always
 * settles (even on fetch failure) so a down endpoint surfaces as a normal
 * upload rejection instead of hanging the SDK.
 */
function getStsCosInstance(): CosInstance {
  if (!stsCosInstance) {
    stsCosInstance = new (COS as any)({
      Protocol: 'https:',
      Timeout: 120000,
      getAuthorization: (_options: any, callback: any) => {
        getStsCredentials()
          .then((c) => {
            callback({
              TmpSecretId: c.tmpSecretId,
              TmpSecretKey: c.tmpSecretKey,
              SecurityToken: c.sessionToken,
              StartTime: c.startTime,
              ExpiredTime: c.expiredTime,
            })
          })
          .catch((err) => {
            logCosError('sts-getAuthorization', err)
            // Hand back empty creds so the SDK fails signing and the putObject
            // callback rejects with an error — never leave the callback unfired
            // (that would wedge the upload).
            callback({ TmpSecretId: '', TmpSecretKey: '', SecurityToken: '', StartTime: 0, ExpiredTime: 0 })
          })
      },
    })
  }
  return stsCosInstance!
}

/**
 * 上传前先把票据拿到手。
 *
 * getAuthorization 里那条"失败就交空票据"的兜底保证了回调一定会 settle(不然
 * SDK 会挂死),但代价是真实原因被吞掉:空票据签出来的请求在服务端只会换回一句
 * 403 AccessDenied,用户和日志都看不出到底是端点挂了、超时了还是 token 不对。
 * 提前取一次(命中缓存时零开销)就能让真实原因原样抛出来。
 */
async function ensureStsCredentials(): Promise<void> {
  await getStsCredentials()
}

/**
 * Media-scope STS COS instance (智能去字幕 / 分镜切图 免密钥通道)。与
 * getStsCosInstance 相同的 getAuthorization 结构,但票据是 scope=media
 * (smart-erase/* + storyboard-split/* 读写删)。
 */
function getMediaStsCosInstance(): CosInstance {
  if (!mediaStsCosInstance) {
    mediaStsCosInstance = new (COS as any)({
      Protocol: 'https:',
      Timeout: 120000,
      getAuthorization: (_options: any, callback: any) => {
        getMediaStsCredentials()
          .then((c) => {
            callback({
              TmpSecretId: c.tmpSecretId,
              TmpSecretKey: c.tmpSecretKey,
              SecurityToken: c.sessionToken,
              StartTime: c.startTime,
              ExpiredTime: c.expiredTime,
            })
          })
          .catch((err) => {
            logCosError('media-sts-getAuthorization', err)
            callback({ TmpSecretId: '', TmpSecretKey: '', SecurityToken: '', StartTime: 0, ExpiredTime: 0 })
          })
      },
    })
  }
  return mediaStsCosInstance!
}

/**
 * 媒体操作统一入口:永久密钥优先(实例/桶/区域与旧行为完全一致),
 * 未配置时回退到 media-scope STS 实例(桶/区域随票据下发)。
 */
async function resolveMediaCos(): Promise<{ cos: CosInstance; Bucket: string; Region: string }> {
  const auth = await getMediaAuth()
  if (auth.mode === 'permanent') {
    return { cos: getCosInstance(), Bucket: auth.bucket, Region: auth.region }
  }
  return { cos: getMediaStsCosInstance(), Bucket: auth.bucket, Region: auth.region }
}

// Keep all reject-path logging in one place so we can flip the verbosity
// switch in one spot once we're confident in the deployed network setup.
// Captures the COS SDK error envelope (err.code/statusCode/RequestId) AND
// the inner Node.js error chain (err.error?.code, err.error?.message,
// err.cause?.message) — TLS / DNS / proxy failures only show the real
// reason on the inner error.
function logCosError(op: string, err: any, ctx: Record<string, unknown> = {}) {
  console.error(`[cosClient] ${op} FAILED`, {
    ...ctx,
    code: err?.code,
    statusCode: err?.statusCode,
    requestId: err?.headers?.['x-cos-request-id'] ?? err?.RequestId,
    message: err?.message,
    innerCode: err?.error?.code ?? err?.cause?.code,
    innerMessage: err?.error?.message ?? err?.cause?.message,
    stack: typeof err?.stack === 'string' ? err.stack.split('\n').slice(0, 6).join('\n') : undefined,
  })
}

export interface UploadBufferOptions {
  key: string
  body: Buffer
  contentType?: string
}

export async function uploadBuffer(opts: UploadBufferOptions): Promise<void> {
  const { cos, Bucket, Region } = await resolveMediaCos()
  await new Promise<void>((resolve, reject) => {
    cos.putObject(
      { Bucket, Region, Key: opts.key, Body: opts.body, ContentType: opts.contentType },
      (err: any) => {
        if (err) {
          logCosError('uploadBuffer', err, { Bucket, Region, Key: opts.key })
          reject(err)
          return
        }
        resolve()
      },
    )
  })
}

export interface UploadBufferToBucketOptions {
  bucket: string
  region: string
  key: string
  body: Buffer
  contentType?: string
}

/**
 * Upload a buffer to a Tencent COS bucket *other than* the default one in
 * credentials. Use when the caller needs to target a specific bucket — e.g.
 * the image-history bucket — without disturbing storyboardSplit/smartErase
 * which still rely on `getBucketAndRegion()`.
 *
 * Returns the canonical public URL of the uploaded object so callers can
 * persist the link without a second `getObjectUrl` roundtrip. The leading
 * slash (if any) is stripped from the key both in the SDK call and the
 * URL — COS keys must not start with `/`.
 *
 * Authorized via **STS temporary credentials**, so this path works for every
 * end user without a bundled permanent key. That's the fix for "history images
 * vanish after reopen": the upload now actually succeeds in production, so the
 * stored link is a permanent COS URL instead of an expiring model URL.
 */
export async function uploadBufferToBucket(opts: UploadBufferToBucketOptions): Promise<string> {
  const cos = getStsCosInstance()
  await ensureStsCredentials()
  const Key = opts.key.replace(/^\/+/, '')
  await new Promise<void>((resolve, reject) => {
    cos.putObject(
      {
        Bucket: opts.bucket,
        Region: opts.region,
        Key,
        Body: opts.body,
        ContentType: opts.contentType,
      },
      (err: any) => {
        if (err) {
          logCosError('uploadBufferToBucket', err, {
            Bucket: opts.bucket,
            Region: opts.region,
            Key,
          })
          reject(err)
          return
        }
        resolve()
      },
    )
  })
  return `https://${opts.bucket}.cos.${opts.region}.myqcloud.com/${Key}`
}

export interface UploadStreamProgress {
  loaded: number
  total: number
  percent: number
  speed: number
}

export interface UploadStreamToBucketOptions {
  bucket: string
  region: string
  key: string
  filePath: string
  contentType?: string
  /**
   * 总时长保险丝(覆盖多分片串联,不是单次 HTTP 超时)。大文件应按体积放大;
   * 调用方(mediaRelay.relayFileToCos)会按文件大小算一个保底值传进来。
   */
  hardTimeoutMs?: number
  onProgress?: (info: UploadStreamProgress) => void
}

/**
 * Slice/multipart upload a file **from disk** to an arbitrary COS bucket using
 * **STS temporary credentials** — the production-safe path that works for every
 * end user (no bundled permanent key). Mirrors {@link uploadBufferToBucket} but
 * streams from `filePath` via `sliceUploadFile`, so we never hold the whole file
 * in a Node Buffer (that's what capped understand uploads at 200MB). The STS
 * policy already authorizes the full multipart action set scoped to
 * `image-history/*` (see serverless/sts-cos/index.js), so the Key MUST stay
 * under that prefix.
 *
 * Returns the canonical public https URL of the uploaded object.
 */
export async function uploadStreamToBucket(opts: UploadStreamToBucketOptions): Promise<string> {
  const cos = getStsCosInstance()
  await ensureStsCredentials()
  const Key = opts.key.replace(/^\/+/, '')
  const hardTimeoutMs = opts.hardTimeoutMs ?? SLICE_UPLOAD_HARD_TIMEOUT_MS

  // round-5 加固(同 uploadStream): 抓 taskId 以便异常分支显式 cancelTask,
  // 强制 SDK evict 内部 TaskInfo Map 里的文件 fd。这里用 STS 实例自己的
  // cancelTask(模块级 cancelUpload 绑的是永久 key 实例, 不通用)。
  let taskId: string | undefined
  const safeCancel = (): void => {
    if (!taskId) return
    try { cos.cancelTask(taskId) } catch { /* SDK 内部可能已 cleanup */ }
  }

  await new Promise<void>((resolve, reject) => {
    const hardTimer = setTimeout(() => {
      logCosError(
        'uploadStreamToBucket-timeout',
        new Error(`sliceUploadFile 超过 ${hardTimeoutMs}ms 仍未完成`),
        { Bucket: opts.bucket, Region: opts.region, Key, filePath: opts.filePath, taskId },
      )
      safeCancel()
      reject(new Error('sliceUploadFile timeout'))
    }, hardTimeoutMs)
    hardTimer.unref?.()

    cos.sliceUploadFile(
      {
        Bucket: opts.bucket,
        Region: opts.region,
        Key,
        FilePath: opts.filePath,
        ContentType: opts.contentType,
        onProgress: opts.onProgress,
        onTaskReady: (id: string) => {
          taskId = id
        },
      },
      (err: any) => {
        clearTimeout(hardTimer)
        if (err) {
          logCosError('uploadStreamToBucket', err, {
            Bucket: opts.bucket,
            Region: opts.region,
            Key,
            filePath: opts.filePath,
          })
          safeCancel()
          reject(err)
          return
        }
        resolve()
      },
    )
  })
  return `https://${opts.bucket}.cos.${opts.region}.myqcloud.com/${Key}`
}

export interface UploadStreamOptions {
  key: string
  filePath: string
  contentType?: string
  onProgress?: (info: UploadStreamProgress) => void
  onTaskReady?: (taskId: string) => void
}

/**
 * sliceUploadFile 的硬超时。COS SDK 自带的 Timeout=120000ms 是单次 HTTP
 * 请求超时, 不覆盖多分片串联的总时长; 一个大文件分片重试场景下可能挂很久。
 * 我们这里加一个总时长上限, 触发后强行 cancelTask, 让 SDK 释放 TaskInfo
 * Map 里的 fd。
 */
const SLICE_UPLOAD_HARD_TIMEOUT_MS = 10 * 60 * 1000 // 10 分钟

export async function uploadStream(opts: UploadStreamOptions): Promise<void> {
  const { cos, Bucket, Region } = await resolveMediaCos()

  // round-5 加固: 透明拦截 onTaskReady 把 taskId 抓在闭包里, 这样异常分支
  // 也能调 cancelTask 做防御性清理 —— cos-nodejs-sdk-v5 的 sliceUploadFile
  // 在某些 abort 路径上不会自动从内部 TaskInfo Map 里 evict 文件 fd,
  // 显式 cancelTask 才会触发 finalizer。同时调用方原本绑的 onTaskReady
  // 还是要透传, 不要吞掉。
  let taskId: string | undefined
  const onTaskReadyProxy = (id: string): void => {
    taskId = id
    try { opts.onTaskReady?.(id) } catch { /* user cb error 不能阻塞上传 */ }
  }
  const safeCancel = (): void => {
    if (!taskId) return
    try { cancelUpload(taskId) } catch { /* SDK 内部状态可能已 cleanup */ }
  }

  await new Promise<void>((resolve, reject) => {
    // 总时长保险丝。注意: 触发时我们 cancelTask + reject; 之后 cos 回调
    // 也可能再来一次(成功完成或带 err), 但 Promise 已 settle, 后续 resolve/reject
    // 会被 v8 静默忽略 —— 安全。
    const hardTimer = setTimeout(() => {
      logCosError(
        'uploadStream-timeout',
        new Error(`sliceUploadFile 超过 ${SLICE_UPLOAD_HARD_TIMEOUT_MS}ms 仍未完成`),
        { Bucket, Region, Key: opts.key, filePath: opts.filePath, taskId },
      )
      safeCancel()
      reject(new Error('sliceUploadFile timeout'))
    }, SLICE_UPLOAD_HARD_TIMEOUT_MS)
    hardTimer.unref?.()

    cos.sliceUploadFile(
      {
        Bucket,
        Region,
        Key: opts.key,
        FilePath: opts.filePath,
        ContentType: opts.contentType,
        onProgress: opts.onProgress,
        onTaskReady: onTaskReadyProxy,
      },
      (err: any) => {
        clearTimeout(hardTimer)
        if (err) {
          logCosError('uploadStream', err, { Bucket, Region, Key: opts.key, filePath: opts.filePath })
          // 防御性 cancel: SDK 在 callback(err) 触发时**应该**已 cleanup,
          // 但实测某些版本里 multipart 的内部 TaskInfo Map 不释放文件流。
          // 这里再调一次 cancelTask 让 SDK 走 evictTask 分支, 强制释放 fd。
          // 已经 cleanup 的情况下 cancelTask 是 no-op, 没有副作用。
          safeCancel()
          reject(err)
          return
        }
        resolve()
      },
    )
  })
}

/**
 * Aborts an in-flight multipart upload identified by the TaskId surfaced via
 * `uploadStream`'s onTaskReady callback. Synchronous and non-throwing — safe
 * to call before any upload has started (cold-cancel no-ops cleanly).
 */
export function cancelUpload(taskId: string): void {
  // taskId 可能属于永久实例或 media-STS 实例;对不认识的 id, SDK 的
  // cancelTask 是 no-op,双发无副作用。
  try { cosInstance?.cancelTask(taskId) } catch { /* SDK 内部可能已 cleanup */ }
  try { mediaStsCosInstance?.cancelTask(taskId) } catch { /* 同上 */ }
}

export interface GetPresignedUrlOptions {
  key: string
  expireSeconds: number
  query?: Record<string, any>
  method?: 'GET' | 'PUT'
}

export async function getPresignedUrl(opts: GetPresignedUrlOptions): Promise<string> {
  const { cos, Bucket, Region } = await resolveMediaCos()
  return new Promise((resolve, reject) => {
    cos.getObjectUrl(
      {
        Bucket,
        Region,
        Key: opts.key,
        Sign: true,
        Method: opts.method || 'GET',
        Expires: opts.expireSeconds,
        Query: opts.query,
      },
      (err: any, data: any) => {
        if (err) {
          logCosError('getPresignedUrl', err, { Bucket, Region, Key: opts.key })
          reject(err)
          return
        }
        resolve(data.Url)
      },
    )
  })
}

export async function deleteObjects(keys: string[]): Promise<void> {
  if (!keys.length) return
  const { cos, Bucket, Region } = await resolveMediaCos()
  await new Promise<void>((resolve, reject) => {
    cos.deleteMultipleObject(
      {
        Bucket,
        Region,
        Objects: keys.map((k) => ({ Key: k.replace(/^\//, '') })),
        Quiet: true,
      },
      (err: any, data: any) => {
        if (err) return reject(err)
        if (data?.Error?.length) {
          const failed = data.Error.map((e: any) => e.Key).join(', ')
          console.warn('[tencent/cosClient] partial delete failures:', data.Error)
          return reject(new Error(`COS partial delete failed for keys: ${failed}`))
        }
        resolve()
      },
    )
  })
}

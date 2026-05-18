import COS from 'cos-nodejs-sdk-v5'
import { getCredentials, onCredentialsInvalidated } from './credentials'

type CosInstance = {
  putObject: (params: any, cb: any) => void
  sliceUploadFile: (params: any, cb: any) => void
  cancelTask: (id: string) => void
  getObjectUrl: (params: any, cb: any) => void
  deleteMultipleObject: (params: any, cb: any) => void
}

let cosInstance: CosInstance | null = null

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

function getBucketAndRegion() {
  const creds = getCredentials()
  return { Bucket: creds.bucket, Region: creds.region }
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
  const cos = getCosInstance()
  const { Bucket, Region } = getBucketAndRegion()
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
 */
export async function uploadBufferToBucket(opts: UploadBufferToBucketOptions): Promise<string> {
  const cos = getCosInstance()
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

export interface UploadStreamOptions {
  key: string
  filePath: string
  contentType?: string
  onProgress?: (info: UploadStreamProgress) => void
  onTaskReady?: (taskId: string) => void
}

export async function uploadStream(opts: UploadStreamOptions): Promise<void> {
  const cos = getCosInstance()
  const { Bucket, Region } = getBucketAndRegion()
  await new Promise<void>((resolve, reject) => {
    cos.sliceUploadFile(
      {
        Bucket,
        Region,
        Key: opts.key,
        FilePath: opts.filePath,
        ContentType: opts.contentType,
        onProgress: opts.onProgress,
        onTaskReady: opts.onTaskReady,
      },
      (err: any) => {
        if (err) {
          logCosError('uploadStream', err, { Bucket, Region, Key: opts.key, filePath: opts.filePath })
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
  if (!cosInstance) return
  cosInstance.cancelTask(taskId)
}

export interface GetPresignedUrlOptions {
  key: string
  expireSeconds: number
  query?: Record<string, any>
  method?: 'GET' | 'PUT'
}

export function getPresignedUrl(opts: GetPresignedUrlOptions): Promise<string> {
  const cos = getCosInstance()
  const { Bucket, Region } = getBucketAndRegion()
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
  const cos = getCosInstance()
  const { Bucket, Region } = getBucketAndRegion()
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

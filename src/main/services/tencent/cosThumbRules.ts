/**
 * cosThumbRules — 数据万象「上传时处理」规则(持久化缩略图)。
 *
 * 之前缩略图只做实时处理:读图时在 URL 后挂 `imageMogr2`,万象现算(万象侧缓存
 * 30 天)。每次展示都要万象在线;代理出口不通、参数写错都直接体现成破图。
 * 现在上传原图时顺手带 `Pic-Operations` 头,万象把 512 / 1024 两档 WebP 缩略图
 * **存成桶里两个独立对象**,读侧就是普通 COS GET(`server: tencent-cos`),不再经万象。
 *
 * 实测(2026-09-15,STS 临时票据,image-master 桶):
 *  - `putObject` + 2 条规则:709 ms(含处理),响应 `UploadResult.ProcessResults`
 *    带每张缩略图的 Key/Size/Width/Height,`OriginalInfo.ImageInfo` 白送原图宽高;
 *  - `sliceUploadFile`(真多分片,UploadId 在)同样生效 —— SDK 把 `Headers` 原样
 *    传到 CompleteMultipartUpload(advance.js:727),文档明写分块完成支持该头;
 *  - `POST /<key>?image_process` 给已存在对象补图 703 ms,STS 策略放行。
 *
 * 命名约定 **读侧靠它反推,改了两边一起改**(`renderer/utils/cosThumb.ts`):
 *   `image-history/2026/09/15/<id>.png` → `…/<id>.thumb512.webp`、`…/<id>.thumb1024.webp`
 * 规则里的 `>`(shrink-only)是原字符 —— 这是 JSON 头,不是 URL,不要 `%3E`。
 */

/** 与读侧 `persistedCosThumbUrl` 共用的两档尺寸:聊天气泡 512,生成页两列网格 1024。 */
export const PERSISTED_THUMB_SIZES = [512, 1024] as const
export type PersistedThumbSize = (typeof PERSISTED_THUMB_SIZES)[number]

export interface PicOperationRule {
  /** 结果对象键,以 `/` 开头(万象要求)。省略 bucket = 写回当前桶。 */
  fileid: string
  rule: string
}

export interface PicOperations {
  /** 1 = 响应里带原图 ImageInfo(宽高 / 格式 / 帧数)。 */
  is_pic_info?: 0 | 1
  /** 最多 5 条(官方限制)。 */
  rules: PicOperationRule[]
}

/** 万象基础图片处理认的输入格式;别的 mime(视频 / 音频 / bin)不下规则。 */
const CI_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/avif',
  'image/heic',
  'image/heif',
])

export function thumbRule(edge: PersistedThumbSize): string {
  return `imageMogr2/thumbnail/${edge}x${edge}>/format/webp/quality/85`
}

/** `image-history/2026/09/15/abc.png` → `image-history/2026/09/15/abc.thumb512.webp` */
export function persistedThumbKey(objectKey: string, size: PersistedThumbSize): string {
  const key = objectKey.replace(/^\/+/, '')
  const slash = key.lastIndexOf('/')
  const dot = key.lastIndexOf('.')
  const base = dot > slash ? key.slice(0, dot) : key
  return `${base}.thumb${size}.webp`
}

/**
 * 给一次 image-history 上传配的持久化规则;非图片 mime 返回 undefined(调用方
 * 不带头,行为与从前完全一致)。
 */
export function imageHistoryPicOperations(objectKey: string, mimeType: string | undefined): PicOperations | undefined {
  const mime = (mimeType ?? '').split(';')[0].trim().toLowerCase()
  if (!CI_IMAGE_MIMES.has(mime)) return undefined
  return {
    is_pic_info: 1,
    rules: PERSISTED_THUMB_SIZES.map((size) => ({
      fileid: `/${persistedThumbKey(objectKey, size)}`,
      rule: thumbRule(size),
    })),
  }
}

/** `Pic-Operations` 头的值就是这个 JSON 串。 */
export function picOperationsHeader(ops: PicOperations): string {
  return JSON.stringify(ops)
}

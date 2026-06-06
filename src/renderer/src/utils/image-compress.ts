// 对齐生成接口的真实上限(base64 data URL 字段 maxLength ≈ 20MiB;base64 比原图膨胀约 1/3,
// 故原图控制在 ~15MB 以内即安全)。取 14MB 留余量:
// 14MB × 4/3 ≈ 18.7MiB < 20MiB。
//
// 关键:compressImage 在「原图 ≤ MAX_SIZE_MB」时直接原样返回(不缩放、不重编码),
// 所以把阈值抬到 14MB 后,绝大多数全景图(2~8MB JPEG)= 原图字节直出,
// 与参考站「全景图预览器.html」(FileReader 读原图)完全一致,清晰度不再被有损压缩拉低。
// 仅超大文件(>14MB)才会触发缩放,且上限放宽到 4096(等距柱状 4K 已足够锐,
// 又能把 base64 压在接口 20MiB 之内、避免超 GPU 纹理上限)。
const MAX_SIZE_MB = 14
const MAX_DIM = 4096
const INITIAL_QUALITY = 0.92
const LIB_URL = './cdn/browser-image-compression/browser-image-compression.js'

export interface CompressResult {
  file: File
  base64: string
  originalSize: number
  finalSize: number
  compressed: boolean
}

async function getCompressor(): Promise<((file: File, opts: any) => Promise<File>) | null> {
  const loader = (window as any).getImageCompression
  if (typeof loader === 'function') return loader()
  const fallback = (window as any).imageCompression
  if (typeof fallback === 'function') return fallback
  return null
}

export async function compressImage(file: File): Promise<File> {
  const sizeMB = file.size / (1024 * 1024)
  if (sizeMB <= MAX_SIZE_MB) return file

  const imageCompression = await getCompressor()
  if (!imageCompression) {
    console.warn('[image-compress] 压缩库未就绪，跳过压缩')
    return file
  }

  const t0 = Date.now()
  console.log(`🗜️ 压缩参考图: ${file.name}, 原大小: ${sizeMB.toFixed(2)}MB`)

  const compressed = await imageCompression(file, {
    maxSizeMB: MAX_SIZE_MB,
    maxWidthOrHeight: MAX_DIM,
    useWebWorker: true,
    libURL: LIB_URL,
    fileType: file.type,
    initialQuality: INITIAL_QUALITY,
    alwaysKeepResolution: false,
  })

  const duration = ((Date.now() - t0) / 1000).toFixed(1)
  const ratio = ((1 - compressed.size / file.size) * 100).toFixed(1)
  console.log(
    `✅ 压缩完成: ${file.name}\n` +
    `   原大小: ${sizeMB.toFixed(2)}MB\n` +
    `   压缩后: ${(compressed.size / (1024 * 1024)).toFixed(2)}MB\n` +
    `   压缩率: ${ratio}%\n` +
    `   ⏱️ 耗时: ${duration}秒`
  )

  return compressed
}

export async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const b64 = result.split(',')[1]
      if (!b64 || b64.length < 100) {
        reject(new Error('Base64 转换结果无效'))
        return
      }
      resolve(b64)
    }
    reader.onerror = () => reject(new Error(`FileReader 错误: ${reader.error?.message || '未知'}`))
    reader.readAsDataURL(file)
  })
}

export async function compressAndConvert(file: File): Promise<CompressResult> {
  const originalSize = file.size
  let processed: File
  try {
    processed = await compressImage(file)
  } catch (e) {
    console.warn('[image-compress] 压缩失败，使用原图:', e)
    processed = file
  }
  const base64 = await fileToBase64(processed)
  return {
    file: processed,
    base64,
    originalSize,
    finalSize: processed.size,
    compressed: processed !== file,
  }
}

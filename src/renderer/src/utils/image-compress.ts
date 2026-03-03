const MAX_SIZE_MB = 2
const MAX_DIM = 2048
const INITIAL_QUALITY = 0.9
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

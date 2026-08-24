/**
 * 图层分离的输入图格式适配。
 *
 * 上游 Seedream 5.0 Pro 的 `image` 只吃 **png / jpeg**,收到 webp 会回一句
 * 「image format is not supported by the API」——参数名对、模型对、开关对,只有
 * 格式不对,错误信息里也不说该转成什么。
 *
 * 这不是边缘情况:**本 app 自己的历史图存在 COS 上就是 .webp**,所以「对一张历史图
 * 点拆分」是必然踩中的主路径。与其让用户看一句上游黑话,不如在发出去之前转掉。
 */

/** 上游认的输入格式。其余一律转码。 */
const ACCEPTED_MIME = new Set(['image/png', 'image/jpeg'])
const ACCEPTED_EXT = /\.(png|jpe?g)(?:$|[?#])/i

/** 上游对输入图的最小边长。低于这个值上游同样只回一句语焉不详的 InvalidParameter。 */
const MIN_EDGE = 512

export interface LayerSplitInputResult {
  /** 可直接放进 payload.image 的值(原 URL 或转码后的 data URI)。失败时为 null。 */
  image: string | null
  /** 失败原因(面向用户的中文说明)。成功时为 undefined。 */
  error?: string
  /** 是否发生了转码。仅用于日志/测试断言。 */
  transcoded: boolean
}

function canTranscode(): boolean {
  return (
    typeof fetch === 'function' &&
    typeof createImageBitmap === 'function' &&
    typeof OffscreenCanvas === 'function' &&
    typeof FileReader === 'function'
  )
}

/** 已经是上游认的格式?能从 data URI 的 mime 或 URL 后缀直接判定的走快路。 */
function alreadyAccepted(source: string): boolean {
  if (source.startsWith('data:')) {
    const semi = source.indexOf(';')
    const comma = source.indexOf(',')
    const end = semi >= 0 && (comma < 0 || semi < comma) ? semi : comma
    if (end < 0) return false
    return ACCEPTED_MIME.has(source.slice(5, end).toLowerCase())
  }
  return ACCEPTED_EXT.test(source)
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result as string)
    fr.onerror = () => reject(new Error('read failed'))
    fr.readAsDataURL(blob)
  })
}

/**
 * 把待拆分的输入图转成上游认的格式。
 *
 * - 已是 png/jpeg(按 data URI 的 mime 或 URL 后缀判定):**原样返回**。
 *   http(s) URL 保持 URL 形态很重要 —— 上游自己去取,不用我们把几 MB base64 塞进请求体。
 * - 其余(webp / 无后缀 / 未知):取回来用 canvas 转成 PNG data URI。
 *   选 PNG 而不是体积小得多的 JPEG,是因为 webp 可能带透明通道,转 JPEG 会把透明区
 *   压成黑块,而这张图正是拆分的依据 —— 底图错了整组图层都错。
 * - 环境不支持 canvas 转码、或取图失败:返回 error,由调用方告诉用户,
 *   而不是把 webp 原样发出去换一句上游黑话。
 */
export async function ensureLayerSplitInputFormat(source: string): Promise<LayerSplitInputResult> {
  if (!source) return { image: null, error: '图层分离需要一张待拆分的输入图', transcoded: false }
  if (alreadyAccepted(source)) return { image: source, transcoded: false }

  if (!canTranscode()) {
    return {
      image: null,
      error: '待拆分的图不是 PNG / JPEG，且当前环境无法转码。请换一张 PNG 或 JPEG 图片。',
      transcoded: false,
    }
  }

  try {
    const res = await fetch(source)
    if (!res.ok) throw new Error(`fetch ${res.status}`)
    const blob = await res.blob()

    // 取回来才知道真实 mime —— 有些 COS 对象没后缀但本身就是 png。
    // 这一步能省掉一次无谓的重编码。
    if (ACCEPTED_MIME.has(blob.type.toLowerCase())) {
      return { image: source, transcoded: false }
    }

    const bitmap = await createImageBitmap(blob)
    const { width, height } = bitmap
    if (Math.min(width, height) < MIN_EDGE) {
      bitmap.close()
      return {
        image: null,
        error: `待拆分的图太小（${width}×${height}），图层分离要求最小边不低于 ${MIN_EDGE}px。`,
        transcoded: false,
      }
    }

    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()

    const png = await canvas.convertToBlob({ type: 'image/png' })
    return { image: await blobToDataUrl(png), transcoded: true }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    return {
      image: null,
      error: `待拆分的图无法转换为 PNG（${reason}）。上游只接受 PNG / JPEG，请换一张图重试。`,
      transcoded: false,
    }
  }
}

// 透明 PNG 探测(设计稿 D5):有 alpha 的结果图默认放深底 + ALPHA 徽章,不铺棋盘格。
//
// 生成参数(transparentBackground)不一定随附件落库,而且历史 / 外部图也要认,所以
// 直接看像素:把图缩到 24×24 画进离屏 canvas,任何一个像素 alpha < 250 就算透明。
// 结果按 src 缓存;同一张图在多条消息里出现只探一次。canvas 不可用(测试环境 /
// 跨域污染)一律返回 false —— 宁可少一个徽章,不可把不透明图铺成棋盘格。

const cache = new Map<string, Promise<boolean>>()
const SAMPLE = 24
const OPAQUE_THRESHOLD = 250

export function probeImageAlpha(src: string, mime?: string): Promise<boolean> {
  // JPEG / GIF 等没有 alpha 通道,免探。
  if (mime && !/png|webp|avif|gif/i.test(mime) && !/svg/i.test(mime)) return Promise.resolve(false)
  const hit = cache.get(src)
  if (hit) return hit
  const task = (async (): Promise<boolean> => {
    if (typeof document === 'undefined' || typeof Image === 'undefined') return false
    const img = new Image()
    img.decoding = 'async'
    const loaded = await new Promise<boolean>((resolve) => {
      img.onload = () => resolve(true)
      img.onerror = () => resolve(false)
      img.src = src
    })
    if (!loaded || !img.naturalWidth) return false
    const canvas = document.createElement('canvas')
    canvas.width = SAMPLE
    canvas.height = SAMPLE
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return false
    try {
      ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE)
      const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE)
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < OPAQUE_THRESHOLD) return true
      }
      return false
    } catch {
      return false
    }
  })()
  cache.set(src, task)
  return task
}

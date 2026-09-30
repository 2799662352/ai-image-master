/**
 * 社区宠物每行实际用了几帧不固定:契约只规定「从第 0 列起连续的非空格子
 * 就是这一行的动画,后面的空格子忽略」。按推荐帧数硬播,帧数更少的包就会
 * 周期性闪一下空白。这里把图集画到 canvas 上逐格看 alpha,算出每行帧数。
 *
 * 只用于自装宠物(local-file,不污染 canvas);内置宠物的帧数是已知的,
 * 而且打包后 `file://` 源的图读不了像素。任何一步失败都返回 null,
 * 调用方回落到推荐帧数。
 */

import { PET_FRAME_HEIGHT, PET_FRAME_WIDTH, PET_SHEET_COLS } from './petAnimations'

const cache = new Map<string, Promise<number[] | null>>()

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`failed to load ${url}`))
    img.src = url
  })
}

function cellHasPixels(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) return true
  }
  return false
}

async function detect(url: string, rows: number): Promise<number[] | null> {
  try {
    const img = await loadImage(url)
    const canvas = document.createElement('canvas')
    canvas.width = PET_FRAME_WIDTH * PET_SHEET_COLS
    canvas.height = PET_FRAME_HEIGHT * rows
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(img, 0, 0)
    const counts: number[] = []
    for (let row = 0; row < rows; row++) {
      let frames = 0
      while (frames < PET_SHEET_COLS) {
        const cell = ctx.getImageData(frames * PET_FRAME_WIDTH, row * PET_FRAME_HEIGHT, PET_FRAME_WIDTH, PET_FRAME_HEIGHT)
        if (!cellHasPixels(cell.data)) break
        frames++
      }
      counts.push(frames)
    }
    return counts
  } catch {
    return null
  }
}

export function detectPetFrameCounts(url: string, rows: number): Promise<number[] | null> {
  const key = `${rows}|${url}`
  let pending = cache.get(key)
  if (!pending) {
    pending = detect(url, rows)
    cache.set(key, pending)
  }
  return pending
}

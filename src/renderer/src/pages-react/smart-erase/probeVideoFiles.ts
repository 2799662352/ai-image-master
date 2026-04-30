import type { EraseProbeResult } from '../../../../types/smartErase'

const api = (window as any).electronAPI

/**
 * Probe video files in the renderer using HTML5 <video> element.
 * Replaces the old main-process ffprobe-static approach (~70MB binary).
 */
export async function probeVideoFiles(files: File[]): Promise<EraseProbeResult[]> {
  const results: EraseProbeResult[] = []

  for (const file of files) {
    const filePath: string = api?.getFilePath?.(file) ?? ''
    const filename = file.name
    const fileSize = file.size

    if (!filePath) {
      results.push({ filePath: '', filename, fileSize, durationSeconds: 0, warning: 'FILE_PATH_UNAVAILABLE' })
      continue
    }

    try {
      const durationSeconds = await getVideoDuration(file)
      results.push({ filePath, filename, fileSize, durationSeconds })
    } catch {
      results.push({ filePath, filename, fileSize, durationSeconds: 0, warning: 'PROBE_FAILED' })
    }
  }

  return results
}

function getVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    const url = URL.createObjectURL(file)

    const cleanup = () => {
      URL.revokeObjectURL(url)
      video.removeAttribute('src')
      video.load()
    }

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('PROBE_TIMEOUT'))
    }, 15_000)

    video.onloadedmetadata = () => {
      clearTimeout(timer)
      const dur = video.duration
      cleanup()
      if (!Number.isFinite(dur) || dur <= 0) {
        reject(new Error('INVALID_DURATION'))
        return
      }
      resolve(dur)
    }

    video.onerror = () => {
      clearTimeout(timer)
      cleanup()
      reject(new Error('VIDEO_LOAD_ERROR'))
    }

    video.src = url
  })
}

/**
 * Generate a poster (thumbnail) data URL from a video File.
 * Replaces the old main-process ffmpeg-static approach (~100MB binary).
 * Seeks to 0.5s (or first frame) and captures a 320px-wide JPEG.
 */
export function generatePosterFromFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'auto'
    video.muted = true
    const url = URL.createObjectURL(file)

    const cleanup = () => {
      URL.revokeObjectURL(url)
      video.removeAttribute('src')
      video.load()
    }

    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('POSTER_TIMEOUT'))
    }, 10_000)

    video.onloadeddata = () => {
      const seekTarget = Math.min(0.5, video.duration * 0.1 || 0)
      video.currentTime = seekTarget
    }

    video.onseeked = () => {
      clearTimeout(timer)
      try {
        const canvas = document.createElement('canvas')
        const scale = 320 / (video.videoWidth || 320)
        canvas.width = 320
        canvas.height = Math.round((video.videoHeight || 180) * scale)
        const ctx = canvas.getContext('2d')
        if (!ctx) { cleanup(); reject(new Error('CANVAS_FAILED')); return }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const dataUrl = canvas.toDataURL('image/jpeg', 0.7)
        cleanup()
        resolve(dataUrl)
      } catch (err) {
        cleanup()
        reject(err)
      }
    }

    video.onerror = () => {
      clearTimeout(timer)
      cleanup()
      reject(new Error('VIDEO_LOAD_ERROR'))
    }

    video.src = url
  })
}

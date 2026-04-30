import { spawn } from 'node:child_process'
import ffmpegStatic from 'ffmpeg-static'

const POSTER_TIMEOUT_MS = 5_000

/**
 * In a packaged Electron app `ffmpeg-static` resolves inside `app.asar` which
 * cannot be exec'd by `child_process.spawn`. The `asarUnpack` rule in
 * package.json mirrors the binary into `app.asar.unpacked`; this string
 * replace makes the runtime path point there. In dev `ffmpegStatic` is
 * already on disk so the replace is a no-op.
 */
function resolveFfmpegPath(): string {
  const raw = (ffmpegStatic ?? '') as unknown as string
  if (!raw) throw new Error('POSTER_FAILED: ffmpeg-static binary not found')
  return raw.replace('app.asar', 'app.asar.unpacked')
}

export async function generatePosterDataUrl(videoPath: string): Promise<string> {
  const bin = resolveFfmpegPath()
  const args = [
    '-ss', '0.5',
    '-i', videoPath,
    '-frames:v', '1',
    '-vf', 'scale=320:-1',
    '-f', 'mjpeg',
    'pipe:1',
  ]

  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args)
    const chunks: Buffer[] = []
    let stderrBuf = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      reject(new Error('POSTER_TIMEOUT: ffmpeg did not finish within 5s'))
    }, POSTER_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString()
    })

    child.on('error', (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`POSTER_FAILED: ${err.message}`))
    })

    child.on('close', (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        const tail = stderrBuf.split('\n').filter(Boolean).slice(-1)[0] ?? ''
        reject(new Error(`POSTER_FAILED: ffmpeg exited ${code}${tail ? ` (${tail})` : ''}`))
        return
      }
      const buf = Buffer.concat(chunks)
      if (buf.length === 0) {
        reject(new Error('POSTER_FAILED: ffmpeg produced no output'))
        return
      }
      resolve('data:image/jpeg;base64,' + buf.toString('base64'))
    })
  })
}

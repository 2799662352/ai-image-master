import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import * as path from 'node:path'
import ffprobeStatic from 'ffprobe-static'
import type { EraseProbeResult } from '../../../types/smartErase'

const PROBE_CONCURRENCY = 4

/**
 * `ffprobe-static` exports `{ path }` (NOT a bare string — differs from
 * `ffmpeg-static`). The `app.asar` -> `app.asar.unpacked` patch is identical
 * to posterGen.ts and is required for packaged Electron builds.
 */
function resolveFfprobePath(): string {
  const raw = (ffprobeStatic?.path ?? '') as string
  if (!raw) throw new Error('PROBE_FAILED: ffprobe-static binary not found')
  return raw.replace('app.asar', 'app.asar.unpacked')
}

interface FormatProbeJson {
  format?: { duration?: string | number }
}

function probeOne(filePath: string): Promise<EraseProbeResult> {
  const filename = filePath ? path.basename(filePath) : ''

  if (!filePath) {
    return Promise.resolve({
      filePath: '',
      filename: '',
      fileSize: 0,
      durationSeconds: 0,
      warning: 'FILE_PATH_UNAVAILABLE',
    })
  }

  let fileSize = 0
  try {
    const st = statSync(filePath)
    fileSize = Number(st.size ?? 0)
  } catch {
    return Promise.resolve({
      filePath,
      filename,
      fileSize: 0,
      durationSeconds: 0,
      warning: 'FILE_NOT_LOCAL',
    })
  }

  return new Promise<EraseProbeResult>((resolve) => {
    const child = spawn(resolveFfprobePath(), [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filePath,
    ])

    const stdoutChunks: Buffer[] = []
    let settled = false

    child.stdout?.on('data', (c: Buffer) => { stdoutChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)) })
    child.stderr?.on('data', () => { /* swallow; we map any failure to PROBE_FAILED */ })

    const settleFailed = () => {
      if (settled) return
      settled = true
      resolve({ filePath, filename, fileSize, durationSeconds: 0, warning: 'PROBE_FAILED' })
    }

    child.on('error', settleFailed)
    child.on('close', (code: number | null) => {
      if (settled) return
      if (code !== 0) { settleFailed(); return }
      try {
        const parsed = JSON.parse(Buffer.concat(stdoutChunks).toString('utf8')) as FormatProbeJson
        const raw = parsed?.format?.duration
        const num = Number(raw)
        if (!Number.isFinite(num) || num < 0) { settleFailed(); return }
        settled = true
        resolve({ filePath, filename, fileSize, durationSeconds: num })
      } catch {
        settleFailed()
      }
    })
  })
}

export async function probeBatch(paths: string[]): Promise<EraseProbeResult[]> {
  if (paths.length === 0) return []

  const results: EraseProbeResult[] = new Array(paths.length)
  let cursor = 0

  // Inline semaphore: spawn up to PROBE_CONCURRENCY workers; each worker
  // pulls the next index until cursor exhausts. Keeps probe.ts self-contained
  // (plan §Task 3 explicitly says do NOT import the shared JobQueue here).
  async function worker() {
    while (true) {
      const i = cursor++
      if (i >= paths.length) return
      results[i] = await probeOne(paths[i])
    }
  }

  const workers = Array.from(
    { length: Math.min(PROBE_CONCURRENCY, paths.length) },
    () => worker(),
  )
  await Promise.all(workers)
  return results
}

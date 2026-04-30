import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import * as path from 'node:path'
import ffprobeStatic from 'ffprobe-static'
import type { EraseProbeResult } from '../../../types/smartErase'

const PROBE_CONCURRENCY = 4
const PROBE_TIMEOUT_MS = 30_000

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
    console.warn('[probe] empty filePath')
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
  } catch (err: any) {
    console.warn('[probe] statSync failed:', filePath, err?.code, err?.message)
    return Promise.resolve({
      filePath,
      filename,
      fileSize: 0,
      durationSeconds: 0,
      warning: 'FILE_NOT_LOCAL',
    })
  }

  // Resolve binary OUTSIDE the Promise executor so a missing-binary scenario
  // returns a per-file PROBE_FAILED rather than rejecting the whole batch.
  // (Plan §Task 3 review I-2: graceful degradation contract.)
  let bin: string
  try { bin = resolveFfprobePath() }
  catch (err: any) {
    console.warn('[probe] resolveFfprobePath threw:', err?.message)
    return Promise.resolve({ filePath, filename, fileSize, durationSeconds: 0, warning: 'PROBE_FAILED' })
  }
  console.log('[probe] spawn', { bin, filePath, fileSize })

  return new Promise<EraseProbeResult>((resolve) => {
    const child = spawn(bin, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filePath,
    ])

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let settled = false

    // Watchdog: a hung ffprobe (e.g. Windows OneDrive cloud-only file where
    // statSync passes but the byte read blocks on download) would otherwise
    // tie up a worker slot indefinitely and stall Task 8's cost dialog.
    // Mirrors posterGen's POSTER_TIMEOUT pattern.
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      console.warn('[probe] timeout after', PROBE_TIMEOUT_MS, 'ms', filePath)
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      resolve({ filePath, filename, fileSize, durationSeconds: 0, warning: 'PROBE_FAILED' })
    }, PROBE_TIMEOUT_MS)

    child.stdout?.on('data', (c: Buffer) => { stdoutChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)) })
    child.stderr?.on('data', (c: Buffer) => { stderrChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)) })

    const settleFailed = (reason: string, extra?: Record<string, unknown>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim().slice(0, 500)
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim().slice(0, 500)
      console.warn('[probe] FAILED', { reason, filePath, fileSize, stderr, stdout, ...extra })
      resolve({ filePath, filename, fileSize, durationSeconds: 0, warning: 'PROBE_FAILED' })
    }

    child.on('error', (err) => settleFailed('spawn-error', { errCode: (err as any)?.code, errMessage: err?.message }))
    child.on('close', (code: number | null) => {
      if (settled) return
      if (code !== 0) { settleFailed('non-zero-exit', { code }); return }
      try {
        const parsed = JSON.parse(Buffer.concat(stdoutChunks).toString('utf8')) as FormatProbeJson
        const raw = parsed?.format?.duration
        const num = Number(raw)
        if (!Number.isFinite(num) || num < 0) {
          settleFailed('invalid-duration', { raw, num })
          return
        }
        settled = true
        clearTimeout(timer)
        resolve({ filePath, filename, fileSize, durationSeconds: num })
      } catch (err: any) {
        settleFailed('json-parse-failed', { errMessage: err?.message })
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

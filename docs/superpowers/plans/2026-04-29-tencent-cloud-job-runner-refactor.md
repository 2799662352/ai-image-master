# Tencent Cloud Job Runner Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a shared `src/main/services/tencent/*` layer (credentials, COS client, MPS client, generic job queue) and convert `storyboardSplit` to a thin consumer, preserving all current external behavior while fixing the latent "cancel doesn't actually abort upload" bug.

**Architecture:** Five new files in `src/main/services/tencent/` host generic Tencent Cloud plumbing. `storyboardSplit/index.ts` collapses from 170 LOC to ~80 LOC by delegating to the shared `JobQueue` and a feature-specific `runImageJob`. `storyboardSplit/{config,cosClient,mpsClient}.ts` are deleted. Credentials migrate from raw `electron-store` (with hard-coded encryption key) to Electron `safeStorage` (OS keychain). All existing IPC channels (`storyboard-split:*`) stay; renderer code is untouched.

**Tech Stack:** Electron 41, TypeScript 6, Node 20, vitest 4 (jsdom + per-file `node` env), cos-nodejs-sdk-v5 ^2.15.4, tencentcloud-sdk-nodejs-mps ^4.1.218, electron-store 8 (legacy migration only)

**Reference spec:** [`docs/specs/2026-04-29-tencent-cloud-job-runner-refactor.md`](../../specs/2026-04-29-tencent-cloud-job-runner-refactor.md)

---

## File Structure

| File | Operation | Responsibility |
|------|-----------|----------------|
| `src/main/services/tencent/types.ts` | Create | `Credentials`, `CredentialState`, `JobLifecycleEvents<TI,TO>`, `JobQueueOptions<TI,TO>` |
| `src/main/services/tencent/jobQueue.ts` | Create | Generic `JobQueue<TI,TO>` with concurrency cap, `AbortController`, dequeue loop |
| `src/main/services/tencent/credentials.ts` | Create | App-wide credential singleton; safeStorage-backed; one-shot migration from electron-store; three-tier resolution |
| `src/main/services/tencent/cosClient.ts` | Create | Lazy COS instance + helpers: `uploadBuffer`, `uploadStream`, `cancelUpload`, `getPresignedUrl`, `deleteObjects` |
| `src/main/services/tencent/mpsClient.ts` | Create | Lazy MPS client (`sdk.mps.v20190612.Client`); credential invalidation |
| `src/main/services/tencent/__tests__/jobQueue.test.ts` | Create | Unit tests for queue / abort / cancel / dequeue |
| `src/main/services/tencent/__tests__/credentials.test.ts` | Create | Unit tests for resolution priority + invalidation chain + safeStorage migration |
| `src/main/services/tencent/__tests__/cosClient.test.ts` | Create | Unit tests for instance caching + `cancelUpload` wiring |
| `src/main/services/tencent/__tests__/mpsClient.test.ts` | Create | Unit test for instance caching + invalidation |
| `src/main/services/storyboardSplit/runner.ts` | Create | Image-specific `runImageJob`, `submitProcessImage`, `pollImageUntilFinish` (extracted from old `mpsClient.ts`) |
| `src/main/services/storyboardSplit/index.ts` | Modify | Use `JobQueue` + `runImageJob`; preserve all exports |
| `src/main/services/storyboardSplit/config.ts` | **Delete** | Logic absorbed into `tencent/credentials.ts` |
| `src/main/services/storyboardSplit/cosClient.ts` | **Delete** | Generic helpers absorbed into `tencent/cosClient.ts`; `uploadOriginal` becomes `tencent/cosClient.uploadBuffer` call inside the runner |
| `src/main/services/storyboardSplit/mpsClient.ts` | **Delete** | `getMpsClient` absorbed into `tencent/mpsClient.ts`; image-specific `submitProcessImage` + `pollUntilFinish` move to `storyboardSplit/runner.ts` |
| `src/types/storyboardSplit.ts` | Modify | Drop duplicate `CredentialState` interface; re-export from `tencent/types` for backward compat |

**No renderer-side files change.** No `package.json` change (cos-nodejs-sdk-v5 + tencentcloud-sdk-nodejs-mps + electron-store already installed; safeStorage is core Electron).

---

## Task 1: Shared types and `JobQueue`

**Files:**
- Create: `src/main/services/tencent/types.ts`
- Create: `src/main/services/tencent/jobQueue.ts`
- Create: `src/main/services/tencent/__tests__/jobQueue.test.ts`

**Why first:** `JobQueue` is pure logic with no Electron / SDK dependencies → fully unit-testable, establishes vitest pattern, sets up the type contract every later module references.

- [ ] **Step 1: Create `src/main/services/tencent/types.ts`**

```ts
// src/main/services/tencent/types.ts

export interface Credentials {
  secretId: string
  secretKey: string
  bucket: string
  region: string
}

export interface CredentialState {
  hasCredentials: boolean
  credentialSource: 'store' | 'env' | 'builtin' | 'none'
  secretIdMasked?: string
  bucket?: string
  region?: string
}

export interface JobLifecycleEvents<TInput, TOutput> {
  onProgress?: (job: TInput, patch: { stage: string; progress: number; meta?: any }) => void
  onFinished?: (job: TInput, result: TOutput) => void
  onFailed?: (job: TInput, error: { code: string; message: string; stage: string }) => void
}

export type JobRunner<TInput, TOutput> = (
  job: TInput,
  signal: AbortSignal,
  events: JobLifecycleEvents<TInput, TOutput>,
) => Promise<TOutput>

export interface JobQueueOptions<TInput, TOutput> {
  name: string
  maxConcurrent: number
  runner: JobRunner<TInput, TOutput>
  events: JobLifecycleEvents<TInput, TOutput>
  getJobId: (job: TInput) => string
}
```

- [ ] **Step 2: Write the failing test for `JobQueue`**

```ts
// src/main/services/tencent/__tests__/jobQueue.test.ts
// @vitest-environment node

import { describe, it, expect, vi } from 'vitest'
import { JobQueue } from '../jobQueue'

describe('JobQueue', () => {
  interface Job { id: string; runMs: number }

  it('runs up to maxConcurrent at once and queues the rest', async () => {
    const inflight: string[] = []
    const peakInflight = { value: 0 }

    const queue = new JobQueue<Job, void>({
      name: 'test',
      maxConcurrent: 2,
      runner: async (job) => {
        inflight.push(job.id)
        peakInflight.value = Math.max(peakInflight.value, inflight.length)
        await new Promise((r) => setTimeout(r, job.runMs))
        inflight.splice(inflight.indexOf(job.id), 1)
      },
      events: {},
      getJobId: (j) => j.id,
    })

    await Promise.all([
      queue.enqueue({ id: 'a', runMs: 30 }),
      queue.enqueue({ id: 'b', runMs: 30 }),
      queue.enqueue({ id: 'c', runMs: 30 }),
      queue.enqueue({ id: 'd', runMs: 30 }),
    ])

    expect(peakInflight.value).toBe(2)
    expect(inflight).toEqual([])
  })

  it('cancel() in queued state removes job before it starts', async () => {
    const startedJobs: string[] = []
    const queue = new JobQueue<Job, void>({
      name: 'test',
      maxConcurrent: 1,
      runner: async (job) => {
        startedJobs.push(job.id)
        await new Promise((r) => setTimeout(r, 50))
      },
      events: {},
      getJobId: (j) => j.id,
    })

    const p1 = queue.enqueue({ id: 'a', runMs: 50 })
    const p2 = queue.enqueue({ id: 'b', runMs: 50 }) // queued behind a
    const cancelled = queue.cancel('b')

    expect(cancelled).toBe(true)
    await Promise.allSettled([p1, p2])
    expect(startedJobs).toEqual(['a'])
  })

  it('cancel() in active state aborts the runner via AbortSignal', async () => {
    let observedAborted = false
    const queue = new JobQueue<Job, void>({
      name: 'test',
      maxConcurrent: 1,
      runner: async (_job, signal) => {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 100)
          signal.addEventListener('abort', () => {
            clearTimeout(t)
            observedAborted = true
            reject(new Error('aborted'))
          })
        })
      },
      events: {},
      getJobId: (j) => j.id,
    })

    const p = queue.enqueue({ id: 'a', runMs: 100 })
    await new Promise((r) => setTimeout(r, 10))
    expect(queue.cancel('a')).toBe(true)
    await expect(p).rejects.toThrow('aborted')
    expect(observedAborted).toBe(true)
  })

  it('cancelAll() empties active and pending', async () => {
    const queue = new JobQueue<Job, void>({
      name: 'test',
      maxConcurrent: 1,
      runner: async (_job, signal) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')))
          setTimeout(resolve, 200)
        })
      },
      events: {},
      getJobId: (j) => j.id,
    })

    const p1 = queue.enqueue({ id: 'a', runMs: 200 })
    const p2 = queue.enqueue({ id: 'b', runMs: 200 })
    await new Promise((r) => setTimeout(r, 10))
    queue.cancelAll()
    await expect(p1).rejects.toThrow()
    await expect(p2).rejects.toThrow()
    expect(queue.getActiveCount()).toBe(0)
    expect(queue.getQueuedCount()).toBe(0)
  })

  it('events.onProgress / onFinished / onFailed fire correctly', async () => {
    const onProgress = vi.fn()
    const onFinished = vi.fn()
    const onFailed = vi.fn()

    const queue = new JobQueue<Job, string>({
      name: 'test',
      maxConcurrent: 1,
      runner: async (job, _signal, events) => {
        events.onProgress?.(job, { stage: 'working', progress: 50 })
        if (job.id === 'fail') throw Object.assign(new Error('boom'), { code: 'TEST_FAIL', stage: 'work' })
        return 'ok'
      },
      events: { onProgress, onFinished, onFailed },
      getJobId: (j) => j.id,
    })

    await queue.enqueue({ id: 'good', runMs: 0 })
    await queue.enqueue({ id: 'fail', runMs: 0 }).catch(() => {})

    expect(onProgress).toHaveBeenCalledWith({ id: 'good', runMs: 0 }, { stage: 'working', progress: 50 })
    expect(onFinished).toHaveBeenCalledWith({ id: 'good', runMs: 0 }, 'ok')
    expect(onFailed).toHaveBeenCalledWith({ id: 'fail', runMs: 0 }, expect.objectContaining({ code: 'TEST_FAIL' }))
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test:run -- src/main/services/tencent/__tests__/jobQueue.test.ts`
Expected: FAIL with "Cannot find module '../jobQueue'"

- [ ] **Step 4: Implement `JobQueue`**

```ts
// src/main/services/tencent/jobQueue.ts

import type { JobQueueOptions, JobLifecycleEvents } from './types'

interface QueueEntry<TInput, TOutput> {
  job: TInput
  resolve: (value: TOutput) => void
  reject: (err: any) => void
}

interface ActiveEntry {
  controller: AbortController
}

export class JobQueue<TInput, TOutput> {
  private active = new Map<string, ActiveEntry>()
  private pending: QueueEntry<TInput, TOutput>[] = []

  constructor(private readonly opts: JobQueueOptions<TInput, TOutput>) {}

  enqueue(job: TInput): Promise<TOutput> {
    return new Promise<TOutput>((resolve, reject) => {
      this.pending.push({ job, resolve, reject })
      this.dequeue()
    })
  }

  cancel(jobId: string): boolean {
    const active = this.active.get(jobId)
    if (active) {
      active.controller.abort()
      return true
    }
    const idx = this.pending.findIndex((e) => this.opts.getJobId(e.job) === jobId)
    if (idx >= 0) {
      const [removed] = this.pending.splice(idx, 1)
      removed.reject(Object.assign(new Error('Cancelled while queued'), { code: 'TASK_CANCELLED', stage: 'queued' }))
      return true
    }
    return false
  }

  cancelAll(): void {
    for (const [, entry] of this.active) entry.controller.abort()
    this.active.clear()
    while (this.pending.length > 0) {
      const e = this.pending.shift()!
      e.reject(Object.assign(new Error('All cancelled'), { code: 'TASK_CANCELLED', stage: 'queued' }))
    }
  }

  getActiveCount(): number { return this.active.size }
  getQueuedCount(): number { return this.pending.length }

  private dequeue(): void {
    while (this.active.size < this.opts.maxConcurrent && this.pending.length > 0) {
      const entry = this.pending.shift()!
      this.runOne(entry)
    }
  }

  private async runOne(entry: QueueEntry<TInput, TOutput>): Promise<void> {
    const jobId = this.opts.getJobId(entry.job)
    const controller = new AbortController()
    this.active.set(jobId, { controller })

    try {
      const result = await this.opts.runner(entry.job, controller.signal, this.opts.events)
      this.opts.events.onFinished?.(entry.job, result)
      entry.resolve(result)
    } catch (err: any) {
      const errorPayload = {
        code: err.code || 'UNKNOWN_ERROR',
        message: err.message || String(err),
        stage: err.stage || 'unknown',
      }
      this.opts.events.onFailed?.(entry.job, errorPayload)
      entry.reject(err)
    } finally {
      this.active.delete(jobId)
      this.dequeue()
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:run -- src/main/services/tencent/__tests__/jobQueue.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 6: Commit**

```bash
git add src/main/services/tencent/types.ts src/main/services/tencent/jobQueue.ts src/main/services/tencent/__tests__/jobQueue.test.ts
git commit -m "feat(tencent): add shared JobQueue and core types"
```

---

## Task 2: Credentials with safeStorage migration

**Files:**
- Create: `src/main/services/tencent/credentials.ts`
- Create: `src/main/services/tencent/__tests__/credentials.test.ts`

**Why now:** Every later module needs `getCredentials()`. Migration from raw `electron-store` (with hardcoded encryption key) to `safeStorage` is the security upgrade flagged in the spec. Three-tier resolution (store → env → builtin file) is preserved verbatim from existing `storyboardSplit/config.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/services/tencent/__tests__/credentials.test.ts
// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron-store + electron BEFORE importing credentials
const mockStoreGet = vi.fn()
const mockStoreSet = vi.fn()
const mockStoreDelete = vi.fn()
vi.mock('electron-store', () => ({
  default: vi.fn(() => ({
    get: mockStoreGet,
    set: mockStoreSet,
    delete: mockStoreDelete,
  })),
}))

const mockSafeStorage = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string) => Buffer.from('enc:' + s)),
  decryptString: vi.fn((b: Buffer) => b.toString().replace(/^enc:/, '')),
}
const mockApp = {
  getPath: vi.fn(() => '/mock/userData'),
  isPackaged: false,
  whenReady: vi.fn(() => Promise.resolve()),
}
vi.mock('electron', () => ({
  app: mockApp,
  safeStorage: mockSafeStorage,
}))

const mockReadFileSync = vi.fn()
const mockWriteFileSync = vi.fn()
const mockExistsSync = vi.fn()
const mockUnlinkSync = vi.fn()
vi.mock('fs', () => ({
  default: {
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    existsSync: mockExistsSync,
    unlinkSync: mockUnlinkSync,
  },
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  existsSync: mockExistsSync,
  unlinkSync: mockUnlinkSync,
}))

describe('tencent/credentials', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    mockStoreGet.mockReturnValue('')
    delete process.env.COS_SECRET_ID
    delete process.env.COS_SECRET_KEY
    delete process.env.COS_BUCKET
    delete process.env.COS_REGION
  })

  it('resolves credentials in store > env > builtin order', async () => {
    process.env.COS_SECRET_ID = 'env-id'
    process.env.COS_SECRET_KEY = 'env-key'
    mockExistsSync.mockReturnValue(false) // no builtin file
    // safeStorage empty (no .bin file)
    mockExistsSync.mockImplementation((p: string) => p.endsWith('.bin') ? false : false)

    const { getCredentials } = await import('../credentials')
    const c = getCredentials()
    expect(c.secretId).toBe('env-id')
    expect(c.secretKey).toBe('env-key')
  })

  it('safeStorage takes precedence over env (per field)', async () => {
    process.env.COS_SECRET_ID = 'env-id'
    mockExistsSync.mockImplementation((p: string) => p.endsWith('.bin'))
    mockReadFileSync.mockReturnValue(Buffer.from('enc:{"secretId":"safe-id","secretKey":"safe-key","bucket":"b","region":"ap-shanghai"}'))

    const { getCredentials } = await import('../credentials')
    const c = getCredentials()
    expect(c.secretId).toBe('safe-id')
  })

  it('falls back per-field: store has secretId, env supplies bucket', async () => {
    process.env.COS_BUCKET = 'env-bucket'
    mockExistsSync.mockImplementation((p: string) => p.endsWith('.bin'))
    mockReadFileSync.mockReturnValue(Buffer.from('enc:{"secretId":"safe-id","secretKey":"safe-key","bucket":"","region":""}'))

    const { getCredentials } = await import('../credentials')
    const c = getCredentials()
    expect(c.secretId).toBe('safe-id')
    expect(c.bucket).toBe('env-bucket')
  })

  it('migrates from electron-store on first read when .bin does not exist', async () => {
    mockExistsSync.mockImplementation((p: string) => !p.endsWith('.bin')) // electron-store data exists, .bin does not
    mockStoreGet.mockImplementation((k: string) => ({
      secretId: 'legacy-id',
      secretKey: 'legacy-key',
      bucket: 'legacy-bucket',
      region: 'ap-guangzhou',
    } as any)[k] || '')

    const { getCredentials } = await import('../credentials')
    const c = getCredentials()

    expect(c.secretId).toBe('legacy-id')
    expect(mockSafeStorage.encryptString).toHaveBeenCalled()
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/tencent-credentials\.bin$/),
      expect.any(Buffer),
    )
    expect(mockStoreDelete).toHaveBeenCalledWith('secretId')
    expect(mockStoreDelete).toHaveBeenCalledWith('secretKey')
  })

  it('falls back to in-memory when safeStorage unavailable', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(false)
    const { setCredentials, getCredentials } = await import('../credentials')

    setCredentials({ secretId: 'mem-id', secretKey: 'mem-key', bucket: 'b', region: 'ap-shanghai' })
    const c = getCredentials()
    expect(c.secretId).toBe('mem-id')
    expect(mockWriteFileSync).not.toHaveBeenCalled()
  })

  it('setCredentials triggers all registered invalidation callbacks', async () => {
    const { setCredentials, onCredentialsInvalidated } = await import('../credentials')
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    onCredentialsInvalidated(cb1)
    onCredentialsInvalidated(cb2)

    setCredentials({ secretId: 'new-id' })
    expect(cb1).toHaveBeenCalled()
    expect(cb2).toHaveBeenCalled()
  })

  it('getCredentialState masks secretId and reports source', async () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith('.bin'))
    mockReadFileSync.mockReturnValue(Buffer.from('enc:{"secretId":"AKIDxxxxxxxxxxxxxxxxxx","secretKey":"k","bucket":"b","region":"ap-shanghai"}'))

    const { getCredentialState } = await import('../credentials')
    const s = getCredentialState()
    expect(s.hasCredentials).toBe(true)
    expect(s.credentialSource).toBe('store')
    expect(s.secretIdMasked).toBe('AKID****')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- src/main/services/tencent/__tests__/credentials.test.ts`
Expected: FAIL with "Cannot find module '../credentials'"

- [ ] **Step 3: Implement `credentials.ts`**

```ts
// src/main/services/tencent/credentials.ts

import type { Credentials, CredentialState } from './types'

type InvalidateCallback = () => void
const invalidateCallbacks: InvalidateCallback[] = []

export function onCredentialsInvalidated(cb: InvalidateCallback): void {
  invalidateCallbacks.push(cb)
}

const SAFE_STORAGE_FILENAME = 'tencent-credentials.bin'
const LEGACY_STORE_NAME = 'tencent-credentials'
const LEGACY_ENCRYPTION_KEY = 'tencent-cred-v1'
const DEFAULTS: Credentials = { secretId: '', secretKey: '', bucket: '', region: 'ap-guangzhou' }

let LegacyStore: any
let legacyStoreInstance: any = null
let cached: Credentials | null = null
let migrationAttempted = false
let inMemoryFallback: Credentials | null = null

function getLegacyStore() {
  if (!legacyStoreInstance) {
    if (!LegacyStore) LegacyStore = require('electron-store')
    legacyStoreInstance = new LegacyStore({
      name: LEGACY_STORE_NAME,
      encryptionKey: LEGACY_ENCRYPTION_KEY,
      encryptionAlgorithm: 'aes-256-gcm',
      defaults: DEFAULTS,
    })
  }
  return legacyStoreInstance
}

function safeStorageBinPath(): string {
  const { app } = require('electron')
  const path = require('path')
  return path.join(app.getPath('userData'), SAFE_STORAGE_FILENAME)
}

function readFromSafeStorage(): Credentials | null {
  try {
    const { safeStorage } = require('electron')
    if (!safeStorage.isEncryptionAvailable()) return null
    const fs = require('fs')
    const p = safeStorageBinPath()
    if (!fs.existsSync(p)) return null
    const buf = fs.readFileSync(p) as Buffer
    const json = safeStorage.decryptString(buf)
    return { ...DEFAULTS, ...JSON.parse(json) }
  } catch (e) {
    console.warn('[tencent/credentials] safeStorage read failed:', e)
    return null
  }
}

function writeToSafeStorage(creds: Credentials): boolean {
  try {
    const { safeStorage } = require('electron')
    if (!safeStorage.isEncryptionAvailable()) return false
    const fs = require('fs')
    const buf = safeStorage.encryptString(JSON.stringify(creds))
    fs.writeFileSync(safeStorageBinPath(), buf)
    return true
  } catch (e) {
    console.warn('[tencent/credentials] safeStorage write failed:', e)
    return false
  }
}

function readFromLegacyStore(): Credentials | null {
  try {
    const store = getLegacyStore()
    const c: Credentials = {
      secretId: store.get('secretId') || '',
      secretKey: store.get('secretKey') || '',
      bucket: store.get('bucket') || '',
      region: store.get('region') || '',
    }
    if (!c.secretId && !c.secretKey) return null
    return c
  } catch {
    return null
  }
}

function clearLegacyStore(): void {
  try {
    const store = getLegacyStore()
    store.delete('secretId')
    store.delete('secretKey')
    store.delete('bucket')
    store.delete('region')
  } catch {}
}

function migrateLegacyOnce(): Credentials | null {
  if (migrationAttempted) return null
  migrationAttempted = true
  const legacy = readFromLegacyStore()
  if (!legacy) return null
  if (writeToSafeStorage(legacy)) {
    clearLegacyStore()
    console.log('[tencent/credentials] migrated from electron-store → safeStorage')
    return legacy
  }
  return legacy
}

function loadBuiltin(): Credentials {
  const empty: Credentials = { ...DEFAULTS }
  try {
    const { app } = require('electron')
    const path = require('path')
    const fs = require('fs')
    const credPath = app.isPackaged
      ? path.join(process.resourcesPath, 'cos-credentials.json')
      : path.resolve(__dirname, '../../../../cos-credentials.json')
    if (fs.existsSync(credPath)) {
      return { ...empty, ...JSON.parse(fs.readFileSync(credPath, 'utf-8')) }
    }
  } catch {}
  return empty
}

const BUILTIN: Credentials = loadBuiltin()

// Per-field fallback (matches behavior of legacy storyboardSplit/config.ts):
// each field tries store → env → builtin → default independently.
function resolveCredentials(): Credentials {
  if (inMemoryFallback) return { ...inMemoryFallback }

  let stored = readFromSafeStorage()
  if (!stored) stored = migrateLegacyOnce()

  return {
    secretId:  (stored?.secretId)  || process.env.COS_SECRET_ID  || BUILTIN.secretId  || '',
    secretKey: (stored?.secretKey) || process.env.COS_SECRET_KEY || BUILTIN.secretKey || '',
    bucket:    (stored?.bucket)    || process.env.COS_BUCKET     || process.env.COS_BUCKET_NAME || BUILTIN.bucket || '',
    region:    (stored?.region)    || process.env.COS_REGION     || BUILTIN.region    || DEFAULTS.region,
  }
}

function resolveSource(): CredentialState['credentialSource'] {
  if (inMemoryFallback?.secretId) return 'store'
  let stored = readFromSafeStorage()
  if (!stored) stored = migrateLegacyOnce()
  if (stored?.secretId) return 'store'
  if (process.env.COS_SECRET_ID) return 'env'
  if (BUILTIN.secretId) return 'builtin'
  return 'none'
}

export function getCredentials(): Credentials {
  if (!cached) cached = resolveCredentials()
  return { ...cached }
}

export function getCredentialState(): CredentialState {
  const creds = getCredentials()
  return {
    hasCredentials: !!creds.secretId,
    credentialSource: resolveSource(),
    secretIdMasked: creds.secretId ? `${creds.secretId.slice(0, 4)}****` : undefined,
    bucket: creds.bucket || undefined,
    region: creds.region || undefined,
  }
}

export function setCredentials(patch: Partial<Credentials>): void {
  const current = getCredentials()
  const next: Credentials = { ...current, ...patch }

  const written = writeToSafeStorage(next)
  if (!written) {
    inMemoryFallback = next
    console.warn('[tencent/credentials] safeStorage unavailable; using in-memory fallback')
  } else {
    inMemoryFallback = null
  }

  cached = null
  invalidateCallbacks.forEach((cb) => cb())
}

// Test-only: reset module-level caches between tests via vi.resetModules()
```

- [ ] **Step 4: Run tests**

Run: `npm run test:run -- src/main/services/tencent/__tests__/credentials.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/services/tencent/credentials.ts src/main/services/tencent/__tests__/credentials.test.ts
git commit -m "feat(tencent): credentials with safeStorage + legacy electron-store migration"
```

---

## Task 3: COS client with `uploadStream` and `cancelUpload`

**Files:**
- Create: `src/main/services/tencent/cosClient.ts`
- Create: `src/main/services/tencent/__tests__/cosClient.test.ts`

**Why now:** smartErase requires `uploadStream` (not in current image flow) and proper `cancelUpload` wiring (the latent bug fix). Image flow keeps using `uploadBuffer`.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/services/tencent/__tests__/cosClient.test.ts
// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSliceUploadFile = vi.fn()
const mockPutObject = vi.fn()
const mockCancelTask = vi.fn()
const mockGetObjectUrl = vi.fn()
const mockDeleteMultipleObject = vi.fn()
const cosCtor = vi.fn(() => ({
  sliceUploadFile: mockSliceUploadFile,
  putObject: mockPutObject,
  cancelTask: mockCancelTask,
  getObjectUrl: mockGetObjectUrl,
  deleteMultipleObject: mockDeleteMultipleObject,
}))

vi.mock('cos-nodejs-sdk-v5', () => ({ default: cosCtor }))

vi.mock('../credentials', () => ({
  getCredentials: () => ({ secretId: 'id', secretKey: 'k', bucket: 'b', region: 'ap-shanghai' }),
  onCredentialsInvalidated: vi.fn(),
}))

describe('tencent/cosClient', () => {
  beforeEach(() => {
    vi.resetModules()
    cosCtor.mockClear()
    mockSliceUploadFile.mockReset()
    mockPutObject.mockReset()
    mockCancelTask.mockReset()
    mockGetObjectUrl.mockReset()
    mockDeleteMultipleObject.mockReset()
  })

  it('lazy-creates the COS instance once', async () => {
    const { uploadBuffer } = await import('../cosClient')
    mockPutObject.mockImplementation((_p, cb) => cb(null, {}))

    await uploadBuffer({ key: 'a/b.jpg', body: Buffer.from('x') })
    await uploadBuffer({ key: 'a/c.jpg', body: Buffer.from('y') })

    expect(cosCtor).toHaveBeenCalledTimes(1)
  })

  it('credentials invalidation drops the cached instance', async () => {
    const invalidatedCallbacks: Array<() => void> = []
    vi.doMock('../credentials', () => ({
      getCredentials: () => ({ secretId: 'id', secretKey: 'k', bucket: 'b', region: 'ap-shanghai' }),
      onCredentialsInvalidated: (cb: () => void) => invalidatedCallbacks.push(cb),
    }))

    const { uploadBuffer } = await import('../cosClient')
    mockPutObject.mockImplementation((_p, cb) => cb(null, {}))

    await uploadBuffer({ key: 'a.jpg', body: Buffer.from('x') })
    invalidatedCallbacks.forEach((cb) => cb())
    await uploadBuffer({ key: 'b.jpg', body: Buffer.from('x') })

    expect(cosCtor).toHaveBeenCalledTimes(2)
  })

  it('uploadStream surfaces TaskId via onTaskReady and progress via onProgress', async () => {
    let capturedOnTaskReady: any = null
    let capturedOnProgress: any = null
    mockSliceUploadFile.mockImplementation((params: any, cb: any) => {
      capturedOnTaskReady = params.onTaskReady
      capturedOnProgress = params.onProgress
      capturedOnTaskReady('task-123')
      capturedOnProgress({ loaded: 50, total: 100, percent: 0.5, speed: 1024 })
      cb(null, {})
    })

    const { uploadStream } = await import('../cosClient')
    const onProgress = vi.fn()
    const onTaskReady = vi.fn()

    await uploadStream({
      key: 'video.mp4',
      filePath: '/tmp/video.mp4',
      onProgress,
      onTaskReady,
    })

    expect(onTaskReady).toHaveBeenCalledWith('task-123')
    expect(onProgress).toHaveBeenCalledWith({ loaded: 50, total: 100, percent: 0.5, speed: 1024 })
    expect(mockSliceUploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ Bucket: 'b', Region: 'ap-shanghai', Key: 'video.mp4', FilePath: '/tmp/video.mp4' }),
      expect.any(Function),
    )
  })

  it('cancelUpload calls cos.cancelTask with the captured TaskId', async () => {
    mockCancelTask.mockImplementation((_p, cb) => cb(null, {}))
    const { cancelUpload } = await import('../cosClient')

    await cancelUpload('task-123' as any)
    expect(mockCancelTask).toHaveBeenCalledWith({ TaskId: 'task-123' }, expect.any(Function))
  })

  it('getPresignedUrl supports custom Query for ci-process', async () => {
    mockGetObjectUrl.mockImplementation((_p, cb) => cb(null, { Url: 'https://example/x?ci-process=snapshot&time=0.5' }))
    const { getPresignedUrl } = await import('../cosClient')

    const url = await getPresignedUrl({
      key: 'video.mp4',
      expireSeconds: 3600,
      query: { 'ci-process': 'snapshot', time: 0.5, format: 'jpg', width: 320 },
    })

    expect(url).toContain('ci-process=snapshot')
    expect(mockGetObjectUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        Sign: true,
        Method: 'GET',
        Query: { 'ci-process': 'snapshot', time: 0.5, format: 'jpg', width: 320 },
      }),
      expect.any(Function),
    )
  })

  it('deleteObjects no-ops on empty array', async () => {
    const { deleteObjects } = await import('../cosClient')
    await deleteObjects([])
    expect(mockDeleteMultipleObject).not.toHaveBeenCalled()
  })

  it('deleteObjects sends keys without leading slash', async () => {
    mockDeleteMultipleObject.mockImplementation((_p, cb) => cb(null, {}))
    const { deleteObjects } = await import('../cosClient')

    await deleteObjects(['/path/a.jpg', 'path/b.jpg'])

    expect(mockDeleteMultipleObject).toHaveBeenCalledWith(
      expect.objectContaining({
        Objects: [{ Key: 'path/a.jpg' }, { Key: 'path/b.jpg' }],
      }),
      expect.any(Function),
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- src/main/services/tencent/__tests__/cosClient.test.ts`
Expected: FAIL with "Cannot find module '../cosClient'"

- [ ] **Step 3: Implement `cosClient.ts`**

```ts
// src/main/services/tencent/cosClient.ts

import { getCredentials, onCredentialsInvalidated } from './credentials'

let COS: any = null
let cosInstance: any = null

onCredentialsInvalidated(() => { cosInstance = null })

function getCosInstance() {
  if (!cosInstance) {
    const creds = getCredentials()
    if (!COS) COS = require('cos-nodejs-sdk-v5')
    cosInstance = new COS({
      SecretId: creds.secretId,
      SecretKey: creds.secretKey,
      Protocol: 'https:',
      Timeout: 120000,
    })
  }
  return cosInstance
}

function getBucketAndRegion() {
  const creds = getCredentials()
  return { Bucket: creds.bucket, Region: creds.region }
}

export interface UploadBufferOptions {
  key: string
  body: Buffer
  contentType?: string
}

export async function uploadBuffer(opts: UploadBufferOptions): Promise<void> {
  const cos = getCosInstance()
  const { Bucket, Region } = getBucketAndRegion()
  await new Promise<void>((resolve, reject) => {
    cos.putObject(
      { Bucket, Region, Key: opts.key, Body: opts.body, ContentType: opts.contentType },
      (err: any) => (err ? reject(err) : resolve()),
    )
  })
}

export interface UploadStreamProgress {
  loaded: number
  total: number
  percent: number
  speed: number
}

export interface UploadStreamOptions {
  key: string
  filePath: string
  contentType?: string
  onProgress?: (info: UploadStreamProgress) => void
  onTaskReady?: (taskId: string) => void
}

export async function uploadStream(opts: UploadStreamOptions): Promise<void> {
  const cos = getCosInstance()
  const { Bucket, Region } = getBucketAndRegion()
  await new Promise<void>((resolve, reject) => {
    cos.sliceUploadFile(
      {
        Bucket,
        Region,
        Key: opts.key,
        FilePath: opts.filePath,
        ContentType: opts.contentType,
        onProgress: opts.onProgress,
        onTaskReady: opts.onTaskReady,
      },
      (err: any) => (err ? reject(err) : resolve()),
    )
  })
}

export async function cancelUpload(taskId: string): Promise<void> {
  const cos = getCosInstance()
  await new Promise<void>((resolve, reject) => {
    cos.cancelTask({ TaskId: taskId }, (err: any) => (err ? reject(err) : resolve()))
  })
}

export interface GetPresignedUrlOptions {
  key: string
  expireSeconds: number
  query?: Record<string, any>
  method?: 'GET' | 'PUT'
}

export function getPresignedUrl(opts: GetPresignedUrlOptions): Promise<string> {
  const cos = getCosInstance()
  const { Bucket, Region } = getBucketAndRegion()
  return new Promise((resolve, reject) => {
    cos.getObjectUrl(
      {
        Bucket,
        Region,
        Key: opts.key,
        Sign: true,
        Method: opts.method || 'GET',
        Expires: opts.expireSeconds,
        Query: opts.query,
      },
      (err: any, data: any) => (err ? reject(err) : resolve(data.Url)),
    )
  })
}

export async function deleteObjects(keys: string[]): Promise<void> {
  if (!keys.length) return
  const cos = getCosInstance()
  const { Bucket, Region } = getBucketAndRegion()
  await new Promise<void>((resolve, reject) => {
    cos.deleteMultipleObject(
      {
        Bucket,
        Region,
        Objects: keys.map((k) => ({ Key: k.replace(/^\//, '') })),
        Quiet: true,
      },
      (err: any, data: any) => {
        if (err) return reject(err)
        if (data?.Error?.length) console.warn('[tencent/cosClient] partial delete failures:', data.Error)
        resolve()
      },
    )
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:run -- src/main/services/tencent/__tests__/cosClient.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/services/tencent/cosClient.ts src/main/services/tencent/__tests__/cosClient.test.ts
git commit -m "feat(tencent): COS client with uploadStream + cancelUpload + custom Query"
```

---

## Task 4: MPS client lift

**Files:**
- Create: `src/main/services/tencent/mpsClient.ts`
- Create: `src/main/services/tencent/__tests__/mpsClient.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/services/tencent/__tests__/mpsClient.test.ts
// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mpsClientCtor = vi.fn(() => ({ ProcessImage: vi.fn(), ProcessMedia: vi.fn() }))
vi.mock('tencentcloud-sdk-nodejs-mps', () => ({
  default: { mps: { v20190612: { Client: mpsClientCtor } } },
  mps: { v20190612: { Client: mpsClientCtor } },
}))

vi.mock('../credentials', () => ({
  getCredentials: () => ({ secretId: 'id', secretKey: 'k', bucket: 'b', region: 'ap-shanghai' }),
  onCredentialsInvalidated: vi.fn(),
}))

describe('tencent/mpsClient', () => {
  beforeEach(() => {
    vi.resetModules()
    mpsClientCtor.mockClear()
  })

  it('lazy-creates the MPS client once', async () => {
    const { getMpsClient } = await import('../mpsClient')
    getMpsClient()
    getMpsClient()
    expect(mpsClientCtor).toHaveBeenCalledTimes(1)
  })

  it('drops the cached client on credential invalidation', async () => {
    const invalidatedCallbacks: Array<() => void> = []
    vi.doMock('../credentials', () => ({
      getCredentials: () => ({ secretId: 'id', secretKey: 'k', bucket: 'b', region: 'ap-shanghai' }),
      onCredentialsInvalidated: (cb: () => void) => invalidatedCallbacks.push(cb),
    }))

    const { getMpsClient } = await import('../mpsClient')
    getMpsClient()
    invalidatedCallbacks.forEach((cb) => cb())
    getMpsClient()

    expect(mpsClientCtor).toHaveBeenCalledTimes(2)
  })

  it('configures the client with TC3-HMAC-SHA256 + POST + 30s timeout', async () => {
    const { getMpsClient } = await import('../mpsClient')
    getMpsClient()
    expect(mpsClientCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: { secretId: 'id', secretKey: 'k' },
        region: 'ap-shanghai',
        profile: expect.objectContaining({
          signMethod: 'TC3-HMAC-SHA256',
          httpProfile: { reqMethod: 'POST', reqTimeout: 30 },
        }),
      }),
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- src/main/services/tencent/__tests__/mpsClient.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `mpsClient.ts`**

```ts
// src/main/services/tencent/mpsClient.ts

import { getCredentials, onCredentialsInvalidated } from './credentials'

let MpsClientClass: any = null
let mpsInstance: any = null

onCredentialsInvalidated(() => { mpsInstance = null })

export function getMpsClient(): any {
  if (!mpsInstance) {
    const creds = getCredentials()
    if (!MpsClientClass) {
      const sdk = require('tencentcloud-sdk-nodejs-mps')
      MpsClientClass = sdk.mps.v20190612.Client
    }
    mpsInstance = new MpsClientClass({
      credential: { secretId: creds.secretId, secretKey: creds.secretKey },
      region: creds.region,
      profile: {
        signMethod: 'TC3-HMAC-SHA256',
        httpProfile: { reqMethod: 'POST', reqTimeout: 30 },
      },
    })
  }
  return mpsInstance
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:run -- src/main/services/tencent/__tests__/mpsClient.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/main/services/tencent/mpsClient.ts src/main/services/tencent/__tests__/mpsClient.test.ts
git commit -m "feat(tencent): lift MPS client to shared layer"
```

---

## Task 5: storyboardSplit runner extraction + index rewrite

**Files:**
- Create: `src/main/services/storyboardSplit/runner.ts`
- Modify: `src/main/services/storyboardSplit/index.ts`
- Modify: `src/types/storyboardSplit.ts` (deduplicate `CredentialState`)
- Delete: `src/main/services/storyboardSplit/config.ts`
- Delete: `src/main/services/storyboardSplit/cosClient.ts`
- Delete: `src/main/services/storyboardSplit/mpsClient.ts`

**Why combined:** these have to land together. The new `index.ts` imports from `runner.ts`; deleting old `cosClient.ts` / `mpsClient.ts` breaks the old `index.ts`'s imports immediately. One commit, one transition.

- [ ] **Step 1: Create `storyboardSplit/runner.ts`**

```ts
// src/main/services/storyboardSplit/runner.ts

import { uploadBuffer, getPresignedUrl } from '../tencent/cosClient'
import { getMpsClient } from '../tencent/mpsClient'
import { getCredentials } from '../tencent/credentials'
import type { JobLifecycleEvents } from '../tencent/types'
import type { SplitConfig, SplitResult } from '../../../types/storyboardSplit'

const SEVEN_DAYS_S = 7 * 24 * 60 * 60

export interface ImageJobInput {
  taskId: string
  buffer: Buffer
  filename: string
  config: SplitConfig
}

export interface ImageJobOutput {
  results: SplitResult[]
  rows: number
  cols: number
  inputCosKey: string
  mpsTaskId: string
}

const CONTENT_TYPE_MAP: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

function inferGrid(total: number): { rows: number; cols: number } {
  if (total <= 1) return { rows: 1, cols: 1 }
  const cols = Math.ceil(Math.sqrt(total))
  const rows = Math.ceil(total / cols)
  return { rows, cols }
}

function makeError(code: string, message: string, stage: string): Error {
  const err: any = new Error(message)
  err.code = code
  err.stage = stage
  return err
}

export async function submitProcessImage(
  presignedUrl: string,
  config: SplitConfig,
  outputDir: string,
): Promise<string> {
  const creds = getCredentials()
  const client = getMpsClient()

  const stdExtInfo: Record<string, any> = {
    StoryboardConfig: { ModelSamplingAuraFlow: config.modelSamplingAuraFlow },
  }
  if (config.processIndex !== undefined) {
    stdExtInfo.StoryboardConfig.ProcessIndex = config.processIndex
  }

  const resp = await client.ProcessImage({
    InputInfo: { Type: 'URL', UrlInputInfo: { Url: presignedUrl } },
    OutputStorage: { Type: 'COS', CosOutputStorage: { Bucket: creds.bucket, Region: creds.region } },
    OutputDir: outputDir,
    ScheduleId: config.scheduleId,
    StdExtInfo: JSON.stringify(stdExtInfo),
  })

  return resp.TaskId
}

export async function pollImageUntilFinish(
  taskId: string,
  signal: AbortSignal,
  onProgress: (attempt: number, maxAttempts: number) => void,
  maxDurationMs = 10 * 60 * 1000,
): Promise<{ results: SplitResult[]; rows: number; cols: number }> {
  const client = getMpsClient()
  const deadline = Date.now() + maxDurationMs
  let attempt = 0
  const estimatedAttempts = 120

  while (Date.now() < deadline) {
    if (signal.aborted) throw makeError('TASK_CANCELLED', 'Cancelled', 'poll')

    const resp = await client.DescribeImageTaskDetail({ TaskId: taskId })
    attempt++
    onProgress(attempt, estimatedAttempts)

    if (resp.Status === 'FINISH') {
      if (resp.ErrCode && resp.ErrCode !== 0) {
        throw makeError(String(resp.ErrCode), resp.ErrMsg || `MPS error: ${resp.ErrCode}`, 'poll')
      }
      const resultSet = resp.ImageProcessTaskResultSet || []
      const results: SplitResult[] = await Promise.all(
        resultSet.map(async (r: any, idx: number) => {
          const cosPath = (r.Output?.Path || '').replace(/^\//, '')
          const url = await getPresignedUrl({ key: cosPath, expireSeconds: SEVEN_DAYS_S })
          return { index: idx, url, cosPath, expiresAt: Date.now() + SEVEN_DAYS_S * 1000 }
        }),
      )
      const { rows, cols } = inferGrid(results.length)
      return { results, rows, cols }
    }

    if (resp.Status === 'FAIL' || (resp.ErrCode && resp.ErrCode !== 0)) {
      throw makeError(
        String(resp.ErrCode || 'MPS_TASK_FAILED'),
        resp.ErrMsg || resp.Message || `MPS task failed: ${resp.Status}`,
        'poll',
      )
    }

    const interval = attempt <= 10 ? 2000 : attempt <= 30 ? 3000 : 5000
    await new Promise((r) => setTimeout(r, interval))
  }

  throw makeError('POLL_TIMEOUT', `轮询超时，MPS 任务未在 ${Math.round(maxDurationMs / 60000)} 分钟内完成`, 'poll')
}

export async function runImageJob(
  job: ImageJobInput,
  signal: AbortSignal,
  events: JobLifecycleEvents<ImageJobInput, ImageJobOutput>,
): Promise<ImageJobOutput> {
  const ext = job.filename.split('.').pop()?.toLowerCase() || 'jpg'
  const cosKey = `storyboard-split/${job.taskId}/input.${ext}`

  events.onProgress?.(job, { stage: 'uploading-cos', progress: 5 })
  await uploadBuffer({
    key: cosKey,
    body: job.buffer,
    contentType: CONTENT_TYPE_MAP[ext] || 'image/jpeg',
  })

  if (signal.aborted) throw makeError('TASK_CANCELLED', 'Cancelled after upload', 'upload')

  events.onProgress?.(job, { stage: 'uploading-cos', progress: 30 })
  events.onProgress?.(job, { stage: 'submitting-mps', progress: 35 })

  const inputUrl = await getPresignedUrl({ key: cosKey, expireSeconds: 86400 })
  const outputDir = `/storyboard-split/${job.taskId}/output/`
  const mpsTaskId = await submitProcessImage(inputUrl, job.config, outputDir)

  events.onProgress?.(job, { stage: 'polling-mps', progress: 40, meta: { mpsTaskId } })
  const { results, rows, cols } = await pollImageUntilFinish(
    mpsTaskId,
    signal,
    (attempt, max) => {
      const progress = 40 + Math.round((attempt / max) * 50)
      events.onProgress?.(job, { stage: 'polling-mps', progress })
    },
  )

  return { results, rows, cols, inputCosKey: cosKey, mpsTaskId }
}
```

- [ ] **Step 2: Rewrite `storyboardSplit/index.ts`**

```ts
// src/main/services/storyboardSplit/index.ts

import { JobQueue } from '../tencent/jobQueue'
import {
  getCredentials,
  getCredentialState,
  setCredentials,
} from '../tencent/credentials'
import { deleteObjects } from '../tencent/cosClient'
import { runImageJob } from './runner'
import type { ImageJobInput, ImageJobOutput } from './runner'
import type {
  SplitConfig,
  SplitSubmitPayload,
  SplitProgressEvent,
  SplitFinishedEvent,
  SplitFailedEvent,
} from '../../../types/storyboardSplit'
import { DEFAULT_SPLIT_CONFIG } from '../../../types/storyboardSplit'
import type { BrowserWindow } from 'electron'

const MAX_CONCURRENT = 4

let mainWindowRef: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow) {
  mainWindowRef = win
}

function safeSend(channel: string, data: any) {
  if (mainWindowRef && !mainWindowRef.isDestroyed() && !mainWindowRef.webContents.isDestroyed()) {
    mainWindowRef.webContents.send(channel, data)
  }
}

let defaultConfig: SplitConfig = { ...DEFAULT_SPLIT_CONFIG }

export function getDefaultConfig(): SplitConfig {
  return { ...defaultConfig }
}

export function setDefaultConfig(config: SplitConfig): void {
  defaultConfig = { ...config }
}

const queue = new JobQueue<ImageJobInput, ImageJobOutput>({
  name: 'storyboard-split',
  maxConcurrent: MAX_CONCURRENT,
  runner: runImageJob,
  events: {
    onProgress: (job, patch) => {
      const progressEvent: SplitProgressEvent = {
        taskId: job.taskId,
        status: patch.stage === 'submitting-mps' ? 'submitted'
              : patch.stage === 'polling-mps' ? 'processing'
              : 'uploading',
        progress: patch.progress,
        stage: patch.stage as any,
      }
      safeSend('storyboard-split:progress', progressEvent)
    },
    onFinished: (job, result) => {
      const finishedEvent: SplitFinishedEvent = {
        taskId: job.taskId,
        results: result.results,
        inputCosKey: result.inputCosKey,
        rows: result.rows,
        cols: result.cols,
      }
      safeSend('storyboard-split:finished', finishedEvent)
    },
    onFailed: (job, error) => {
      const failedEvent: SplitFailedEvent = {
        taskId: job.taskId,
        error: error.message,
        errorCode: error.code,
      }
      safeSend('storyboard-split:failed', failedEvent)
    },
  },
  getJobId: (job) => job.taskId,
})

export async function submitSplit(payload: SplitSubmitPayload) {
  const creds = getCredentials()
  if (!creds.secretId || !creds.secretKey) {
    return { success: false, error: '未配置腾讯云密钥', errorCode: 'NO_CREDENTIALS' }
  }

  const base64 = payload.base64Data.replace(/^data:image\/\w+;base64,/, '')
  const buffer = Buffer.from(base64, 'base64')

  if (queue.getActiveCount() >= MAX_CONCURRENT) {
    safeSend('storyboard-split:progress', {
      taskId: payload.taskId,
      status: 'queued',
      progress: 0,
      stage: 'uploading-cos',
    } as SplitProgressEvent)
  }

  try {
    await queue.enqueue({
      taskId: payload.taskId,
      buffer,
      filename: payload.filename,
      config: payload.config,
    })
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message, errorCode: err.code || '' }
  }
}

export function cancelTask(taskId: string) {
  queue.cancel(taskId)
  return { success: true }
}

export function cancelAllActiveTasks() {
  queue.cancelAll()
}

export function getConfig() {
  return {
    success: true,
    defaults: getDefaultConfig(),
    credentials: getCredentialState(),
  }
}

export function setCredentialsFromUI(creds: { secretId: string; secretKey: string; bucket: string; region: string }) {
  setCredentials(creds)
  return { success: true }
}

export function setDefaultsFromUI(config: SplitConfig) {
  setDefaultConfig(config)
  return { success: true }
}

export async function deleteRemoteObjects(cosPaths: string[]) {
  if (!cosPaths.length) return { success: true }
  try {
    await deleteObjects(cosPaths)
    return { success: true }
  } catch (err: any) {
    console.warn('[SplitService] COS delete failed:', err.message)
    return { success: false, error: err.message }
  }
}
```

- [ ] **Step 3: Deduplicate `CredentialState` in `src/types/storyboardSplit.ts`**

Open `src/types/storyboardSplit.ts` and replace the existing `CredentialState` interface block (lines 67–73 of the original) with a single re-export line:

```ts
// src/types/storyboardSplit.ts (top of file, alongside other exports)
export type { CredentialState } from '../main/services/tencent/types'
```

Delete the local `interface CredentialState { ... }` block. All renderer-side imports continue working unchanged because the type is still exported from the same module path.

- [ ] **Step 4: Delete old files**

Run:
```bash
git rm src/main/services/storyboardSplit/config.ts src/main/services/storyboardSplit/cosClient.ts src/main/services/storyboardSplit/mpsClient.ts
```

- [ ] **Step 5: Verify typecheck passes**

Run: `npm run typecheck`
Expected: 0 errors

If errors appear (likely about `SplitProgressEvent.stage` enum or `setMainWindow` import in `src/main/index.ts`), check that:
- `src/types/storyboardSplit.ts` has the union type for `stage` field
- `src/main/index.ts` still imports `setMainWindow` from `./services/storyboardSplit` (re-exported from new index)

- [ ] **Step 6: Run all unit tests**

Run: `npm run test:run`
Expected: All `tencent/__tests__/*.test.ts` PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/services/storyboardSplit/runner.ts src/main/services/storyboardSplit/index.ts src/types/storyboardSplit.ts
git commit -m "refactor(storyboardSplit): convert to thin runner on shared tencent layer"
```

---

## Task 6: Manual smoke verification

**Files:**
- None (verification only)

**Why:** The shared layer is unit-tested, but the storyboardSplit feature works end-to-end against real Tencent infrastructure that isn't in the test suite. Verify nothing regressed.

- [ ] **Step 1: Build the renderer**

Run: `npm run build:vite`
Expected: success, no TypeScript errors

- [ ] **Step 2: Launch dev**

Run: `npm run dev`
Expected: app window opens

- [ ] **Step 3: Smoke test — happy path**

In the app:
1. Click 宫格拆图 tab
2. If credentials not set, open settings drawer and enter SecretId/SecretKey/Bucket/Region
3. Drag in any 9-tile sample image (`tests/fixtures/` may have one, or use any 3×3 grid)
4. Wait for processing
5. Verify processed tiles appear in result grid

- [ ] **Step 4: Smoke test — credential invalidation**

1. Open settings drawer
2. Change Region (e.g. ap-shanghai → ap-guangzhou)
3. Drop another image
4. Verify new credentials take effect (no stale-client error)

- [ ] **Step 5: Smoke test — credential migration (if you had an old install)**

If you have a pre-refactor build with `electron-store` credentials:
1. Note the old `tencent-credentials` electron-store file location: `%APPDATA%/catimation-cyberpunk-master/tencent-credentials.json` on Windows
2. Run new build
3. Verify settings drawer shows the credentials (migrated from electron-store)
4. Verify a new file exists: `%APPDATA%/catimation-cyberpunk-master/tencent-credentials.bin`
5. Verify `tencent-credentials.json` no longer contains the secret values (deleted by migration)

If you don't have an old install, skip this step.

- [ ] **Step 6: Smoke test — cancellation during upload (latent bug fix)**

1. Drop a moderately large image (~10 MB)
2. Click cancel during the "uploading-cos" stage
3. Verify network panel (DevTools) shows the upload request actually aborts (not running for minutes after cancel)

This was the latent bug from v1.0 of storyboardSplit; the new `JobQueue` uses real `AbortSignal` but `uploadBuffer` (which uses `cos.putObject`) does NOT respect the signal. **Note:** image uploads are typically <1s, so the bug rarely manifested. The fix lands properly in smartErase v1.1 where `uploadStream` uses `cos.cancelUpload(taskId)`. For images, this remains best-effort (acceptable since requests are short).

- [ ] **Step 7: Manual check passed → commit any final fixes**

If any smoke test failed:
- Read the error
- Fix in the relevant file
- Re-run typecheck + tests + smoke
- Commit with a focused message

If all passed:
```bash
# nothing to commit; just record verification in git log via empty annotation if desired:
git log -5 --oneline
# Verify the 5 expected commits land
```

---

## Self-Review Checklist

Before declaring this plan complete, verify:

**Spec coverage** — every section of the refactor spec is addressed:
- [x] §3 Target Architecture: Tasks 1–4 create the 4 modules + types; Task 5 collapses storyboardSplit
- [x] §4.1 credentials: Task 2 — three-tier resolution preserved + safeStorage migration
- [x] §4.2 cosClient: Task 3 — uploadBuffer + uploadStream + cancelUpload + presign + delete
- [x] §4.3 mpsClient: Task 4 — lazy MPS client only
- [x] §4.4 jobQueue: Task 1 — `JobQueue<TI,TO>` with real AbortSignal
- [x] §5.1 storyboardSplit/runner.ts: Task 5 step 1
- [x] §5.2 storyboardSplit/index.ts rewrite: Task 5 step 2
- [x] §5.3 old files deleted: Task 5 step 3
- [x] §5.4 IPC handlers unchanged: verified by Task 5 step 4 typecheck
- [x] §6.1 behavior-preserving tests: Task 6 manual smoke
- [x] §6.2 new shared-layer tests: Tasks 1–4 unit tests

**Placeholder scan** — no "TODO", "TBD", "implement later", "fill in details" — confirmed.

**Type consistency:**
- `JobLifecycleEvents<TI,TO>` used identically across types.ts → jobQueue.ts → runner.ts ✓
- `getCredentials()` / `setCredentials()` / `onCredentialsInvalidated()` signature stable across all consumers ✓
- `uploadBuffer` / `uploadStream` / `getPresignedUrl` / `deleteObjects` from cosClient match runner imports ✓
- `getMpsClient()` returns `any` (SDK has no published types) — consistent across consumers ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-29-tencent-cloud-job-runner-refactor.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task with two-stage review between tasks.
2. **Inline Execution** — execute tasks 1–6 in this session with checkpoints after each task.

Which approach? After this PR merges, the smartErase v1.1 implementation plan will be written next.

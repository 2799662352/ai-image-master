// src/main/services/tencent/credentials.ts
//
// ## safeStorage 异步迁移(Electron 45 弃用、46 删除同步接口)
//
// 本模块的读取(`getCredentials()` / `getCredentialState()`)被 COS / MPS 客户端、智能去字幕、
// 分镜等**同步**调用,所以不把它们改成 async:启动时 `await initCredentials()` 把盘上的凭据
// 解进内存,此后同步读缓存;只有 `setCredentials()` 是异步的。同一套约束与理由见
// `src/main/services/auth/credentials.ts` 的头注释(先等 `isAsyncEncryptionAvailable()`、
// `decryptStringAsync` 返回 `{ result, shouldReEncrypt }`、加解密整体 try/catch 降级、
// 原子写盘),这里不重复。
//
// 与 auth 那份不同的两点:
//   - 没有「登出」,所以不需要代际守卫;`setCredentials()` 的合并(`getCredentials()` + patch)
//     放进串行队列里现算,并发调用时与同步版「逐个合并」的结果一致。
//   - 还有一次性的旧版 electron-store 迁移(`migrateLegacyOnce`),现在发生在预热阶段。

import { app, safeStorage } from 'electron'
import fs from 'fs'
import fsp from 'node:fs/promises'
import path from 'path'
import Store from 'electron-store'
import { writeFileAtomic } from '../../utils/writeFileAtomic'
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

function maskSecretId(id: string): string | undefined {
  if (!id) return undefined
  if (id.length < 8) return '****'
  return `${id.slice(0, 4)}****`
}

/**
 * 腾讯云永久 SecretId 恒为 `AKID` 开头的 36 位字符串。用户误把别家 API key
 * 粘进设置页时(实测触发 COS `InvalidAccessKeyId: The access key Id format
 * you provided is invalid`),媒体链路应视为「未配置」自动落回免密钥 STS
 * 通道,而不是拿畸形密钥去签名。宽松校验:AKID 前缀 + 总长 ≥20。
 */
export function isLikelyValidSecretId(id: string): boolean {
  return typeof id === 'string' && id.startsWith('AKID') && id.length >= 20
}

interface Resolved {
  creds: Credentials
  source: CredentialState['credentialSource']
}

let legacyStoreInstance: any = null
let cached: Resolved | null = null
let migrationAttempted = false
let inMemoryFallback: Credentials | null = null
// undefined = 尚未预热(`initCredentials()` 还没跑完);null = 读过,但盘上没有。
let stored: Credentials | null | undefined = undefined
/** 磁盘操作的串行队列。永远不 reject(每个任务自己兜住异常),所以链不会断。 */
let diskQueue: Promise<unknown> = Promise.resolve()
let initPromise: Promise<void> | null = null
let warnedBeforeInit = false

function enqueueDisk<T>(task: () => Promise<T>): Promise<T> {
  const run = diskQueue.then(task)
  diskQueue = run.catch(() => undefined)
  return run
}

function getLegacyStore() {
  if (!legacyStoreInstance) {
    legacyStoreInstance = new (Store as any)({
      name: LEGACY_STORE_NAME,
      encryptionKey: LEGACY_ENCRYPTION_KEY,
      encryptionAlgorithm: 'aes-256-gcm',
      defaults: DEFAULTS,
    })
  }
  return legacyStoreInstance
}

function safeStorageBinPath(): string {
  return path.join(app.getPath('userData'), SAFE_STORAGE_FILENAME)
}

/** 判不出来就当不可用:宁可降级到内存,不可在不确定时落盘。 */
async function encryptionAvailable(): Promise<boolean> {
  try {
    return await safeStorage.isAsyncEncryptionAvailable()
  } catch {
    return false
  }
}

interface DiskRead {
  creds: Credentials | null
  shouldReEncrypt: boolean
}

const NOTHING_ON_DISK: DiskRead = { creds: null, shouldReEncrypt: false }

async function readFromSafeStorage(): Promise<DiskRead> {
  try {
    if (!(await encryptionAvailable())) return NOTHING_ON_DISK
    let buf: Buffer
    try {
      buf = await fsp.readFile(safeStorageBinPath())
    } catch (e) {
      // 从没存过:正常情况,不是错误,也不值得打日志。
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return NOTHING_ON_DISK
      throw e
    }
    // 异步版返回 `{ result, shouldReEncrypt }`,**不是字符串**:直接 `JSON.parse` 它会被
    // stringify 成 "[object Object]" 而抛 SyntaxError,再被下面的 catch 吞掉 ——
    // 表现为「存了但重启后永远读不回来」,一个错都不报。
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(buf)
    return { creds: { ...DEFAULTS, ...JSON.parse(result) }, shouldReEncrypt }
  } catch (e) {
    console.warn('[tencent/credentials] safeStorage read failed:', e)
    return NOTHING_ON_DISK
  }
}

/** 返回「是否真的写进了盘」;false = 调用方应降级到内存。 */
async function writeToSafeStorage(creds: Credentials): Promise<boolean> {
  try {
    if (!(await encryptionAvailable())) return false
    const buf = await safeStorage.encryptStringAsync(JSON.stringify(creds))
    // 覆盖写 + 原子落位:写到一半崩溃不会留下截断的凭据文件;最终失败会抛,
    // 由下面的 catch 如实降级到内存(而不是假装写成功、盘上留着旧密钥)。
    await writeFileAtomic(safeStorageBinPath(), buf)
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
  } catch (e) {
    console.warn(
      '[tencent/credentials] failed to clear legacy electron-store; ' +
        'plaintext-encrypted-with-hardcoded-key credentials may remain on disk:',
      e,
    )
  }
}

async function migrateLegacyOnce(): Promise<Credentials | null> {
  if (migrationAttempted) return null
  const legacy = readFromLegacyStore()
  if (!legacy) {
    migrationAttempted = true // nothing to migrate; don't keep retrying
    return null
  }
  if (await writeToSafeStorage(legacy)) {
    clearLegacyStore()
    migrationAttempted = true
    console.log('[tencent/credentials] migrated from electron-store -> safeStorage')
    return legacy
  }
  // Write failed (e.g., safeStorage transiently unavailable). Surface the legacy
  // creds for this session, but leave migrationAttempted = false so a later
  // setCredentials() / next session can retry the secure write.
  return legacy
}

function loadBuiltin(): Credentials {
  const empty: Credentials = { ...DEFAULTS }
  try {
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

// Per-field fallback: each field tries store -> env -> builtin -> default independently.
function resolve(): Resolved {
  if (inMemoryFallback) {
    return {
      creds: { ...inMemoryFallback },
      source: inMemoryFallback.secretId ? 'memory' : 'none',
    }
  }

  // 盘上的值来自预热(`initCredentials()`)时解进内存的 `stored`,这里不再读盘。
  const s = stored ?? null

  const creds: Credentials = {
    secretId:  (s?.secretId)  || process.env.COS_SECRET_ID  || BUILTIN.secretId  || '',
    secretKey: (s?.secretKey) || process.env.COS_SECRET_KEY || BUILTIN.secretKey || '',
    bucket:    (s?.bucket)    || process.env.COS_BUCKET     || process.env.COS_BUCKET_NAME || BUILTIN.bucket || '',
    region:    (s?.region)    || process.env.COS_REGION     || BUILTIN.region    || DEFAULTS.region,
  }

  let source: CredentialState['credentialSource'] = 'none'
  if (s?.secretId) source = 'store'
  else if (process.env.COS_SECRET_ID) source = 'env'
  else if (BUILTIN.secretId) source = 'builtin'

  return { creds, source }
}

/**
 * 预热之前调用 = 启动顺序错了(没 `await initCredentials()`)。同步解不了密,只能按
 * 「盘上没有」(env / 内置 / 内存降级)解析,**且不缓存**这个结果 —— 否则预热完成后
 * 还会一直读到不含盘上凭据的旧视图。打一次警告并顺手补一次预热。
 */
function getResolved(): Resolved {
  if (stored === undefined) {
    if (!warnedBeforeInit) {
      warnedBeforeInit = true
      console.warn('[tencent/credentials] credentials read before initCredentials() finished; using env/builtin only')
    }
    void initCredentials()
    return resolve()
  }
  if (!cached) cached = resolve()
  return cached
}

async function hydrate(): Promise<void> {
  const fromDisk = await readFromSafeStorage()
  let value = fromDisk.creds
  if (!value) value = await migrateLegacyOnce()
  stored = value
  cached = null
  if (value && fromDisk.shouldReEncrypt) {
    // 尽力而为,不阻塞启动:`writeToSafeStorage` 自己兜住所有异常,失败时旧密文照样能解。
    // 官方做法是把**已解出的明文**重新加密(而不是再解密一次)。
    void enqueueDisk(() => writeToSafeStorage(value))
  }
}

/**
 * 启动时调用一次(`app.whenReady()` 之后、创建窗口之前),把盘上的凭据解进内存,
 * 并完成一次性的旧版 electron-store 迁移。幂等,且永不 reject —— 读不出来就是「盘上没有」。
 */
export function initCredentials(): Promise<void> {
  if (!initPromise) initPromise = hydrate()
  return initPromise
}

export function getCredentials(): Credentials {
  return { ...getResolved().creds }
}

export function getCredentialState(): CredentialState {
  const { creds, source } = getResolved()
  if (!creds.secretId || !isLikelyValidSecretId(creds.secretId)) {
    // 免密钥通道:没有永久密钥(或存的密钥格式明显不对,会被媒体链路忽略)
    // 时,媒体功能仍可经 SCF 云函数 STS 临时票据运行(桶/区域随票据下发)。
    // 端点故障会在任务运行时以正常失败面呈现。
    return { hasCredentials: true, credentialSource: 'sts' }
  }
  return {
    hasCredentials: true,
    credentialSource: source,
    secretIdMasked: maskSecretId(creds.secretId),
    bucket: creds.bucket || undefined,
    region: creds.region || undefined,
  }
}

export async function setCredentials(patch: Partial<Credentials>): Promise<void> {
  // 先等预热:否则 `getCredentials()` 看不到盘上已有的值,合并出来的 `next` 会把它们
  // 用 env / 内置值覆盖掉再写回盘。
  await initCredentials()
  await enqueueDisk(async () => {
    // 合并必须在队列里现算:并发调用时,后一个要基于前一个**已生效**的结果合并,
    // 与同步版「一个接一个」的语义一致;在队列外算会让两个 patch 互相覆盖。
    const next: Credentials = { ...getCredentials(), ...patch }

    const written = await writeToSafeStorage(next)
    if (!written) {
      inMemoryFallback = next
      console.warn('[tencent/credentials] safeStorage unavailable; using in-memory fallback')
    } else {
      inMemoryFallback = null
      stored = next
    }
    cached = null
  })
  invalidateCallbacks.forEach((cb) => cb())
}

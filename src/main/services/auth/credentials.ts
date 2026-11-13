// safeStorage 凭证加密落盘:启动时异步解密进内存 + 同步读缓存 + 内存降级 + 失效回调注册表。
//
// 形状照抄 `src/main/services/tencent/credentials.ts`,同一套约束的另一份实现:
//
// ## 为什么是「启动预热 + 同步读缓存」,而不是把读取全改成 async
//
// Electron 45 起弃用、**46 删除**同步的 `isEncryptionAvailable/encryptString/decryptString`
// (连同 Chromium 的同步 OSCrypt 后端),只剩异步三件套。但 `getCredential()` 在主进程里被
// 大量**同步**调用(`requireToken()`、`getAuthState()`、网关 token 换取……),把它们全改成
// async 会一路传染到每个调用方。所以沿用 `gatewayToken.ts` 已经在用的模式:启动时
// `await initCredential()` 把盘上的凭据解进内存,此后同步读缓存;只有**写入和登出**是异步的。
//
// ## 约束(每一条都有依据)
//
//   - 不得在模块加载时读盘:异步加密器在 `app` ready 之前不可用,`app.getPath('userData')`
//     也一样。所有磁盘访问必须等到 `initCredential()` 被调用。
//   - 先 `await isAsyncEncryptionAvailable()` 再加解密:它会等异步加密器惰性初始化完成
//     (Electron 42.x 在初始化完成前调用 `encryptStringAsync` 会直接崩进程,43 起已修)。
//   - 「可用」不等于「加密一定成功」(macOS 未签名时 Keychain 被拒,`isAsyncEncryptionAvailable()`
//     仍可能返回 true,随后 `encryptStringAsync()` reject),所以加解密整体 try/catch,
//     失败一律走降级,不抛给调用方。
//   - `decryptStringAsync` 返回的是 `{ result, shouldReEncrypt }`,**不是字符串**。直接交给
//     `JSON.parse` 会被 stringify 成 "[object Object]" 而抛 SyntaxError,再被读路径的
//     try/catch 吞掉 —— 表现为「落了盘但重启后永远读不回来」,一个错都不报。
//   - `shouldReEncrypt` 为真时(密钥轮换 / 有了更高安全级别的新密钥),把**已解出的明文**
//     重新加密并落盘(官方文档原文写的是「再解密一次」,Electron 的 #55318 正在更正为这个
//     做法)。尽力而为:失败不影响本次读取,旧密文仍然能解。
//   - 解密会校验密文前缀,文件损坏或截断时抛错而非返回垃圾 —— 读路径整体 try/catch,
//     任何异常都当作「无凭证」。
//   - 不调 `setUsePlainTextEncryption(true)`:Linux 无系统密码管理器时它会切到
//     内存固定密码,混淆不是加密。降级到内存(仅本次会话有效)才是诚实的行为。
//
// ## 并发(异步化之后才出现的问题)
//
// 同步版里 set / clear 不可能交错;异步之后,登录的写盘与登出的删盘可以在 `await` 之间交错。
// 最坏的一种:登录请求先发出、加密还在进行时用户登出 —— 若写盘不拦,**登出之后凭据又被写回
// 盘上**,下次启动用户又登录了。所以:
//   1. 登出让内存**同步**清空(`getCredential()` 立刻返回 null),不等磁盘;
//   2. 所有磁盘操作串行(`diskQueue`),保证「先写后删」的顺序;
//   3. 每次 set / clear 递增 `generation`,落盘前再比一次 —— 被后来的操作取代的写入直接丢弃。
//      (同一套守卫 `gatewayToken.ts` 的 `persist()` / `loadPersisted()` 里已经在用。)

import { app, safeStorage } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { ATOMIC_TMP_SUFFIX, writeFileAtomic } from '../../utils/writeFileAtomic'

export interface StoredCredential {
  token: string
  userId: string
  username: string
  displayName: string
  role: string
  expiresAt: number
}

const FILENAME = 'auth-credentials.bin'

// undefined = 尚未预热(`initCredential()` 还没跑完);null = 读过,但没有凭证。
let cached: StoredCredential | null | undefined = undefined
let inMemoryFallback: StoredCredential | null = null
const invalidateCallbacks = new Set<() => void>()

/** 每次 set / clear 加一。异步落盘在写之前拿它判断「我是不是已经过期了」。 */
let generation = 0
/** 磁盘操作的串行队列。永远不 reject(每个任务自己兜住异常),所以链不会断。 */
let diskQueue: Promise<unknown> = Promise.resolve()
let initPromise: Promise<void> | null = null
let warnedBeforeInit = false

function filePath(): string {
  return path.join(app.getPath('userData'), FILENAME)
}

function notify(): void {
  invalidateCallbacks.forEach((cb) => cb())
}

function enqueueDisk<T>(task: () => Promise<T>): Promise<T> {
  const run = diskQueue.then(task)
  diskQueue = run.catch(() => undefined)
  return run
}

/**
 * 落盘的 JSON 不可信,必须逐字段校验后才能当成凭证。
 *
 * 不做这一步,一个被篡改成 `{"userId":"u1"}` 的文件仍是合法 JSON,
 * `as StoredCredential` 会让它一路通过,下游据此发出 `Bearer undefined` ——
 * 而正确行为是「当作没有凭证」。类型断言不是校验。
 */
function parseCredential(json: string): StoredCredential | null {
  const raw: unknown = JSON.parse(json)
  if (typeof raw !== 'object' || raw === null) return null
  const c = raw as Record<string, unknown>
  for (const k of ['token', 'userId', 'username', 'displayName', 'role'] as const) {
    if (typeof c[k] !== 'string') return null
  }
  if (!c.token) return null
  if (typeof c.expiresAt !== 'number' || !Number.isFinite(c.expiresAt)) return null
  return {
    token: c.token as string,
    userId: c.userId as string,
    username: c.username as string,
    displayName: c.displayName as string,
    role: c.role as string,
    expiresAt: c.expiresAt,
  }
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
  cred: StoredCredential | null
  shouldReEncrypt: boolean
}

const NOTHING_ON_DISK: DiskRead = { cred: null, shouldReEncrypt: false }

async function readFromSafeStorage(): Promise<DiskRead> {
  try {
    if (!(await encryptionAvailable())) return NOTHING_ON_DISK
    let buf: Buffer
    try {
      buf = await fs.readFile(filePath())
    } catch (e) {
      // 从没登录过:正常情况,不是错误,也不值得打日志。
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return NOTHING_ON_DISK
      throw e
    }
    // 异步版返回 `{ result, shouldReEncrypt }`,不是字符串。
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(buf)
    const cred = parseCredential(result)
    return { cred, shouldReEncrypt: cred !== null && shouldReEncrypt }
  } catch (e) {
    console.warn('[auth/credentials] safeStorage read failed:', e)
    return NOTHING_ON_DISK
  }
}

/**
 * 加密并落盘。返回「是否真的写进了盘」;false = 调用方应降级到内存。
 *
 * `myGen` 是调用方出发时的代际。加密是 await,期间任何人都可能登出或换了凭据 ——
 * 此时 `cred` 已是**过期快照**,写下去就是把登出之前的 token 亲手送回盘上。
 */
async function persist(cred: StoredCredential, myGen: number): Promise<boolean> {
  try {
    if (!(await encryptionAvailable())) return false
    const buf = await safeStorage.encryptStringAsync(JSON.stringify(cred))
    if (myGen !== generation) return false
    // 覆盖写 + 原子落位:写到一半崩溃不会留下截断的凭据文件;最终失败会抛,
    // 由下面的 catch 如实降级到内存(而不是假装写成功、盘上留着旧 token)。
    await writeFileAtomic(filePath(), buf)
    return true
  } catch (e) {
    console.warn('[auth/credentials] safeStorage write failed:', e)
    return false
  }
}

async function removeFromDisk(): Promise<void> {
  const p = filePath()
  // 连崩溃时可能残留的临时文件一起删:里面是加密后的 token,登出后不该留在盘上。
  for (const target of [p, p + ATOMIC_TMP_SUFFIX]) {
    try {
      await fs.rm(target, { force: true })
    } catch (e) {
      console.warn('[auth/credentials] failed to remove credential file:', e)
    }
  }
}

async function hydrate(): Promise<void> {
  // 在第一个 await 之前记下代际:读盘、解密都是 await,期间若已经有人 set / clear,
  // 就不能再用盘上的旧值覆盖他们刚定下的状态(尤其是登出被撤销)。
  const gen = generation
  const { cred, shouldReEncrypt } = await readFromSafeStorage()
  if (gen !== generation) return
  cached = cred
  if (cred && shouldReEncrypt) {
    // 尽力而为,不阻塞启动:`persist` 自己兜住所有异常,失败时旧密文照样能解。
    // 用 hydrate 开头记下的 `gen`(而不是任务真正开跑时的 `generation`):这份 `cred` 是
    // 预热时读到的快照,期间只要有人 set / clear 过,它就该被确定性地丢弃,而不是靠
    // 磁盘队列的先后顺序碰巧被后到的写入盖掉。
    void enqueueDisk(() => persist(cred, gen))
  }
}

/**
 * 启动时调用一次(`app.whenReady()` 之后、创建窗口之前),把盘上的凭据解进内存。
 * 幂等,且永不 reject —— 读不出来就是「没有凭证」。
 */
export function initCredential(): Promise<void> {
  if (!initPromise) initPromise = hydrate()
  return initPromise
}

/**
 * 返回**副本**,不是缓存对象本身。
 *
 * 直接把缓存交出去的话,任何调用方改一下返回值就永久污染了本会话的缓存 ——
 * 比如把 token 置空,后续每次读都拿到那个坏值,而磁盘上其实是好的。
 * 写入侧同理:存进来的对象也要拷一份,免得调用方之后改它反向影响缓存。
 *
 * 预热之前调用 = 启动顺序错了(没 `await initCredential()`)。同步解不了密,只能返回 null;
 * 这里打一次警告并顺手补一次预热,让之后的读取恢复正确,而不是永久「看起来没登录」。
 */
export function getCredential(): StoredCredential | null {
  if (inMemoryFallback) return { ...inMemoryFallback }
  if (cached === undefined) {
    if (!warnedBeforeInit) {
      warnedBeforeInit = true
      console.warn('[auth/credentials] getCredential() called before initCredential() finished; treating as signed out')
    }
    void initCredential()
    return null
  }
  return cached ? { ...cached } : null
}

/**
 * 保存凭据。内存立即生效(登录一返回,同步读者马上拿得到),落盘是异步的;
 * 盘上落不了(加密不可用 / 写失败)就退回「仅本次会话」的内存凭据。
 * 返回时磁盘已经落完 —— 调用方应 `await`。
 */
export async function setCredential(cred: StoredCredential): Promise<void> {
  const snapshot: StoredCredential = { ...cred }
  const myGen = ++generation
  cached = snapshot
  inMemoryFallback = null
  const written = await enqueueDisk(() => persist(snapshot, myGen))
  // 被后来的 set / clear 取代了:状态与通知都由它收尾,这里不能再动。
  if (myGen !== generation) return
  if (!written) {
    inMemoryFallback = snapshot
    cached = null
    console.warn('[auth/credentials] safeStorage unavailable; using in-memory fallback')
  }
  notify()
}

/**
 * 登出。内存**同步**清空(返回之前 `getCredential()` 就已是 null),再等磁盘删完。
 * 调用方应 `await`:不等它就广播「已登出」,而删盘还在半路 —— 此时关掉应用,
 * 进程退出会把删除截断,token 原样留在盘上。
 */
export async function clearCredential(): Promise<void> {
  generation++
  inMemoryFallback = null
  cached = null
  await enqueueDisk(removeFromDisk)
  notify()
}

export function credentialSource(): 'safeStorage' | 'memory' | 'none' {
  if (inMemoryFallback) return 'memory'
  if (getCredential()) return 'safeStorage'
  return 'none'
}

export function onCredentialChanged(cb: () => void): () => void {
  invalidateCallbacks.add(cb)
  return () => invalidateCallbacks.delete(cb)
}

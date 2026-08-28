# 桌面端接入平台余额（直接使用影子账号 token）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让已登录用户在 CATIMATION 里用平台账号余额出图，而不必自己填 Miau 的 API Key。

**Architecture:** 主进程凭平台 JWT 向 `sora-ui-backend` 换取该用户影子账号的网关 token，加密缓存在主进程；渲染层**永远拿不到这枚 token**，它只在请求头里打一个 `X-Catimation-Billing: platform` 标记，由主进程的 `webRequest.onBeforeSendHeaders` 在出网时按 host 过滤、把标记换成真正的 `Authorization`。

**Tech Stack:** Electron 43 / electron-builder 26.4 / TypeScript / Vitest。

---

## 背景：为什么是这个形状

服务端那一半已经完成（`sora-ui-backend` 分支 `feat/desktop-gateway-token`，提交 `36becc2` + `35a11e6`）：

```
GET /api/user/gateway-token?projectId=<n>&producerProjectId=<n?>
Authorization: Bearer <平台 JWT>
→ 200 { success: true, data: { token_key: "sk-..." } }
→ 403 { success: false, error: { code: "PROJECT_NOT_ALLOCATED", ... } }
→ 503 { success: false, error: { code: "UPSTREAM_UNREACHABLE", retryable: true } } + Retry-After
```

它下发的是**影子账号的 allocation token**，`expired_time = -1`（永不过期），且被 relay / 成员校验 / shortdrama / Python 后端四处共用。这个取舍是用户在多轮讨论后明确选定的（备选方案「短命派生 token」的计划见同目录 `2026-08-28-phase2-derived-gateway-token.md`，已标作废但保留了上游取证）。

**所接受的后果，写在这里以免被后来者当成疏忽：**

- 泄漏后**无法单独吊销**。作废它等于同时弄断该用户的网页端出图与项目成员判定。
- 爆炸半径是**该用户自己充值的余额**（影子账号按 (用户, 池) 一一对应，New API 预扣费，透支不了）。够不着平台，够不着别人。
- 因此本计划的防护重心全部落在「**不让它离开主进程**」，而不是「泄漏后怎么补救」——后者没有手段。

## 取证摘要（决定了下面每一条约束）

| 结论 | 出处 |
|---|---|
| 那枚 `sk-` 本身就是全部认证，没有第二道 | `new-api/middleware/auth.go:323` |
| Windows DPAPI **不防同用户态的其他程序** | Electron `safeStorage` 官方平台语义表 |
| Linux 无 secret store 时用**硬编码明文口令**加密，`getSelectedStorageBackend() === 'basic_text'` 可检测；我们出 AppImage + deb | Electron `safeStorage` 文档；`electron-builder.yml:213-217` |
| 渲染层 `nodeIntegration: true` / `contextIsolation: false` / `sandbox: false` | `src/main/index.ts:457-459` |
| Miau 网关是站点 `antigravity`，`https://miauapi.13797248455.xyz`，bearer 鉴权 | `ApiService.ts:432, 520-531` |
| `onBeforeSendHeaders` 未被占用（CSP 用的是 `onHeadersReceived`） | `src/main/index.ts:469` |
| 同一 session 上**只有最后挂的 listener 生效** | Electron `webRequest` 文档 |
| `getSelectedStorageBackend()` 在 app ready 前返回 `'unknown'` | Electron `safeStorage` 文档 |
| new-api **没有**令牌级限流或消费上限，上游明确拒绝在开源版做 | `middleware/model-rate-limit.go:80`；上游 issue #571 |
| `X-Platform-User-Id` / `X-Project-Id` / `X-Session-Id` 客户端可设且**不被剥离** | `new-api/model/log.go:397-409` 对比 `middleware/auth.go:283-285` |

## Global Constraints

- **网关 token 绝不经 IPC 下发渲染层，绝不写进 localStorage / zustand / 任何会被 `JSON.stringify` 的结构。** 渲染层是 `nodeIntegration: true` 且无 contextIsolation 的环境。
- **绝不进日志、绝不进错误上报。** 本仓无 Sentry 也无 crashReporter（已核实），所以只需管住 `console.*`。
- 落盘一律 `safeStorage`，且用**异步** API（`encryptStringAsync` / `decryptStringAsync`）——官方称同步版「可能在未来版本被废弃」。
- Linux 上 `getSelectedStorageBackend() === 'basic_text'` 时**拒绝落盘**，只留内存。判据必须是「等于 `basic_text`」而不是「不在白名单里」——后者会误伤 Windows/macOS（那两个平台该方法可能返回 `'unknown'`）。
- 缓存键必须是 `(projectId, producerProjectId)` **两半**。两个 producer 项目可以共用同一个 `projectId`，只按 `projectId` 认会把两个不同的池悄悄合并。这条与第一期 `useQuotaStore.samePool` 的教训同源。
- 不改任何既有的「用户自填 API Key」通路。平台余额是**新增的第二条路**，默认关闭。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `src/main/services/auth/gatewayToken.ts`（新建） | 取 token、按池缓存、加密落盘、登出/切池时清除。**唯一持有明文 token 的模块。** |
| `src/main/services/auth/gatewayHeaderInjector.ts`（新建） | 挂 `onBeforeSendHeaders`，按 host 过滤，把 `X-Catimation-Billing: platform` 标记换成真 `Authorization`。 |
| `src/main/services/auth/ipc.ts`（改） | 加两个通道：查询「平台计费是否可用」、切池。**不加任何返回 token 的通道。** |
| `src/main/index.ts`（改） | 在 `createWindow` 里装 header 注入器。 |
| `src/renderer/src/services/api/ApiService.ts`（改） | Miau 站点在平台计费模式下改发标记头，不发 `Authorization`。 |
| `src/renderer/src/stores/useQuotaStore.ts`（改） | 增 `billingSource: 'platform' \| 'own-key'`。 |
| `src/renderer/src/pages-react/settings/AccountSection.tsx`（改） | 计费源开关。 |
| `electron-builder.yml`（改） | `electronFuses`。 |

---

## Task 1: 主进程取 + 缓存网关 token

**Files:**
- Create: `src/main/services/auth/gatewayToken.ts`
- Test: `src/main/services/auth/__tests__/gatewayToken.test.ts`

**Interfaces:**
- Consumes: `getCredentials()` from `./credentials`（现有，返回含 `token` 的平台 JWT 凭据）；`authBaseUrl()` from `./session`（现有）
- Produces:
  - `getGatewayToken(pool: Pool): Promise<string>` — 主进程内部用，抛 `GatewayTokenError`
  - `setActivePool(pool: Pool | null): void`
  - `getActivePoolToken(): string | null` — 同步读缓存，给 header 注入器用（它在热路径上，不能 await）
  - `clearGatewayTokens(): Promise<void>` — 登出时调
  - `type Pool = { projectId: number; producerProjectId: number | null }`

- [ ] **Step 1: 写失败测试——缓存键必须是两半**

```ts
// src/main/services/auth/__tests__/gatewayToken.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const cred = { current: null as unknown }
vi.mock('../credentials', () => ({
  getCredentials: () => cred.current,
}))
vi.mock('../session', () => ({ authBaseUrl: () => 'https://example.test' }))
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    getSelectedStorageBackend: () => 'unknown',
  },
  app: { getPath: () => '/tmp' },
}))

function ok(token: string) {
  return { ok: true, status: 200, json: async () => ({ success: true, data: { token_key: token } }) }
}

describe('gatewayToken 缓存键', () => {
  beforeEach(() => {
    vi.resetModules()
    fetchMock.mockReset()
    cred.current = { token: 'jwt.tok', userId: 'u1' }
  })

  // 两个 producer 项目可以共用同一个 projectId。只按 projectId 做键会把两个
  // 不同的钱包合并 —— 用户切到另一个 producer 池后仍在花前一个池的钱。
  it('projectId 相同但 producerProjectId 不同时，不复用缓存', async () => {
    fetchMock.mockResolvedValueOnce(ok('sk-pool-a')).mockResolvedValueOnce(ok('sk-pool-b'))
    const m = await import('../gatewayToken')

    const a = await m.getGatewayToken({ projectId: 342, producerProjectId: 11 })
    const b = await m.getGatewayToken({ projectId: 342, producerProjectId: 22 })

    expect(a).toBe('sk-pool-a')
    expect(b).toBe('sk-pool-b')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('同一个池第二次命中缓存，不重复请求', async () => {
    fetchMock.mockResolvedValue(ok('sk-same'))
    const m = await import('../gatewayToken')

    await m.getGatewayToken({ projectId: 342, producerProjectId: null })
    await m.getGatewayToken({ projectId: 342, producerProjectId: null })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run src/main/services/auth/__tests__/gatewayToken.test.ts`
Expected: FAIL —— `Cannot find module '../gatewayToken'`

- [ ] **Step 3: 写最小实现**

```ts
// src/main/services/auth/gatewayToken.ts
import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getCredentials } from './credentials'
import { authBaseUrl } from './session'

export interface Pool {
  projectId: number
  /** producer 池才有。**它是池键的另一半**，只按 projectId 认会把两个池悄悄合并。 */
  producerProjectId: number | null
}

export class GatewayTokenError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'GatewayTokenError'
  }
}

function poolKey(p: Pool): string {
  return `${p.projectId}:${p.producerProjectId ?? ''}`
}

/** 明文 token 只活在这里。**绝不导出这个 Map，绝不经 IPC 下发。** */
const cache = new Map<string, string>()
/** 同一个池的并发请求合流成一次网络往返，避免 N 个出图任务同时打后端。 */
const inflight = new Map<string, Promise<string>>()
let activePool: Pool | null = null

export function setActivePool(pool: Pool | null): void {
  activePool = pool
}

/**
 * 给 header 注入器用的同步读。
 *
 * 必须同步：`onBeforeSendHeaders` 在每个请求的热路径上，在那里 await 一次网络
 * 往返会把出图请求整体拖慢，且首次调用时会让请求排队。所以取 token 的时机是
 * 「用户切池 / 登录成功」，不是「请求发出时」。取不到就返回 null，让请求带着
 * 标记头原样出去 —— 网关会回 401，渲染层按既有错误路径提示，不会静默失败。
 */
export function getActivePoolToken(): string | null {
  if (!activePool) return null
  return cache.get(poolKey(activePool)) ?? null
}

export async function getGatewayToken(pool: Pool): Promise<string> {
  const key = poolKey(pool)
  const hit = cache.get(key)
  if (hit) return hit

  const running = inflight.get(key)
  if (running) return running

  const task = fetchToken(pool)
    .then(async (token) => {
      cache.set(key, token)
      await persist().catch(() => {})
      return token
    })
    .finally(() => {
      inflight.delete(key)
    })
  inflight.set(key, task)
  return task
}

async function fetchToken(pool: Pool): Promise<string> {
  const cred = getCredentials()
  if (!cred?.token) {
    throw new GatewayTokenError('NOT_LOGGED_IN', '未登录，无法使用平台余额')
  }

  const url = new URL('/api/user/gateway-token', authBaseUrl())
  url.searchParams.set('projectId', String(pool.projectId))
  if (pool.producerProjectId) {
    url.searchParams.set('producerProjectId', String(pool.producerProjectId))
  }

  let resp: Response
  try {
    resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${cred.token}` },
    })
  } catch {
    // 断网 / DNS 失败。刻意不带原始错误 —— 它对用户无意义，而 message 里可能
    // 含完整 URL。可重试。
    throw new GatewayTokenError('NETWORK', '连不上服务器，请检查网络后重试', true)
  }

  const body = (await resp.json().catch(() => null)) as
    | { success?: boolean; data?: { token_key?: string }; error?: { code?: string; message?: string } }
    | null

  if (!resp.ok || !body?.success) {
    const code = body?.error?.code ?? `HTTP_${resp.status}`
    const message = body?.error?.message ?? '获取平台凭据失败'
    throw new GatewayTokenError(code, message, resp.status >= 500)
  }

  const token = body.data?.token_key
  if (!token) {
    // 200 但 body 畸形。**绝不把 body 打出来** —— 它畸形归畸形，仍可能夹带
    // 部分凭据。只记形状。
    throw new GatewayTokenError('MALFORMED_RESPONSE', '服务端返回的凭据格式不对', true)
  }
  return token
}

// ── 落盘 ───────────────────────────────────────────────────────────────────

function storePath(): string {
  return path.join(app.getPath('userData'), 'gateway-tokens.enc')
}

/**
 * Linux 上有没有真的加密。
 *
 * `isEncryptionAvailable()` 在 `basic_text` 后端下**也返回 true** —— 它只回答
 * 「有没有加密能力」，不回答「这个加密有没有用」。而 basic_text 用的是硬编码
 * 明文口令，等于没加密。我们出 AppImage，那正是最容易没有 secret store 的场景。
 *
 * 判据写成「等于 basic_text」而不是「不在白名单里」：该方法是 Linux 语义，
 * Windows/macOS 上可能返回 'unknown'，用白名单会把这两个平台一起误伤。
 */
function encryptionIsReal(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  try {
    // app ready 之前调会返回 'unknown'，所以这个函数只能在 ready 之后用。
    return safeStorage.getSelectedStorageBackend() !== 'basic_text'
  } catch {
    // 该方法在部分平台上可能不存在（老版本 Electron）。存在性未知时按「不确定」
    // 处理，而不确定时宁可不落盘。
    return false
  }
}

async function persist(): Promise<void> {
  if (!encryptionIsReal()) return // 只留内存，重启后重取
  const payload = JSON.stringify(Object.fromEntries(cache))
  const buf = await safeStorage.encryptStringAsync(payload)
  await fs.writeFile(storePath(), buf)
}

export async function loadPersisted(): Promise<void> {
  if (!encryptionIsReal()) return
  try {
    const buf = await fs.readFile(storePath())
    const json = await safeStorage.decryptStringAsync(buf)
    for (const [k, v] of Object.entries(JSON.parse(json) as Record<string, string>)) {
      if (typeof v === 'string' && v) cache.set(k, v)
    }
  } catch {
    // 文件不存在 / 换了机器解不开 / 格式变了。都不是错误，重取即可。
  }
}

export async function clearGatewayTokens(): Promise<void> {
  cache.clear()
  inflight.clear()
  activePool = null
  await fs.rm(storePath(), { force: true }).catch(() => {})
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/services/auth/__tests__/gatewayToken.test.ts`
Expected: PASS（2 条）

- [ ] **Step 5: 补齐剩余用例**

补这几条，每条都要能因对应的实现缺陷变红：

- **未登录 → `NOT_LOGGED_IN`，且不发请求**（断言 `fetchMock` 未被调用）
- **403 `PROJECT_NOT_ALLOCATED` → 原样透出 code**（渲染层要按它引导用户换组织）
- **503 → `retryable === true`**；**403 → `retryable === false`**
- **200 但 body 缺 `token_key` → `MALFORMED_RESPONSE`**
- **并发合流**：同一个池同时发 3 次，断言 `fetchMock` 只被调用 **1** 次，且三个 Promise 拿到同一个字符串
- **`clearGatewayTokens()` 之后再取会重新请求**
- **`basic_text` 时不落盘**：把 `getSelectedStorageBackend` mock 成 `'basic_text'`，断言 `fs.writeFile` 未被调用
- **`producerProjectId` 为 null 时 URL 里不出现该参数**（传 `producerProjectId=null` 字面量会让后端 `parseInt` 出 NaN）

- [ ] **Step 6: 提交**

```bash
git add src/main/services/auth/gatewayToken.ts src/main/services/auth/__tests__/gatewayToken.test.ts
git commit -m "feat(auth): 主进程取用并缓存网关 token,明文不出主进程"
```

---

## Task 2: 出网时注入 Authorization

**Files:**
- Create: `src/main/services/auth/gatewayHeaderInjector.ts`
- Modify: `src/main/index.ts`（在 `createWindow` 内，CSP 那段附近）
- Test: `src/main/services/auth/__tests__/gatewayHeaderInjector.test.ts`

**Interfaces:**
- Consumes: `getActivePoolToken()` from `./gatewayToken`
- Produces: `installGatewayHeaderInjector(session: Electron.Session): void`

**为什么是这个方案而不是把 token 交给渲染层：** 渲染层是 `nodeIntegration: true` + `contextIsolation: false` + `sandbox: false`，任何脚本都有完整 Node 权限。而 `onBeforeSendHeaders` 让凭据在主进程里被贴到出网请求上，渲染层的 `fetch` 一行不用改，token 也从不进入它的内存。

**为什么用标记头而不是无条件注入：** 用户仍可以选择用自己填的 API Key。渲染层显式打 `X-Catimation-Billing: platform` 标记 = 本次请求走平台计费；不打就原样放行。无条件注入会把用户自己的 key 覆盖掉。

- [ ] **Step 1: 写失败测试**

```ts
// src/main/services/auth/__tests__/gatewayHeaderInjector.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'

const tokenRef = { value: null as string | null }
vi.mock('../gatewayToken', () => ({ getActivePoolToken: () => tokenRef.value }))

/** 把注册进去的 listener 抓出来直接调，不起真 session。 */
function fakeSession() {
  let captured: ((d: any, cb: (r: any) => void) => void) | null = null
  let capturedFilter: { urls: string[] } | null = null
  return {
    webRequest: {
      onBeforeSendHeaders(filter: any, listener: any) {
        capturedFilter = filter
        captured = listener
      },
    },
    invoke(headers: Record<string, string>) {
      return new Promise<any>((resolve) => captured!({ requestHeaders: headers }, resolve))
    },
    get filter() {
      return capturedFilter
    },
  }
}

describe('gatewayHeaderInjector', () => {
  beforeEach(() => {
    vi.resetModules()
    tokenRef.value = null
  })

  it('带标记头且有 token 时，换成 Authorization 并删掉标记', async () => {
    tokenRef.value = 'sk-live'
    const s = fakeSession()
    const m = await import('../gatewayHeaderInjector')
    m.installGatewayHeaderInjector(s as any)

    const r = await s.invoke({ 'X-Catimation-Billing': 'platform' })

    expect(r.requestHeaders.Authorization).toBe('Bearer sk-live')
    // 标记必须删掉：它是内部协议，泄漏到上游没有意义，且会出现在网关日志里。
    expect(r.requestHeaders['X-Catimation-Billing']).toBeUndefined()
  })

  // 没有标记 = 用户在用自己填的 key。无条件注入会把它覆盖掉。
  it('没有标记头时一个字节都不改', async () => {
    tokenRef.value = 'sk-live'
    const s = fakeSession()
    const m = await import('../gatewayHeaderInjector')
    m.installGatewayHeaderInjector(s as any)

    const r = await s.invoke({ Authorization: 'Bearer user-own-key' })

    expect(r.requestHeaders.Authorization).toBe('Bearer user-own-key')
  })

  // 过滤器必须钉死 host。漏掉它就是把凭据贴到应用发出的**每一个**请求上，
  // 包括第三方图床、更新检查、遥测 —— 那是灾难性的泄漏。
  it('只对 Miau 网关 host 生效', async () => {
    const s = fakeSession()
    const m = await import('../gatewayHeaderInjector')
    m.installGatewayHeaderInjector(s as any)

    expect(s.filter!.urls).toEqual(['https://miauapi.13797248455.xyz/*'])
  })
})
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run src/main/services/auth/__tests__/gatewayHeaderInjector.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

```ts
// src/main/services/auth/gatewayHeaderInjector.ts
import type { Session } from 'electron'
import { getActivePoolToken } from './gatewayToken'

/**
 * 渲染层用它声明「本次请求走平台余额」。
 *
 * 用标记头而不是无条件注入，是因为用户仍可以用自己填的 API Key —— 无条件注入
 * 会把它覆盖掉。标记在出网前会被删除，不让内部协议泄漏到上游日志里。
 */
export const BILLING_MARKER_HEADER = 'X-Catimation-Billing'
export const BILLING_MARKER_VALUE = 'platform'

/**
 * ⚠️ **这个 host 白名单是本方案的安全支点。**
 *
 * 过滤器一旦放宽（比如写成 `*://*/*`），凭据会被贴到应用发出的每一个请求上 ——
 * 包括第三方图床、更新检查、任何遥测。改这一行之前先想清楚。
 */
const GATEWAY_URL_FILTER = { urls: ['https://miauapi.13797248455.xyz/*'] }

/**
 * ⚠️ 同一个 session 上**只有最后挂的 `onBeforeSendHeaders` listener 生效**
 * （Electron 官方文档明写）。将来若有别处也要挂，必须合并成一个 listener，
 * 不能各挂各的 —— 那样先挂的会被静默顶掉。
 * 本仓当前只有 CSP 用了 `onHeadersReceived`（不同事件，不冲突）。
 */
export function installGatewayHeaderInjector(session: Session): void {
  session.webRequest.onBeforeSendHeaders(GATEWAY_URL_FILTER, (details, callback) => {
    const headers = details.requestHeaders
    if (headers[BILLING_MARKER_HEADER] !== BILLING_MARKER_VALUE) {
      callback({ requestHeaders: headers })
      return
    }
    delete headers[BILLING_MARKER_HEADER]

    const token = getActivePoolToken()
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }
    // 取不到就让它带着空 Authorization 出去 —— 网关回 401，渲染层走既有错误
    // 路径提示「请先选择计费池」。**刻意不在这里静默放行成功**，否则用户会以为
    // 在花平台余额，实际用的是别的凭据。
    callback({ requestHeaders: headers })
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/services/auth/__tests__/gatewayHeaderInjector.test.ts`
Expected: PASS（3 条）

- [ ] **Step 5: 装进主进程**

在 `src/main/index.ts` 里，紧挨着现有的 CSP 那段（`mainWindow.webContents.session.webRequest.onHeadersReceived`，约 469 行）之前插入：

```ts
  // 平台余额：出网时把标记头换成真凭据。必须用同一个 session 对象 ——
  // 用 session.defaultSession 在设了 partition 的窗口上会挂错地方。
  installGatewayHeaderInjector(mainWindow.webContents.session)
```

并在文件顶部 import 区加：

```ts
import { installGatewayHeaderInjector } from './services/auth/gatewayHeaderInjector'
```

- [ ] **Step 6: 提交**

```bash
git add src/main/services/auth/gatewayHeaderInjector.ts src/main/services/auth/__tests__/gatewayHeaderInjector.test.ts src/main/index.ts
git commit -m "feat(auth): 出网时注入网关凭据,渲染层只打标记不持有 token"
```

---

## Task 3: IPC 与池切换

**Files:**
- Modify: `src/main/services/auth/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/types/authApi.ts`
- Test: `src/main/services/auth/__tests__/ipc.test.ts`（扩展现有）

**Interfaces:**
- Produces（渲染层可见）：
  - `auth:set-billing-pool` → `QuotaRpc<{ ready: boolean }>` — 切池，主进程顺手把 token 取好
  - `auth:clear-billing-pool` → `QuotaRpc<null>`

**绝不新增返回 token 的通道。** 渲染层只需要知道「平台计费此刻可不可用」，不需要知道凭据是什么。

- [ ] **Step 1: 写失败测试**

```ts
// 追加进 src/main/services/auth/__tests__/ipc.test.ts 的既有 describe 之后
describe('平台计费通道', () => {
  it('两个通道都注册了,且都在卸载清单里', async () => {
    const dispose = await register()
    for (const ch of ['auth:set-billing-pool', 'auth:clear-billing-pool']) {
      expect(handlers.has(ch)).toBe(true)
    }
    dispose()
    for (const ch of ['auth:set-billing-pool', 'auth:clear-billing-pool']) {
      expect(handlers.has(ch)).toBe(false)
    }
  })

  // 这条是安全断言：任何一个通道只要回传了形如 sk- 的字符串就红。
  it('没有任何通道会把 token 回给渲染层', async () => {
    await register()
    for (const [, handler] of handlers) {
      const out = await handler({}, { projectId: 342, producerProjectId: null }).catch(() => null)
      expect(JSON.stringify(out ?? '')).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/)
    }
  })
})
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run src/main/services/auth/__tests__/ipc.test.ts`
Expected: FAIL —— 通道未注册

- [ ] **Step 3: 实现**

在 `src/main/services/auth/ipc.ts` 里，跟着既有 `quotaRpc` 信封的写法加：

```ts
ipcMain.handle('auth:set-billing-pool', (_e, raw: unknown) =>
  quotaRpc(async () => {
    const p = raw as { projectId?: unknown; producerProjectId?: unknown }
    const projectId = Number(p?.projectId)
    if (!Number.isFinite(projectId) || projectId <= 0) {
      throw new AuthError('INVALID_POOL', 'projectId 不合法')
    }
    const ppid = Number(p?.producerProjectId)
    const pool = {
      projectId,
      producerProjectId: Number.isFinite(ppid) && ppid > 0 ? ppid : null,
    }
    // 先取到再置为 active：取失败时不该让 UI 显示「已切换」。
    await getGatewayToken(pool)
    setActivePool(pool)
    // 只回「能不能用」，不回凭据本身。
    return { ready: true }
  }),
)

ipcMain.handle('auth:clear-billing-pool', () =>
  quotaRpc(async () => {
    setActivePool(null)
    return null
  }),
)
```

并把这两个通道名加进 `AUTH_CHANNELS`（漏加的症状是热重载后 handler 泄漏，再注册时 `ipcMain.handle` 对同一通道抛 "second handler"）。

登出路径里追加 `await clearGatewayTokens()`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/main/services/auth/__tests__/ipc.test.ts`
Expected: PASS

- [ ] **Step 5: preload 与类型**

`src/preload/index.ts` 的 `AgentApi`/`auth` 对象加两个方法，形状跟着既有的 `getBalance` 走。

`src/types/authApi.ts` 加**与 Task 1 的 `Pool` 逐字段相同**的类型（渲染层不能 import 主进程模块，所以必须重新声明；两边形状不一致就会在 IPC 边界上静默错位）：

```ts
/**
 * 计费池引用。**必须与主进程 `services/auth/gatewayToken.ts` 的 `Pool` 保持一致** ——
 * 那边是真源，这里是渲染层侧的镜像。
 *
 * `producerProjectId` 是池键的另一半，不是可选装饰：两个 producer 项目可以共用
 * 同一个 `projectId`，只按 `projectId` 认会把两个不同的钱包合并。
 */
export interface BillingPoolRef {
  projectId: number
  producerProjectId: number | null
}
```

- [ ] **Step 6: 提交**

```bash
git add src/main/services/auth/ipc.ts src/preload/index.ts src/types/authApi.ts src/main/services/auth/__tests__/ipc.test.ts
git commit -m "feat(auth): 平台计费池切换通道,只回可用性不回凭据"
```

---

## Task 4: 渲染层接入

**Files:**
- Modify: `src/renderer/src/stores/useQuotaStore.ts`
- Modify: `src/renderer/src/services/api/ApiService.ts`
- Modify: `src/renderer/src/pages-react/settings/AccountSection.tsx`
- Test: `src/renderer/src/services/api/__tests__/ApiService.platformBilling.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

```ts
// src/renderer/src/services/api/__tests__/ApiService.platformBilling.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'

describe('平台计费模式下的请求头', () => {
  beforeEach(() => vi.resetModules())

  it('平台模式：打标记头，且不发 Authorization', async () => {
    const headers = await captureHeadersFor({ billingSource: 'platform', site: 'antigravity' })

    expect(headers['X-Catimation-Billing']).toBe('platform')
    // 关键：渲染层根本没有 token 可发。发了空 Bearer 会被主进程覆盖，
    // 但发了用户的旧 key 就会在主进程注入失败时静默走错账。
    expect(headers.Authorization).toBeUndefined()
  })

  it('自有 key 模式：照旧发 Authorization，不打标记', async () => {
    const headers = await captureHeadersFor({ billingSource: 'own-key', site: 'antigravity' })

    expect(headers.Authorization).toBe('Bearer user-typed-key')
    expect(headers['X-Catimation-Billing']).toBeUndefined()
  })

  // 平台余额只覆盖 Miau 网关。别的站点（apiyi / 自建）是另外的计费域，
  // 打了标记也没用，反而会因为缺 Authorization 直接 401。
  it('非 Miau 站点即使开着平台模式也不打标记', async () => {
    const headers = await captureHeadersFor({ billingSource: 'platform', site: 'apiyi' })

    expect(headers['X-Catimation-Billing']).toBeUndefined()
    expect(headers.Authorization).toBe('Bearer user-typed-key')
  })
})
```

`captureHeadersFor` 的实现（放在同文件顶部）：

```ts
async function captureHeadersFor(opts: {
  billingSource: 'platform' | 'own-key'
  site: string
}): Promise<Record<string, string>> {
  let seen: Record<string, string> = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      seen = (init.headers ?? {}) as Record<string, string>
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ url: 'https://example.test/out.png' }] }),
      } as unknown as Response
    }),
  )
  // store 的 billingSource 由 ApiService 通过 getState() 读取,所以这里直接置状态。
  const { useQuotaStore } = await import('../../../stores/useQuotaStore')
  useQuotaStore.setState({ billingSource: opts.billingSource })

  const { ApiService } = await import('../ApiService')
  const svc = new ApiService()
  // 用户自填的 key，用来验证「平台模式下它不该被发出去」。
  svc.setApiKey?.(opts.site, 'user-typed-key')
  await svc
    .generateImage({ prompt: 'x', model: 'doubao-seedream-5-0-pro-260628', siteKey: opts.site })
    .catch(() => {})
  return seen
}
```

⚠️ 实现这一步时先跑一次同目录的 `ApiService.gptImage2Vip.test.ts`，照它的实际装配方式校准上面这段——`ApiService` 的构造与 key 注入方式若与此处不符，以既有测试为准，并回改本计划。

- [ ] **Step 2: 跑测试确认它失败**

Run: `npx vitest run src/renderer/src/services/api/__tests__/ApiService.platformBilling.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`useQuotaStore.ts` 加：

```ts
  /** 'platform' = 用平台账号余额（凭据在主进程）；'own-key' = 用用户自填的 key。 */
  billingSource: 'platform' | 'own-key'
  setBillingSource: (s: 'platform' | 'own-key') => Promise<void>
```

`setBillingSource('platform')` 里调 `window.electronAPI.auth.setBillingPool(selectedPool)`，失败则回落 `'own-key'` 并把错误摊在 store 的 `error` 上——**不能静默留在 platform 态**，否则用户以为在花平台余额，实际每个请求都 401。

`ApiService.ts` 的请求头装配处（`authType === 'bearer'` 那一支，约 1440 / 1981 / 2053 行）改成：

```ts
      if (usePlatformBilling(site)) {
        // 凭据在主进程。这里只打标记，主进程的 onBeforeSendHeaders 会按 host
        // 过滤后换成真 Authorization。渲染层是 nodeIntegration:true 的环境,
        // 不放凭据。
        headers['X-Catimation-Billing'] = 'platform'
      } else if (site.authType === 'bearer') {
        headers['Authorization'] = `Bearer ${apiKey}`
      } else {
        headers['x-api-key'] = apiKey
      }
```

`usePlatformBilling(site)` 的判据是 `billingSource === 'platform' && siteKey === MIAU_SITE_KEY`。

`AccountSection.tsx` 加一个二选一开关，未登录或未选池时禁用并给出原因。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/renderer/src/services/api/__tests__/ApiService.platformBilling.test.ts`
Expected: PASS（3 条）

- [ ] **Step 5: 回归**

Run: `npx vitest run src/renderer/src/services/api src/renderer/src/stores src/renderer/src/pages-react/settings`
Expected: 无新增失败（本仓有预存 flake，逐条确认是不是本次引入）

- [ ] **Step 6: 提交**

```bash
git add src/renderer/src/stores/useQuotaStore.ts src/renderer/src/services/api/ApiService.ts src/renderer/src/pages-react/settings/AccountSection.tsx src/renderer/src/services/api/__tests__/ApiService.platformBilling.test.ts
git commit -m "feat(billing): 渲染层平台计费开关,只打标记不持有凭据"
```

---

## Task 5: 打包期翻 Electron fuses

**Files:**
- Modify: `electron-builder.yml`

这几枚直接堵住「拿我们自己已签名的二进制当 Node 解释器，跑一段脚本把凭据读出来」这条本地提权路径（官方称 living-off-the-land）。当前一枚都没翻。

- [ ] **Step 1: 确认这版 builder 支持**

Run: `npx electron-builder --help` 之后，检查 `node_modules/app-builder-lib` 里是否存在 `FuseOptionsV1`：

```bash
node -e "console.log(Object.keys(require('app-builder-lib/out/options/FuseOptionsV1')))" 2>&1
```

Expected: 不报 `Cannot find module`。若报错，说明 26.4 不带这个选项，改用 `afterPack` 钩子调 `@electron/fuses`（并在本任务里记下实际做法）。

- [ ] **Step 2: 加配置**

在 `electron-builder.yml` 顶层加：

```yaml
# 打包期翻的「保险丝」，在代码签名**之前**生效,之后由 OS 的签名校验保证它们
# 翻不回去。堵的是「用我们自己已签名的二进制当 Node 解释器读凭据」这条路。
electronFuses:
  runAsNode: false
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false
  enableCookieEncryption: true
  # 这两枚配合使用才有意义:前者让 Electron 校验 app.asar 的 SHA-256,
  # 后者禁掉 app/ 目录与 default_app.asar 回落 —— 合起来 = 无法侧载未校验的代码。
  # Windows 要求 Electron ≥ 30（本项目 43，满足）。
  enableEmbeddedAsarIntegrityValidation: true
  onlyLoadAppFromAsar: true
```

- [ ] **Step 3: 实跑一次打包验证**

Run: `npm run build:win`
Expected: 打包成功，且产物能正常启动（**必须真装一次跑起来**——`onlyLoadAppFromAsar` 配错会让应用直接起不来，而这在 CI 的构建步骤里看不出来）。

- [ ] **Step 4: 提交**

```bash
git add electron-builder.yml
git commit -m "chore(security): 打包期翻 Electron fuses,堵住 living-off-the-land 提权"
```

---

## Task 6: 已知缺口留档

**Files:**
- Create: `docs/superpowers/specs/2026-08-28-gateway-token-known-gaps.md`

这些都**不在本计划的修复范围内**，但必须写下来，否则下一个人会以为已经处理过。

- [ ] **Step 1: 写文档**

内容至少覆盖：

1. **`TRUSTED_PROXIES` 缺失（new-api）。** 全代码库零处 `SetTrustedProxies`，Gin 默认信任所有代理并读 `X-Forwarded-For`。任何能直连网关端口的人伪造一个 XFF 就能绕过 `AllowIps`、绕过 IP 限流、污染日志 IP 归因。上游已补 `middleware/trusted_proxies.go`，我们这份 fork 没同步。**这是独立的安全修复，应单开一条线。**
2. **令牌在数据库里是明文。** `Token.Key` 是 `varchar(128)`，`GetTokenByKey` 做明文等值比对（对照：用户密码走 bcrypt）。库泄漏 = 所有令牌立即可用。
3. **没有令牌级限流或消费上限。** 唯一作用于 relay 的限流按 **user id** 计数，配置来源才是令牌的 group —— 给桌面端限流会连带限住服务端那几个共用方。上游明确拒绝在开源版做（issue #571）。
4. **唯一的内置告警是「余额快用完了」**，看剩余绝对值不看速率，被盗刷时在钱快花光时才响。
5. **Windows 上 `safeStorage` 不防同用户态的其他程序**（DPAPI 官方语义）。任何用户可见文案都**不得**宣称「已安全保护」。
6. **可选增强：用量归因。** `X-Platform-User-Id` / `X-Project-Id` / `X-Session-Id` 客户端可设且不被剥离，全都落进消费日志。桌面端带上 `X-Session-Id: desktop-<uuid>` 就能在用量明细里把自己的消费单独捞出来。**本计划未做**，因为它需要先确认这些头不会与网关既有语义冲突。

- [ ] **Step 2: 提交**

```bash
git add docs/superpowers/specs/2026-08-28-gateway-token-known-gaps.md
git commit -m "docs: 网关 token 方案的已知缺口留档"
```

---

## 验收

跑通这条链路才算完成，缺一不可：

1. 登录 → 设置页选一个组织/池 → 打开「用平台余额」
2. 出一张图，成功
3. 该池余额**确实减少**（在设置页刷新余额看）
4. 用量明细里能看到这一笔
5. 关掉「用平台余额」→ 用自己填的 key 出图，仍然正常（**这条最容易忘**：注入器一旦漏判会把用户的 key 覆盖掉）
6. 登出 → `gateway-tokens.enc` 被删除，再出图回落到自有 key
7. 在 DevTools 里搜 `sk-`，**渲染层内存中不应存在网关 token**

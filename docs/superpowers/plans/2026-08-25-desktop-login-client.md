# 桌面端浏览器登录 — CATIMATION 客户端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 CATIMATION 能通过系统浏览器登录 sora-ui 账号,凭证经回环回调交回主进程并加密落盘。

**Architecture:** 主进程新增 `src/main/services/auth/` 五个单一职责模块(PKCE 纯函数 / 回环监听 / safeStorage 凭证 / 会话与存活探测 / IPC 编排)。token **只存在主进程**,渲染层只拿派生态。软门:登录只用于身份与云端额度,自带 API key 的功能不登录也能用。

**Tech Stack:** Electron 43 + electron-vite 5 + React 19 + Tailwind v4(CSS-first `@theme`)+ TypeScript 6 + Vitest 4 + pnpm

**Spec:** `docs/superpowers/specs/2026-08-25-desktop-browser-login-design.md`
**后端计划(已完成):** `../../../25/soraui_4.0/sora-ui-backend/docs/superpowers/plans/2026-08-25-desktop-login-backend.md`

## Global Constraints

- **包管理器 pnpm**(`package.json` 声明 `packageManager: pnpm@10.12.4`)。加依赖必须提交 `pnpm-lock.yaml`,CI 用 `--frozen-lockfile`。
- **测试放 `src/**/__tests__/`**。`vitest.config.ts:26-29` 的 include 只有 `src/**`;顶层 `tests/` 走另一个 config,不要往那儿放。
- **不新增 typecheck 诊断。** `tests/ci-cd/typecheck-baseline.json` 的 `expiresAt` 是 **2026-08-31**,硬编码在 `scripts/ci/typecheck-baseline.mjs:148`,`--write` 也推不动。
- **六个 CI 门必须全绿**:`contracts` / `typecheck` / `unit-tests` / `skill-gates` / `build` / `e2e-stable`。
- **主进程出网一律用 `net.fetch` + `AbortController`。** 不要用 Node 全局 `fetch` —— 它绕过 Chromium 的代理与证书配置,在代理后面只吐无信息量的 `fetch failed`(理由见 `src/main/index.ts:1026-1033`)。**实测这台开发机访问目标域名走本地 fake-IP 代理(DNS 解到 `198.18.0.153`),所以这条不是风格问题,是能不能登录的问题。**
- **`safeStorage` 在 `app` ready 之前调用会 throw。** Electron 源码里 `IsEncryptionAvailable()` 第一行就是 `if (!Browser::Get()->is_ready()) return false;`。凭证模块**不得在模块加载时读盘**,必须懒加载。
- **不要调 `safeStorage.setUsePlainTextEncryption(true)`。** 它在 Linux 无系统密码管理器时改用内存固定密码 —— 混淆不是加密,对认证 token 宁可降级到「本次会话有效」。
- **token 只留主进程。** 渲染层只经 IPC 拿 `{ authenticated, username, displayName, role, credentialSource }`。注意这是**降低暴露面的缓解措施,不是信任边界** —— 本应用 `contextIsolation: false` + `nodeIntegration: true`,渲染层本就能 `require('fs')`。
- **认证路径不得复用 `validateExternalUrlMain`**(`src/main/index.ts:2358-2366`)—— 它只查 scheme、放行任意 http/https 主机。认证要做**精确 origin 比对**到配置的 IdP 基址。
- IdP 基址:常量默认 `https://13797248455.xyz`,可用 `CATIMATION_AUTH_BASE_URL` 覆盖(开发指向 `http://127.0.0.1:3001`)。

## 后端契约(已构建并测试,按此对齐)

桌面端只调下面两个;`/:id`、`approve`、`deny` 属于 sora-ui 授权页。
错误信封统一 `{ success: false, error: { code, message } }`。

```
POST {base}/api/auth/desktop/start          公开
  body  { codeChallenge, state, clientName, callbackHost?, callbackPort? }
  201   { success:true, data:{ pairingId, authorizeUrl, expiresIn } }   // expiresIn = 300
  400   MISSING_CODE_CHALLENGE | MISSING_STATE | MISSING_CLIENT_NAME
        | INVALID_CALLBACK_HOST | INVALID_CALLBACK_PORT
  500   MISSING_PUBLIC_BASE_URL | INVALID_PUBLIC_BASE_URL | INTERNAL_ERROR

POST {base}/api/auth/desktop/claim          公开
  body  { pairingId, grantCode, codeVerifier }
  200   { success:true, data:{ token, user:{ id, username, email, phone, role, displayName }, expiresAt } }
  400   MISSING_PAIRING_ID | GRANT_CODE_MISMATCH | PKCE_MISMATCH
  404   PAIRING_NOT_FOUND
  409   PAIRING_ALREADY_CLAIMED | PAIRING_NOT_APPROVED
  410   PAIRING_EXPIRED
```

**`callbackHost` 只接受 `127.0.0.1` 与 `[::1]` 两个字面量**,回调 path 恒为 `/cb` 由服务端构造。
**重试必须从 `start` 重来** —— `claim` 是一次性的,不能重放。

---

### Task 1: PKCE 与 state 生成(纯函数)

**Files:**
- Create: `src/main/services/auth/pkce.ts`
- Test: `src/main/services/auth/__tests__/pkce.test.ts`

**Interfaces:**
- Consumes: 无(`node:crypto`)
- Produces:
  - `generateCodeVerifier(): string`
  - `deriveCodeChallenge(verifier: string): string`
  - `generateState(): string`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { deriveCodeChallenge, generateCodeVerifier, generateState } from '../pkce'

describe('generateCodeVerifier', () => {
  it('satisfies RFC 7636 §4.1: 43-128 chars from the unreserved set', () => {
    for (let i = 0; i < 50; i++) {
      const v = generateCodeVerifier()
      expect(v.length).toBeGreaterThanOrEqual(43)
      expect(v.length).toBeLessThanOrEqual(128)
      expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/)
    }
  })

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateCodeVerifier()))
    expect(seen.size).toBe(200)
  })
})

describe('deriveCodeChallenge', () => {
  // RFC 7636 Appendix B 官方向量。后端用同一组做校验,两边必须一致。
  it('matches the RFC 7636 Appendix B vector', () => {
    expect(deriveCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('is base64url with no padding', () => {
    expect(deriveCodeChallenge(generateCodeVerifier())).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})

describe('generateState', () => {
  it('is high-entropy base64url', () => {
    const s = generateState()
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(s.length).toBeGreaterThanOrEqual(43)
  })

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateState()))
    expect(seen.size).toBe(200)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/main/services/auth/__tests__/pkce.test.ts`
Expected: FAIL — 无法解析 `../pkce`

- [ ] **Step 3: 实现**

```ts
// PKCE(RFC 7636)与 state(RFC 8252 §8.9)的生成。纯函数,无 IO。
//
// 校验侧在后端(`sora-ui-backend/src/utils/desktopPairing.ts`),两边共用 RFC 7636
// Appendix B 的官方向量做一致性锚点 —— 任何一边改了编码方式,那条测试会先红。

import crypto from 'node:crypto'

/** RFC 7636 §4.1:43–128 字符,取自 unreserved 集合。32 字节 base64url 恰好 43 字符。 */
export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/** RFC 7636 §4.2:challenge = BASE64URL(SHA256(ASCII(verifier)))。只支持 S256。 */
export function deriveCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

/** RFC 8252 §8.9:高熵随机数,回调侧比对,不匹配即拒。 */
export function generateState(): string {
  return crypto.randomBytes(32).toString('base64url')
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run src/main/services/auth/__tests__/pkce.test.ts`
Expected: PASS — 6 个 it 全绿

- [ ] **Step 5: 提交**

```bash
git add src/main/services/auth/pkce.ts src/main/services/auth/__tests__/pkce.test.ts
git commit -m "feat(auth): PKCE verifier/challenge 与 state 生成"
```

---

### Task 2: 回环回调监听

**Files:**
- Create: `src/main/services/auth/loopback.ts`
- Test: `src/main/services/auth/__tests__/loopback.test.ts`

**Interfaces:**
- Consumes: 无(`node:http`)
- Produces:
  - `startLoopbackListener(opts: { state: string; timeoutMs?: number }): Promise<LoopbackListener>`
  - `interface LoopbackListener { host: '127.0.0.1' | '[::1]'; port: number; redirectUri: string; waitForCode(): Promise<string>; close(): void }`

**RFC 8252 §7.3 / §8.3 的四条硬要求,实现必须逐条满足:**

1. 用 IP 字面量 `127.0.0.1` / `[::1]`,**不用 `localhost`** —— 后者可被 hosts 文件改指向,回调会被本机攻击者劫走。
2. **临时端口**(`listen(0)`),不硬编码。
3. **两个地址族都试**,用先绑上的那个。
4. **只绑回环接口**,只在授权期间开着,拿到响应立刻关。

另外两条来自实践:回调走 **query string**(fragment 不会发给 HTTP 服务器,监听器永远收不到),以及**收到的 URI 必须与发出去的 `redirectUri` 精确比对**(RFC 8252 §8.10 的 MUST)。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it, afterEach } from 'vitest'
import http from 'node:http'
import { startLoopbackListener } from '../loopback'

const open: Array<{ close(): void }> = []
afterEach(() => {
  open.splice(0).forEach((l) => l.close())
})

async function track<T extends { close(): void }>(p: Promise<T>): Promise<T> {
  const l = await p
  open.push(l)
  return l
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      .on('error', reject)
  })
}

describe('startLoopbackListener', () => {
  it('binds a loopback IP literal on an OS-assigned port, never localhost', async () => {
    const l = await track(startLoopbackListener({ state: 's' }))
    expect(['127.0.0.1', '[::1]']).toContain(l.host)
    expect(l.port).toBeGreaterThan(0)
    expect(l.redirectUri).toBe(`http://${l.host}:${l.port}/cb`)
    expect(l.redirectUri).not.toContain('localhost')
  })

  it('resolves with the code when state matches', async () => {
    const l = await track(startLoopbackListener({ state: 'st-1' }))
    const pending = l.waitForCode()
    const res = await get(`${l.redirectUri}?code=abc123&state=st-1`)
    expect(res.status).toBe(200)
    expect(res.body).toContain('</html>')
    await expect(pending).resolves.toBe('abc123')
  })

  it('rejects a state mismatch with 400 and does not resolve', async () => {
    const l = await track(startLoopbackListener({ state: 'st-1' }))
    let settled = false
    l.waitForCode().then(
      () => (settled = true),
      () => (settled = true),
    )
    const res = await get(`${l.redirectUri}?code=abc123&state=WRONG`)
    expect(res.status).toBe(400)
    await new Promise((r) => setTimeout(r, 50))
    expect(settled).toBe(false)
  })

  it('rejects a wrong path with 404 and does not resolve', async () => {
    const l = await track(startLoopbackListener({ state: 'st-1' }))
    let settled = false
    l.waitForCode().then(
      () => (settled = true),
      () => (settled = true),
    )
    const res = await get(`http://${l.host}:${l.port}/not-cb?code=a&state=st-1`)
    expect(res.status).toBe(404)
    await new Promise((r) => setTimeout(r, 50))
    expect(settled).toBe(false)
  })

  it('surfaces an error response from the authorization page', async () => {
    const l = await track(startLoopbackListener({ state: 'st-1' }))
    const pending = l.waitForCode()
    await get(`${l.redirectUri}?error=access_denied&state=st-1`)
    await expect(pending).rejects.toThrow(/access_denied/)
  })

  it('times out and releases the port', async () => {
    const l = await track(startLoopbackListener({ state: 's', timeoutMs: 30 }))
    const { port } = l
    await expect(l.waitForCode()).rejects.toThrow(/timed out/i)
    await new Promise((r) => setTimeout(r, 20))
    await expect(get(`http://127.0.0.1:${port}/cb`)).rejects.toThrow()
  })

  it('close() releases the port and rejects a pending wait', async () => {
    const l = await startLoopbackListener({ state: 's' })
    const pending = l.waitForCode()
    const { port } = l
    l.close()
    await expect(pending).rejects.toThrow(/cancell?ed/i)
    await new Promise((r) => setTimeout(r, 20))
    await expect(get(`http://127.0.0.1:${port}/cb`)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/main/services/auth/__tests__/loopback.test.ts`
Expected: FAIL — 无法解析 `../loopback`

- [ ] **Step 3: 实现**

```ts
// RFC 8252 §7.3 的回环回调监听。
//
// 四条硬要求,逐条对应下面的实现:
//   §7.3  用 IP 字面量而非 localhost —— 后者可被 hosts 文件改指向(§8.3),
//         回调会被本机攻击者劫走;IP 字面量还能避免误监听到非回环网卡。
//   §7.3  临时端口:向操作系统要(listen(0)),不硬编码。授权服务器 MUST 接受任意端口。
//   §7.3  两个地址族都试,用先绑上的那个 —— 不能假设设备支持某个特定 IP 版本。
//   §8.3  只在授权期间开端口,拿到响应立刻关;只绑回环接口。
//
// 回环上用明文 http 是标准明确认可的(§8.3:请求从不离开本机),不需要自签证书。
//
// 授权码走 **query string** 而非 fragment:fragment 根本不会发给 HTTP 服务器,
// 监听器永远收不到。这是个反复被踩的坑。

import http from 'node:http'
import { AddressInfo } from 'node:net'

const CALLBACK_PATH = '/cb'
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export interface LoopbackListener {
  host: '127.0.0.1' | '[::1]'
  port: number
  /** 发出去的完整回调 URI。RFC 8252 §8.10 要求收到回调时与它精确比对。 */
  redirectUri: string
  waitForCode(): Promise<string>
  close(): void
}

const DONE_HTML = `<!doctype html><html lang="zh"><meta charset="utf-8">
<title>登录成功</title><body style="font-family:system-ui;text-align:center;padding:4rem">
<h1>登录成功</h1><p>可以关闭本页,回到 CATIMATION 继续。</p></body></html>`

function bind(server: http.Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error): void => {
      server.removeListener('listening', onListening)
      reject(e)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve((server.address() as AddressInfo).port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, host)
  })
}

export async function startLoopbackListener(opts: {
  state: string
  timeoutMs?: number
}): Promise<LoopbackListener> {
  let resolveCode: (code: string) => void = () => {}
  let rejectCode: (e: Error) => void = () => {}
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res
    rejectCode = rej
  })
  // 没有 waitForCode() 的消费者时也不能让进程因未处理 rejection 崩掉。
  codePromise.catch(() => {})

  let settled = false
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`)
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end('not found')
      return
    }
    if (url.searchParams.get('state') !== opts.state) {
      // 陈旧、外来或重放的回调:拒绝,且**不**进入兑换(RFC 8252 §8.9)。
      res.writeHead(400).end('state mismatch')
      return
    }
    const err = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    res.writeHead(err || !code ? 400 : 200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(err || !code ? 'authorization failed' : DONE_HTML)
    if (settled) return
    settled = true
    if (err) rejectCode(new Error(`authorization failed: ${err}`))
    else if (code) resolveCode(code)
    // 拿到响应立刻关(§8.3)。
    close()
  })

  // 两个地址族都试,用先绑上的那个(§7.3)。
  let host: '127.0.0.1' | '[::1]' = '127.0.0.1'
  let port: number
  try {
    port = await bind(server, '127.0.0.1')
  } catch {
    port = await bind(server, '::1')
    host = '[::1]'
  }

  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    rejectCode(new Error('loopback callback timed out'))
    close()
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  function close(): void {
    clearTimeout(timer)
    server.close()
    server.closeAllConnections?.()
    if (!settled) {
      settled = true
      rejectCode(new Error('loopback listener cancelled'))
    }
  }

  return {
    host,
    port,
    redirectUri: `http://${host}:${port}${CALLBACK_PATH}`,
    waitForCode: () => codePromise,
    close,
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run src/main/services/auth/__tests__/loopback.test.ts`
Expected: PASS — 7 个 it 全绿,输出无悬空 rejection 警告

- [ ] **Step 5: 提交**

```bash
git add src/main/services/auth/loopback.ts src/main/services/auth/__tests__/loopback.test.ts
git commit -m "feat(auth): RFC 8252 回环回调监听"
```

---

### Task 3: 凭证加密落盘

**Files:**
- Create: `src/main/services/auth/credentials.ts`
- Test: `src/main/services/auth/__tests__/credentials.test.ts`

**Interfaces:**
- Consumes: `electron` 的 `app` / `safeStorage`
- Produces:
  - `interface StoredCredential { token: string; userId: string; username: string; displayName: string; role: string; expiresAt: number }`
  - `getCredential(): StoredCredential | null`
  - `setCredential(c: StoredCredential): void`
  - `clearCredential(): void`
  - `credentialSource(): 'safeStorage' | 'memory' | 'none'`
  - `onCredentialChanged(cb: () => void): () => void`

照抄 `src/main/services/tencent/credentials.ts` 的形状(懒加载 + 内存降级 + 失效回调注册表),
写 `auth-credentials.bin` 到 `app.getPath('userData')`。

**三条不可违背:**
- **不得在模块加载时读盘。** `safeStorage` 在 `app` ready 之前调用会 throw。所有读取都懒加载。
- **`decryptString` 会校验 v10/v11 密文前缀**,文件损坏时抛 `"Ciphertext does not appear to be encrypted"` 而非返回垃圾。读路径 try/catch,当作「无凭证」。
- **不要调 `setUsePlainTextEncryption(true)`。**

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'

const store = new Map<string, Buffer>()
let encryptionAvailable = true

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\fake\\userData' },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (s: string) => Buffer.concat([Buffer.from('v10'), Buffer.from(s, 'utf8')]),
    decryptString: (b: Buffer) => {
      if (!b.subarray(0, 3).equals(Buffer.from('v10'))) {
        throw new Error('Ciphertext does not appear to be encrypted.')
      }
      return b.subarray(3).toString('utf8')
    },
  },
}))

vi.mock('node:fs', () => ({
  default: {
    existsSync: (p: string) => store.has(p),
    readFileSync: (p: string) => {
      const v = store.get(p)
      if (!v) throw new Error('ENOENT')
      return v
    },
    writeFileSync: (p: string, b: Buffer) => void store.set(p, b),
    unlinkSync: (p: string) => void store.delete(p),
  },
}))

const CRED = {
  token: 'jwt.tok.en',
  userId: 'u1',
  username: 'alice',
  displayName: 'Alice',
  role: 'USER',
  expiresAt: 1893456000000,
}

describe('auth credentials', () => {
  beforeEach(async () => {
    store.clear()
    encryptionAvailable = true
    vi.resetModules()
  })

  it('round-trips through safeStorage', async () => {
    const m = await import('../credentials')
    expect(m.getCredential()).toBeNull()
    m.setCredential(CRED)
    expect(m.getCredential()).toEqual(CRED)
    expect(m.credentialSource()).toBe('safeStorage')
  })

  it('falls back to memory when encryption is unavailable', async () => {
    encryptionAvailable = false
    const m = await import('../credentials')
    m.setCredential(CRED)
    expect(m.getCredential()).toEqual(CRED)
    expect(m.credentialSource()).toBe('memory')
    expect(store.size).toBe(0)
  })

  it('treats a corrupted blob as no credential instead of throwing', async () => {
    const m = await import('../credentials')
    m.setCredential(CRED)
    const key = [...store.keys()][0]
    store.set(key, Buffer.from('garbage-without-prefix'))
    vi.resetModules()
    const m2 = await import('../credentials')
    expect(m2.getCredential()).toBeNull()
  })

  it('clear() removes the credential and the file', async () => {
    const m = await import('../credentials')
    m.setCredential(CRED)
    m.clearCredential()
    expect(m.getCredential()).toBeNull()
    expect(store.size).toBe(0)
  })

  it('notifies subscribers on set and clear, and stops after unsubscribe', async () => {
    const m = await import('../credentials')
    const cb = vi.fn()
    const off = m.onCredentialChanged(cb)
    m.setCredential(CRED)
    m.clearCredential()
    expect(cb).toHaveBeenCalledTimes(2)
    off()
    m.setCredential(CRED)
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('does not touch disk at import time', async () => {
    store.set('C:\\fake\\userData\\auth-credentials.bin', Buffer.from('v10' + JSON.stringify(CRED)))
    const spy = vi.spyOn(store, 'get')
    await import('../credentials')
    expect(spy).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/main/services/auth/__tests__/credentials.test.ts`
Expected: FAIL — 无法解析 `../credentials`

- [ ] **Step 3: 实现**

照 `src/main/services/tencent/credentials.ts` 的结构写。要点:
- `filePath()` 每次调用时才 `app.getPath('userData')`,不在模块顶层求值
- `cached: StoredCredential | null | undefined`(`undefined` = 尚未读过),`getCredential()` 首次调用才读盘
- `safeStorage.isEncryptionAvailable()` 为假时写 `inMemoryFallback`,`credentialSource()` 回 `'memory'`
- 读路径整体 try/catch,任何异常都返回 `null`
- `onCredentialChanged` 用 `Set<() => void>`,返回取消订阅函数;`setCredential` / `clearCredential` 后遍历通知

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run src/main/services/auth/__tests__/credentials.test.ts`
Expected: PASS — 6 个 it 全绿

- [ ] **Step 5: 提交**

```bash
git add src/main/services/auth/credentials.ts src/main/services/auth/__tests__/credentials.test.ts
git commit -m "feat(auth): safeStorage 凭证落盘与内存降级"
```

---

### Task 4: 会话、存活探测与 IdP 客户端

**Files:**
- Create: `src/main/services/auth/session.ts`
- Test: `src/main/services/auth/__tests__/session.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `getCredential` / `setCredential` / `clearCredential` / `credentialSource`
- Produces:
  - `interface AuthState { authenticated: boolean; username: string | null; displayName: string | null; role: string | null; credentialSource: 'safeStorage' | 'memory' | 'none' }`
  - `authBaseUrl(): string`
  - `startPairing(clientName: string, callback: { host: string; port: number } | null): Promise<{ pairingId: string; authorizeUrl: string }>`
  - `claimPairing(pairingId: string, grantCode: string, codeVerifier: string): Promise<void>`
  - `getAuthState(): AuthState`
  - `probeLiveness(): Promise<void>`
  - `logout(): void`

**存活探测的取舍(直接取自 `shortdrama-mvp/src/lib/auth/directory.ts:95-135`):** 打一个需要
`authMiddleware` 的端点(`GET /api/user/balance`),60 秒缓存,**网络失败 fail-open** ——
认证服务故障不该把用户锁在外面;401/403 才清凭证。

**绝不能用 `POST /api/auth/verify` 做探测** —— 它只回显 claims、不查库(`routes/auth.ts:267`),封号了照样通过。

- [ ] **Step 1: 写失败测试**

覆盖:`start`/`claim` 的请求体与错误码映射(400/409/410 各一)、claim 成功后凭证落盘且
`getAuthState().authenticated === true`、探测 60 秒缓存命中只发一次请求、网络异常 fail-open
保持登录、401 清凭证并广播、`logout()` 清凭证。用 `vi.mock('electron', …)` 提供 `net.fetch`
的假实现,并 mock Task 3 的 credentials 模块。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run src/main/services/auth/__tests__/session.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

要点:
- 出网一律 `net.fetch` + `AbortController`(15s),**不要 Node 全局 fetch**
- `authBaseUrl()` 读 `process.env.CATIMATION_AUTH_BASE_URL`,缺省 `https://13797248455.xyz`,末尾斜杠归一
- 响应按 `{ success, data, error }` 解析;非 2xx 时抛带 `code` 的错误供 IPC 层转成用户可读文案
- `probeLiveness()`:`lastProbeAt` 60 秒内直接返回;`net.fetch` 抛错 → 静默返回(fail-open);
  401/403 → `clearCredential()`

- [ ] **Step 4/5: 通过并提交**

```bash
git add src/main/services/auth/session.ts src/main/services/auth/__tests__/session.test.ts
git commit -m "feat(auth): IdP 客户端、会话状态与存活探测"
```

---

### Task 5: IPC 编排与 preload 接线

**Files:**
- Create: `src/main/services/auth/ipc.ts`
- Modify: `src/main/index.ts`(在 `createWindow()` 之前调 `registerAuthIpc()`)
- Modify: `src/preload/index.ts`(`IPC_CHANNELS.AUTH` + `AUTH_EVENTS` + `electronAPI.auth`)
- Test: `src/main/services/auth/__tests__/ipc.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 全部
- Produces:通道 `auth:get-state` / `auth:start-login` / `auth:cancel-login` / `auth:submit-code` / `auth:logout`,推送 `auth:state-changed`

**编排职责(pending 状态只活在这里):** 持有本次登录的 `codeVerifier` / `state` /
**`redirectUri` 原串**(RFC 8252 §8.10 的 MUST:必须存下发出去的 redirect URI 并在收到时精确比对)/ 回环句柄。

**注册时机:** 必须在 `createWindow()`(`src/main/index.ts:1323`)**之前**,否则登录 UI 挂载时会撞上 "No handler registered"。

**`shell.openExternal` 收紧:** 认证路径不复用 `validateExternalUrlMain`(只查 scheme)。
打开前做**精确 origin 比对**:`new URL(authorizeUrl).origin === new URL(authBaseUrl()).origin`,不匹配就拒绝并记日志。

**preload 两处:**
- invoke 通道**不用改白名单** —— `safeInvoke` 无校验(`src/preload/index.ts:829-831`)
- 推送事件要新增 `AUTH_EVENTS: ['auth:state-changed'] as const`,仿 `AGENT_EVENTS`(`:339-348`),用 `safeOnWithCleanup` 消费

- [ ] **Step 1–5:** 按 TDD 写测试 → 失败 → 实现 → 通过 → 提交

```bash
git add src/main/services/auth/ipc.ts src/main/services/auth/__tests__/ipc.test.ts src/main/index.ts src/preload/index.ts
git commit -m "feat(auth): IPC 编排与 preload 接线"
```

---

### Task 6: 渲染层 —— 状态 store、设置页面板、全屏登录视图

**Files:**
- Create: `src/renderer/src/stores/useAuthStore.ts`
- Create: `src/renderer/src/pages-react/DesktopLoginPage.tsx`
- Modify: `src/renderer/src/pages-react/SettingsPage.tsx`(账号面板)
- Modify: `src/renderer/src/react-app/main.tsx`(`mountDesktopLoginReact` / `unmount…`)
- Test: `src/renderer/src/stores/__tests__/useAuthStore.test.ts`

**软门,所以不在 `src/renderer/src/main.ts:114` 拦住 `bootstrap()`。** 三处改动:

1. **`useAuthStore`**(Zustand,仿 `stores/useSettingsStore.ts`):挂载时 `auth:get-state`,订阅 `auth:state-changed`。**只存派生字段,永远不存 token。**
2. **设置页账号面板**:未登录显示「登录」,已登录显示用户名/角色/额度 + 「退出」。`SettingsPage.tsx` 已在做凭证输入 + IPC 往返,是最近的形状。
3. **全屏登录视图**:仿 `SmartErasePage.tsx`(最小的完整全页视图)。配色用 `@theme` 的 `--color-cyberpunk-yellow` `#FCE300` 与背景 `#09090B`。四态 `idle → waiting → success | error`;`waiting` 态提供「取消」「复制链接」「手动输入授权码」三个出口。
   「首次启动展示、可跳过」的判定用 `electron-store` 存 `authOnboardingSeen` —— 非机密状态,按仓库分工归 `electron-store`(与 `page-states` / `custom-templates` 同类),不进 `safeStorage`。

- [ ] **Step 1–5:** 按 TDD 推进,store 先行(可单测),UI 后随

```bash
git add src/renderer/src/stores/useAuthStore.ts src/renderer/src/stores/__tests__/useAuthStore.test.ts \
  src/renderer/src/pages-react/DesktopLoginPage.tsx src/renderer/src/pages-react/SettingsPage.tsx \
  src/renderer/src/react-app/main.tsx
git commit -m "feat(auth): 渲染层登录状态、账号面板与全屏登录视图"
```

---

## 错误文案映射

IPC 层把后端 `error.code` 转成用户可读文案,不要把原始 code 抛给界面:

| code | 文案 |
|---|---|
| `PKCE_MISMATCH` / `GRANT_CODE_MISMATCH` | 授权校验失败,请重新登录 |
| `PAIRING_ALREADY_CLAIMED` | 该授权码已被使用,请重新登录 |
| `PAIRING_NOT_APPROVED` | 尚未在浏览器中完成授权 |
| `PAIRING_EXPIRED` / `PAIRING_NOT_FOUND` | 登录已超时,请重新发起 |
| 网络 / TLS 层失败(无 HTTP 状态码) | **必须与「认证被拒绝」区分**:提示可能是网络或代理问题,并提供重试 |

**重试一律从 `start` 重来** —— `claim` 是一次性的,重放只会得到 409。

## 验收

- 六个 CI 门全绿;不新增 typecheck 诊断
- 手工:登录成功 / 浏览器点拒绝 / 5 分钟超时 / 粘贴兜底 / **断网后自带 key 的功能仍可用** / 退出后重启仍是登出态
- `safeStorage` 不可用时降级内存,UI 标注「重启后需重新登录」

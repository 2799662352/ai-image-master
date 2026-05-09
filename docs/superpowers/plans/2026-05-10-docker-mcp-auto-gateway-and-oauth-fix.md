# Docker MCP 自动网关 + OAuth 修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Docker MCP 的 stdio bug workaround 从手动一键修复升级为零交互自动转换，同时修复 OAuth 登录按钮点击无反应的 bug。

**Architecture:** 三条独立的改动线——(§1) preload 暴露 `shell.openExternal` + store 清错误修复 OAuth；(§2) 新增 `fetch-docker-mcp.ts` 下载脚本 + 路径解析 + Service 重构为直接调用 bundled 二进制；(§3) 删除手动 Banner/Modal，替换为自动检测 hook + Toast 通知。每条线有独立 commit，逐步叠加。

**Tech Stack:** TypeScript, Electron (preload/main/renderer), Vitest, Zustand, React, electron-builder

---

### Task 1: OAuth 登录修复 — store 清错误 + shell.openExternal 测试

**Files:**
- Modify: `src/renderer/src/features/agent-workspace/useMcpStore.ts:311-332`
- Test: `src/renderer/src/features/agent-workspace/__tests__/useMcpStore.test.ts`

- [ ] **Step 1: Write failing tests for OAuth error clearing and shell.openExternal call**

在 `src/renderer/src/features/agent-workspace/__tests__/useMcpStore.test.ts` 文件末尾 `})` 之前添加三个新测试：

```typescript
  it('startOAuthLogin clears previous error before calling mcpOAuthLogin', async () => {
    useMcpStore.setState({
      servers: [
        { name: 'hf', type: 'http', url: 'https://hf.co', enabled: true, status: 'failed', error: 'timed out waiting for OAuth callback', tools: [], isBuiltin: false },
      ],
    })

    mockApi.mcpOAuthLogin.mockResolvedValue({ ok: true, authorization_url: 'https://auth.example.com' })

    await useMcpStore.getState().startOAuthLogin('hf')

    // Error should have been cleared even before the RPC resolved
    const server = useMcpStore.getState().servers.find((s) => s.name === 'hf')!
    expect(server.error).toBeNull()
  })

  it('startOAuthLogin calls shell.openExternal with authorization_url', async () => {
    useMcpStore.setState({
      servers: [
        { name: 'hf', type: 'http', url: 'https://hf.co', enabled: true, status: 'starting', error: null, tools: [], isBuiltin: false },
      ],
    })

    mockApi.mcpOAuthLogin.mockResolvedValue({ ok: true, authorization_url: 'https://auth.example.com/login' })

    await useMcpStore.getState().startOAuthLogin('hf')

    expect(mockShell.openExternal).toHaveBeenCalledWith('https://auth.example.com/login')
    expect(mockShell.openExternal).toHaveBeenCalledTimes(1)
    expect(useMcpStore.getState().loggingIn).toBe('hf')
  })

  it('startOAuthLogin sets helpful error when shell is unavailable', async () => {
    // Temporarily remove shell
    const origShell = (window as any).electronAPI.shell
    ;(window as any).electronAPI.shell = undefined

    useMcpStore.setState({
      servers: [
        { name: 'hf', type: 'http', url: 'https://hf.co', enabled: true, status: 'starting', error: null, tools: [], isBuiltin: false },
      ],
    })

    mockApi.mcpOAuthLogin.mockResolvedValue({ ok: true, authorization_url: 'https://auth.example.com/login' })

    await useMcpStore.getState().startOAuthLogin('hf')

    const server = useMcpStore.getState().servers.find((s) => s.name === 'hf')!
    expect(server.error).toContain('无法打开浏览器')

    // Restore
    ;(window as any).electronAPI.shell = origShell
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/useMcpStore.test.ts`
Expected: 3 new tests FAIL (error not cleared; shell never called; no fallback error)

- [ ] **Step 3: Implement OAuth fix in useMcpStore.ts**

In `src/renderer/src/features/agent-workspace/useMcpStore.ts`, replace the `startOAuthLogin` method (lines 311-332):

```typescript
  async startOAuthLogin(name) {
    const api = getApi()
    const shell = getShell()
    if (!api?.mcpOAuthLogin) {
      setServerError(name, 'OAuth API 不可用')
      return
    }

    // Clear stale error so the user sees immediate feedback on retry
    set((state) => ({
      servers: state.servers.map((s) =>
        s.name === name ? { ...s, error: null } : s,
      ),
    }))

    const res = await api.mcpOAuthLogin(name)
    if (!res?.ok || !res.authorization_url) {
      setServerError(name, `OAuth 启动失败：${res?.error ?? '未知错误'}`)
      return
    }

    set({ loggingIn: name })

    if (shell?.openExternal) {
      await shell.openExternal(res.authorization_url)
    } else {
      setServerError(name, `无法打开浏览器，请手动访问：${res.authorization_url}`)
    }
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/useMcpStore.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Verify shell.openExternal IPC handler exists in main process**

Already verified — `src/main/index.ts:769` has:
```typescript
ipcMain.handle('shell:open-external', async (_event, raw: unknown) => { ... })
```
And `src/preload/index.ts:745` has:
```typescript
openExternal: (url: string) => safeInvoke<IpcResponse>(IPC_CHANNELS.SHELL.OPEN_EXTERNAL, url),
```
No main-process changes needed — preload already wires `shell.openExternal` correctly.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/agent-workspace/useMcpStore.ts \
        src/renderer/src/features/agent-workspace/__tests__/useMcpStore.test.ts
git commit -m "fix(mcp): clear stale error on OAuth retry + fallback when shell unavailable"
```

---

### Task 2: fetch-docker-mcp 下载脚本

**Files:**
- Create: `scripts/fetch-docker-mcp.ts`
- Modify: `package.json` (add version field + npm script)

- [ ] **Step 1: Add version field and npm script to package.json**

In `package.json`, add after line 8 (`"codexCliVersion": "0.130.0",`):

```json
  "dockerMcpGatewayVersion": "0.1.7",
```

In the `"scripts"` section, after the `"codex:fetch"` line, add:

```json
    "docker-mcp:fetch": "tsx scripts/fetch-docker-mcp.ts",
```

- [ ] **Step 2: Create scripts/fetch-docker-mcp.ts**

```typescript
import { chmod, mkdir, rm, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const GITHUB_OWNER = 'docker'
const GITHUB_REPO = 'mcp-gateway'
const pkg = JSON.parse(
  (await import('node:fs')).readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
)
const version: string = process.env.DOCKER_MCP_VERSION ?? pkg.dockerMcpGatewayVersion ?? '0.1.7'
const targets = (process.env.DOCKER_MCP_TARGETS ?? `${process.platform}-${process.arch}`)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean)

function getBinaryName(target: string): string {
  return target.startsWith('win32-') ? 'docker-mcp.exe' : 'docker-mcp'
}

function getAssetName(target: string): string {
  const map: Record<string, string> = {
    'win32-x64': 'docker-mcp-windows-amd64.exe',
    'darwin-arm64': 'docker-mcp-darwin-arm64',
    'darwin-x64': 'docker-mcp-darwin-amd64',
    'linux-x64': 'docker-mcp-linux-amd64',
    'linux-arm64': 'docker-mcp-linux-arm64',
  }
  const name = map[target]
  if (!name) throw new Error(`Unsupported target for docker-mcp: ${target}`)
  return name
}

function getGitHubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/octet-stream',
    'User-Agent': 'catimation-docker-mcp-fetcher',
  }
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  }
  return headers
}

async function fetchWithRetry(url: string, maxRetries = 3): Promise<Buffer> {
  let lastError: unknown
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { headers: getGitHubHeaders(), redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      lastError = err
      if (attempt < maxRetries) {
        const delay = 1000 * attempt
        console.log(`  Retry ${attempt}/${maxRetries} in ${delay}ms...`)
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }
  throw lastError
}

async function fetchBinaryForTarget(target: string): Promise<void> {
  const assetName = getAssetName(target)
  const binaryName = getBinaryName(target)
  const targetDir = path.join(process.cwd(), 'resources', 'docker-mcp', target)
  const binaryPath = path.join(targetDir, binaryName)

  // Check cache: if binary already exists, skip download
  try {
    const s = await stat(binaryPath)
    if (s.isFile() && s.size > 0) {
      console.log(`docker-mcp ${version} for ${target} already cached: ${path.relative(process.cwd(), binaryPath)}`)
      return
    }
  } catch { /* not cached */ }

  const tags = [`v${version}`, version]
  let downloadUrl: string | null = null

  for (const tag of tags) {
    const releaseUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/${tag}`
    try {
      const releaseHeaders: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'catimation-docker-mcp-fetcher',
        'X-GitHub-Api-Version': '2022-11-28',
      }
      if (process.env.GITHUB_TOKEN) {
        releaseHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
      }
      const releaseRes = await fetch(releaseUrl, { headers: releaseHeaders })
      if (!releaseRes.ok) continue
      const release = (await releaseRes.json()) as { assets: Array<{ name: string; browser_download_url: string }> }
      const asset = release.assets.find((a) => a.name === assetName)
      if (asset) {
        downloadUrl = asset.browser_download_url
        break
      }
    } catch { continue }
  }

  if (!downloadUrl) {
    throw new Error(
      `No docker-mcp release asset "${assetName}" found for ${GITHUB_OWNER}/${GITHUB_REPO}. Tried tags: ${tags.join(', ')}`,
    )
  }

  console.log(`Downloading docker-mcp ${version} for ${target}...`)
  const bytes = await fetchWithRetry(downloadUrl)

  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetDir, { recursive: true })
  await writeFile(binaryPath, bytes)
  await chmod(binaryPath, 0o755)
  console.log(`Fetched docker-mcp ${version} for ${target}: ${path.relative(process.cwd(), binaryPath)}`)
}

async function main(): Promise<void> {
  if (targets.length === 0) {
    throw new Error('No docker-mcp targets. Set DOCKER_MCP_TARGETS.')
  }
  for (const target of targets) {
    await fetchBinaryForTarget(target)
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
```

- [ ] **Step 3: Run the fetch script to verify**

Run: `npx tsx scripts/fetch-docker-mcp.ts`
Expected: Downloads binary to `resources/docker-mcp/win32-x64/docker-mcp.exe` (or current platform). Output includes "Fetched docker-mcp 0.1.7 for win32-x64".

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch-docker-mcp.ts package.json
git commit -m "feat: add fetch-docker-mcp script for bundling gateway binary"
```

---

### Task 3: 路径解析 + DockerMcpGatewayService 重构

**Files:**
- Create: `src/main/agent/dockerMcpGatewayPath.ts`
- Modify: `src/main/agent/dockerMcpGateway.ts`
- Modify: `src/main/agent/AgentManager.ts:390-391`
- Test: `src/main/agent/__tests__/dockerMcpGatewayPath.test.ts`
- Modify: `src/main/agent/__tests__/dockerMcpGateway.test.ts`

- [ ] **Step 1: Write failing tests for path resolution**

Create `src/main/agent/__tests__/dockerMcpGatewayPath.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import path from 'node:path'

// We test the pure functions; the module reads `app` from electron at import
// time, so we mock electron first.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/repo',
  },
}))

const { getDockerMcpBinaryName, getDockerMcpResourceDir, resolveDockerMcpBinary } = await import('../dockerMcpGatewayPath')

describe('dockerMcpGatewayPath', () => {
  afterEach(() => {
    delete process.env.DOCKER_MCP_BINARY
  })

  it('returns docker-mcp.exe on Windows', () => {
    expect(getDockerMcpBinaryName('win32')).toBe('docker-mcp.exe')
  })

  it('returns docker-mcp on POSIX', () => {
    expect(getDockerMcpBinaryName('linux')).toBe('docker-mcp')
    expect(getDockerMcpBinaryName('darwin')).toBe('docker-mcp')
  })

  it('builds platform-arch resource dir', () => {
    expect(getDockerMcpResourceDir('/app/resources', 'darwin', 'arm64')).toBe(
      path.join('/app/resources', 'docker-mcp', 'darwin-arm64'),
    )
  })

  it('respects DOCKER_MCP_BINARY env override', () => {
    process.env.DOCKER_MCP_BINARY = '/custom/path/docker-mcp'
    expect(resolveDockerMcpBinary('/ignored')).toBe('/custom/path/docker-mcp')
  })

  it('resolves from resourcesPath in normal mode', () => {
    const resolved = resolveDockerMcpBinary('/app/resources')
    expect(resolved).toContain('docker-mcp')
    expect(resolved).toContain(process.platform)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/agent/__tests__/dockerMcpGatewayPath.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement dockerMcpGatewayPath.ts**

Create `src/main/agent/dockerMcpGatewayPath.ts`:

```typescript
import path from 'node:path'

export function getDockerMcpBinaryName(platform = process.platform): string {
  return platform === 'win32' ? 'docker-mcp.exe' : 'docker-mcp'
}

export function getDockerMcpResourceDir(
  resourcesPath: string,
  platform = process.platform,
  arch = process.arch,
): string {
  return path.join(resourcesPath, 'docker-mcp', `${platform}-${arch}`)
}

export function resolveDockerMcpBinary(resourcesPath: string): string {
  if (process.env.DOCKER_MCP_BINARY) return process.env.DOCKER_MCP_BINARY
  return path.join(getDockerMcpResourceDir(resourcesPath), getDockerMcpBinaryName())
}
```

- [ ] **Step 4: Run path tests to verify they pass**

Run: `npx vitest run src/main/agent/__tests__/dockerMcpGatewayPath.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Refactor DockerMcpGatewayService to use binary path**

In `src/main/agent/dockerMcpGateway.ts`, change the constructor to accept an optional `binaryPath`:

Replace the interface and constructor:

```typescript
export interface DockerMcpGatewayOptions {
  spawnFactory?: typeof nodeSpawn
  /** Absolute path to the docker-mcp binary. When null, falls back to `docker mcp` CLI. */
  binaryPath?: string | null
  defaultPort?: number
  defaultReadyTimeoutMs?: number
}
```

Add a private field after `private readonly spawnFactory`:

```typescript
  private readonly binaryPath: string | null
```

In the constructor, add:

```typescript
    this.binaryPath = options.binaryPath ?? null
```

Add a private helper method after the constructor:

```typescript
  private get cmd(): string {
    return this.binaryPath ?? 'docker'
  }

  private prefixArgs(subArgs: string[]): string[] {
    // When using the standalone binary, skip the `mcp` prefix.
    // `docker mcp gateway run ...` → `docker-mcp gateway run ...`
    return this.binaryPath ? subArgs.filter((a) => a !== 'mcp') : subArgs
  }
```

In `checkInstalled()`, replace the spawn call (line ~83):

Old:
```typescript
        proc = this.spawnFactory('docker', ['mcp', '--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
```

New:
```typescript
        proc = this.spawnFactory(this.cmd, this.prefixArgs(['mcp', '--version']), { stdio: ['ignore', 'pipe', 'pipe'] })
```

In `addServersToProfile()`, replace the spawn call (line ~130):

Old:
```typescript
        proc = this.spawnFactory('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
```

New:
```typescript
        proc = this.spawnFactory(this.cmd, this.prefixArgs(args), { stdio: ['ignore', 'pipe', 'pipe'] })
```

In `start()`, replace the spawn call (line ~168):

Old:
```typescript
      proc = this.spawnFactory('docker', cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
```

New:
```typescript
      proc = this.spawnFactory(this.cmd, this.prefixArgs(cmdArgs), { stdio: ['ignore', 'pipe', 'pipe'] })
```

- [ ] **Step 6: Update singleton factory to resolve binary path**

Replace the singleton section at the bottom of `dockerMcpGateway.ts`:

```typescript
import { app } from 'electron'
import { getCodexResourceRoot } from './paths'
import { resolveDockerMcpBinary } from './dockerMcpGatewayPath'

let singleton: DockerMcpGatewayService | null = null
export function getDockerMcpGatewayService(): DockerMcpGatewayService {
  if (!singleton) {
    const resourceRoot = getCodexResourceRoot({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    })
    const binaryPath = resolveDockerMcpBinary(resourceRoot)
    singleton = new DockerMcpGatewayService({ binaryPath })
  }
  return singleton
}

export function __setDockerMcpGatewayServiceForTests(svc: DockerMcpGatewayService | null) {
  singleton = svc
}
```

Note: the `import { app } from 'electron'` line should be at the top of the file. Move the import to the top-level imports section.

- [ ] **Step 7: Update existing dockerMcpGateway tests**

In `src/main/agent/__tests__/dockerMcpGateway.test.ts`, update the `beforeEach` to pass `binaryPath`:

```typescript
  beforeEach(() => {
    spawnFactory = vi.fn()
    svc = new DockerMcpGatewayService({ spawnFactory: spawnFactory as any, binaryPath: '/app/resources/docker-mcp/win32-x64/docker-mcp.exe' })
  })
```

Update the `checkInstalled` test assertion (line ~59):

Old:
```typescript
      expect(spawnFactory).toHaveBeenCalledWith('docker', ['mcp', '--version'], expect.any(Object))
```

New:
```typescript
      expect(spawnFactory).toHaveBeenCalledWith(
        '/app/resources/docker-mcp/win32-x64/docker-mcp.exe',
        ['--version'],
        expect.any(Object),
      )
```

Also update all other `spawnFactory` assertions to expect the absolute binary path as the first arg and args without the `mcp` prefix (e.g., `['profile', 'create', ...]` instead of `['mcp', 'profile', 'create', ...]`, and `['gateway', 'run', ...]` instead of `['mcp', 'gateway', 'run', ...]`).

- [ ] **Step 8: Run all dockerMcpGateway tests**

Run: `npx vitest run src/main/agent/__tests__/dockerMcpGateway.test.ts src/main/agent/__tests__/dockerMcpGatewayPath.test.ts`
Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git add src/main/agent/dockerMcpGatewayPath.ts \
        src/main/agent/dockerMcpGateway.ts \
        src/main/agent/AgentManager.ts \
        src/main/agent/__tests__/dockerMcpGateway.test.ts \
        src/main/agent/__tests__/dockerMcpGatewayPath.test.ts
git commit -m "refactor: DockerMcpGatewayService uses bundled binary path instead of docker CLI plugin"
```

---

### Task 4: electron-builder 集成

**Files:**
- Modify: `electron-builder.yml`

- [ ] **Step 1: Add docker-mcp to extraResources in electron-builder.yml**

After the existing codex `extraResources` entry (line 42), add:

```yaml
  - from: resources/docker-mcp/${platform}-${arch}
    to: docker-mcp/${platform}-${arch}
    filter:
      - "docker-mcp*"
```

- [ ] **Step 2: Verify build picks up the resource**

Run: `npx electron-vite build`
Expected: Build succeeds. No errors about missing docker-mcp resources (they're optional at build time; only needed at runtime).

- [ ] **Step 3: Commit**

```bash
git add electron-builder.yml
git commit -m "build: bundle docker-mcp binary via extraResources"
```

---

### Task 5: Store 新增 autofix 状态字段

**Files:**
- Modify: `src/renderer/src/features/agent-workspace/useMcpStore.ts`
- Modify: `src/renderer/src/features/agent-workspace/__tests__/useMcpStore.test.ts`

- [ ] **Step 1: Write failing tests for new store fields**

Add to `src/renderer/src/features/agent-workspace/__tests__/useMcpStore.test.ts` before the final `})`:

```typescript
  describe('autofix store fields', () => {
    it('setLastAutoFix stores value and dismissLastAutoFix clears it', () => {
      useMcpStore.getState().setLastAutoFix({ count: 3, port: 8811, ts: 1000 })
      expect(useMcpStore.getState().lastAutoFix).toEqual({ count: 3, port: 8811, ts: 1000 })

      useMcpStore.getState().dismissLastAutoFix()
      expect(useMcpStore.getState().lastAutoFix).toBeNull()
    })

    it('lastConvertedFingerprint persists across state changes', () => {
      useMcpStore.setState({ lastConvertedFingerprint: 'a,b,c' })
      expect(useMcpStore.getState().lastConvertedFingerprint).toBe('a,b,c')
    })

    it('dismissLastAutoFix does not touch lastConvertedFingerprint', () => {
      useMcpStore.setState({ lastConvertedFingerprint: 'x', lastAutoFix: { count: 1, port: 8811, ts: 1 } })
      useMcpStore.getState().dismissLastAutoFix()
      expect(useMcpStore.getState().lastConvertedFingerprint).toBe('x')
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/useMcpStore.test.ts`
Expected: FAIL — `setLastAutoFix` / `dismissLastAutoFix` / `lastAutoFix` / `lastConvertedFingerprint` not in store

- [ ] **Step 3: Add fields to the store**

In `src/renderer/src/features/agent-workspace/useMcpStore.ts`:

Add to the `McpStore` interface (after `handleOAuthCompleted`):

```typescript
  lastAutoFix: { count: number; port: number; ts: number } | null
  setLastAutoFix: (v: McpStore['lastAutoFix']) => void
  dismissLastAutoFix: () => void
  lastConvertedFingerprint: string | null
```

Add to the `create<McpStore>` initial state (after `loggingIn: null,`):

```typescript
  lastAutoFix: null,
  lastConvertedFingerprint: null,

  setLastAutoFix(v) {
    set({ lastAutoFix: v })
    if (v) {
      setTimeout(() => {
        if (useMcpStore.getState().lastAutoFix?.ts === v.ts) {
          set({ lastAutoFix: null })
        }
      }, 8_000)
    }
  },

  dismissLastAutoFix() {
    set({ lastAutoFix: null })
  },
```

Also update `beforeEach` in the test file to reset the new fields:

```typescript
  beforeEach(() => {
    useMcpStore.setState({
      servers: [], loading: false, error: null, loggingIn: null,
      syncing: false, syncError: null,
      lastAutoFix: null, lastConvertedFingerprint: null,
    })
    vi.clearAllMocks()
  })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/useMcpStore.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/agent-workspace/useMcpStore.ts \
        src/renderer/src/features/agent-workspace/__tests__/useMcpStore.test.ts
git commit -m "feat(store): add lastAutoFix + lastConvertedFingerprint for auto gateway conversion"
```

---

### Task 6: 自动转换 Hook — useMcpAutoGatewayFix

**Files:**
- Create: `src/renderer/src/features/agent-workspace/useMcpAutoGatewayFix.ts`
- Create: `src/renderer/src/features/agent-workspace/__tests__/useMcpAutoGatewayFix.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `src/renderer/src/features/agent-workspace/__tests__/useMcpAutoGatewayFix.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const mockDockerGatewayFix = vi.fn()
const mockFetchServers = vi.fn()
const mockSetLastAutoFix = vi.fn()

const mockApi = {
  dockerGatewayFix: mockDockerGatewayFix,
  readConfig: vi.fn(),
  listMcpServersRpc: vi.fn(),
  batchWriteConfig: vi.fn(),
  writeConfigValue: vi.fn(),
  reloadMcpServers: vi.fn(),
  mcpOAuthLogin: vi.fn(),
}

;(window as any).electronAPI = { agent: mockApi, shell: { openExternal: vi.fn() } }

const { useMcpStore } = await import('../useMcpStore')
const { useMcpAutoGatewayFix } = await import('../useMcpAutoGatewayFix')

describe('useMcpAutoGatewayFix', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    useMcpStore.setState({
      servers: [],
      loading: false,
      error: null,
      loggingIn: null,
      syncing: false,
      syncError: null,
      lastAutoFix: null,
      lastConvertedFingerprint: null,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('triggers dockerGatewayFix after 2s when docker-stdio servers exist', async () => {
    mockDockerGatewayFix.mockResolvedValue({ ok: true, converted: ['redis'], gatewayPort: 8811 })

    useMcpStore.setState({
      servers: [
        { name: 'redis', type: 'stdio', command: 'docker', args: ['run', 'redis-mcp'], enabled: true, status: 'failed', error: 'bug', tools: [], isBuiltin: false },
      ],
    })

    renderHook(() => useMcpAutoGatewayFix())

    // Not yet called at t=0
    expect(mockDockerGatewayFix).not.toHaveBeenCalled()

    // Advance past debounce
    await act(async () => { vi.advanceTimersByTime(2500) })

    expect(mockDockerGatewayFix).toHaveBeenCalledTimes(1)
  })

  it('does not trigger when no docker-stdio servers are present', async () => {
    useMcpStore.setState({
      servers: [
        { name: 'github', type: 'http', url: 'https://mcp.github.com', enabled: true, status: 'ready', error: null, tools: [{ name: 'search' }], isBuiltin: false },
      ],
    })

    renderHook(() => useMcpAutoGatewayFix())
    await act(async () => { vi.advanceTimersByTime(3000) })

    expect(mockDockerGatewayFix).not.toHaveBeenCalled()
  })

  it('does not re-trigger when fingerprint matches lastConvertedFingerprint', async () => {
    useMcpStore.setState({
      servers: [
        { name: 'redis', type: 'stdio', command: 'docker', args: ['run', 'redis'], enabled: true, status: 'failed', error: 'bug', tools: [], isBuiltin: false },
      ],
      lastConvertedFingerprint: 'redis',
    })

    renderHook(() => useMcpAutoGatewayFix())
    await act(async () => { vi.advanceTimersByTime(3000) })

    expect(mockDockerGatewayFix).not.toHaveBeenCalled()
  })

  it('cleans up timer on unmount', async () => {
    useMcpStore.setState({
      servers: [
        { name: 'redis', type: 'stdio', command: 'docker', args: ['run', 'redis'], enabled: true, status: 'failed', error: 'bug', tools: [], isBuiltin: false },
      ],
    })

    const { unmount } = renderHook(() => useMcpAutoGatewayFix())
    unmount()

    await act(async () => { vi.advanceTimersByTime(3000) })
    expect(mockDockerGatewayFix).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/useMcpAutoGatewayFix.test.tsx`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement useMcpAutoGatewayFix hook**

Create `src/renderer/src/features/agent-workspace/useMcpAutoGatewayFix.ts`:

```typescript
import { useEffect } from 'react'
import { useMcpStore, type McpServerCard } from './useMcpStore'

function getApi(): any {
  return (window as any).electronAPI?.agent
}

function isDockerStdioCandidate(s: McpServerCard): boolean {
  if (s.type === 'http') return false
  if (!s.command) return false
  const cmd = s.command.toLowerCase()
  const isDocker =
    cmd === 'docker' ||
    cmd.endsWith('/docker') ||
    cmd.endsWith('\\docker.exe') ||
    cmd.endsWith('/docker.exe')
  if (!isDocker) return false
  const args = s.args ?? []
  if (args[0] === 'mcp' && args[1] === 'gateway') return false
  return s.status === 'failed' || s.status === 'unknown'
}

function fingerprint(servers: McpServerCard[]): string {
  return servers
    .map((s) => s.name)
    .sort()
    .join(',')
}

export function useMcpAutoGatewayFix(): void {
  const servers = useMcpStore((s) => s.servers)
  const lastConvertedFingerprint = useMcpStore((s) => s.lastConvertedFingerprint)
  const fetchServers = useMcpStore((s) => s.fetchServers)
  const setLastAutoFix = useMcpStore((s) => s.setLastAutoFix)

  useEffect(() => {
    const candidates = servers.filter(isDockerStdioCandidate)
    if (candidates.length === 0) return

    const fp = fingerprint(candidates)
    if (fp === lastConvertedFingerprint) return

    const timer = setTimeout(async () => {
      const api = getApi()
      if (!api?.dockerGatewayFix) return
      try {
        const res = await api.dockerGatewayFix()
        if (res.ok) {
          useMcpStore.setState({ lastConvertedFingerprint: fp })
          setLastAutoFix({
            count: res.converted?.length ?? 0,
            port: res.gatewayPort ?? 8811,
            ts: Date.now(),
          })
          await fetchServers()
        }
      } catch { /* swallow — toast won't show, user can retry manually via JSON editor */ }
    }, 2_000)

    return () => clearTimeout(timer)
  }, [servers, lastConvertedFingerprint, fetchServers, setLastAutoFix])
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/useMcpAutoGatewayFix.test.tsx`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/agent-workspace/useMcpAutoGatewayFix.ts \
        src/renderer/src/features/agent-workspace/__tests__/useMcpAutoGatewayFix.test.tsx
git commit -m "feat: auto-detect docker stdio MCPs and convert to gateway (2s debounce)"
```

---

### Task 7: AutoFixToast 组件

**Files:**
- Create: `src/renderer/src/features/agent-workspace/AutoFixToast.tsx`
- Create: `src/renderer/src/features/agent-workspace/__tests__/AutoFixToast.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `src/renderer/src/features/agent-workspace/__tests__/AutoFixToast.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import React from 'react'

const mockApi = {
  readConfig: vi.fn(),
  listMcpServersRpc: vi.fn(),
  batchWriteConfig: vi.fn(),
  writeConfigValue: vi.fn(),
  reloadMcpServers: vi.fn(),
  mcpOAuthLogin: vi.fn(),
  dockerGatewayFix: vi.fn(),
}
;(window as any).electronAPI = { agent: mockApi, shell: { openExternal: vi.fn() } }

const { useMcpStore } = await import('../useMcpStore')
const { AutoFixToast } = await import('../AutoFixToast')

describe('AutoFixToast', () => {
  beforeEach(() => {
    useMcpStore.setState({ lastAutoFix: null, lastConvertedFingerprint: null })
  })

  it('renders nothing when lastAutoFix is null', () => {
    const { container } = render(<AutoFixToast />)
    expect(container.firstChild).toBeNull()
  })

  it('renders count and port when lastAutoFix is set', () => {
    useMcpStore.setState({ lastAutoFix: { count: 3, port: 8811, ts: Date.now() } })
    render(<AutoFixToast />)
    expect(screen.getByText(/3/)).toBeTruthy()
    expect(screen.getByText(/8811/)).toBeTruthy()
  })

  it('dismiss button clears the toast', () => {
    useMcpStore.setState({ lastAutoFix: { count: 2, port: 8811, ts: Date.now() } })
    render(<AutoFixToast />)
    const btn = screen.getByRole('button')
    fireEvent.click(btn)
    expect(useMcpStore.getState().lastAutoFix).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/AutoFixToast.test.tsx`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement AutoFixToast**

Create `src/renderer/src/features/agent-workspace/AutoFixToast.tsx`:

```tsx
import React from 'react'
import { useMcpStore } from './useMcpStore'

export function AutoFixToast(): React.JSX.Element | null {
  const last = useMcpStore((s) => s.lastAutoFix)
  const dismiss = useMcpStore((s) => s.dismissLastAutoFix)

  if (!last) return null

  return (
    <div
      style={{
        position: 'fixed',
        top: 16,
        right: 16,
        zIndex: 9999,
        padding: '12px 20px',
        background: 'rgba(34, 197, 94, 0.12)',
        border: '1px solid rgba(34, 197, 94, 0.4)',
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontSize: 13,
        color: '#86efac',
        boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
      }}
    >
      <span>
        已自动将 {last.count} 个 Docker MCP 转换为 Gateway HTTP 模式（:{last.port}）
      </span>
      <button
        type="button"
        onClick={dismiss}
        style={{
          background: 'none',
          border: 'none',
          color: '#86efac',
          cursor: 'pointer',
          fontSize: 16,
          lineHeight: 1,
          padding: '0 4px',
        }}
      >
        ×
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/features/agent-workspace/__tests__/AutoFixToast.test.tsx`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/agent-workspace/AutoFixToast.tsx \
        src/renderer/src/features/agent-workspace/__tests__/AutoFixToast.test.tsx
git commit -m "feat(ui): AutoFixToast shows docker→gateway conversion result"
```

---

### Task 8: 删除 DockerGatewayFixBanner，接入 Hook + Toast

**Files:**
- Delete: `src/renderer/src/features/agent-workspace/DockerGatewayFixBanner.tsx`
- Delete: `src/renderer/src/features/agent-workspace/__tests__/DockerGatewayFixBanner.test.tsx`
- Modify: `src/renderer/src/features/agent-workspace/McpServerList.tsx`

- [ ] **Step 1: Remove DockerGatewayFixBanner import and usage from McpServerList.tsx**

In `src/renderer/src/features/agent-workspace/McpServerList.tsx`:

Remove line 4:
```typescript
import { DockerGatewayFixBanner } from './DockerGatewayFixBanner'
```

Add these imports at the top:
```typescript
import { useMcpAutoGatewayFix } from './useMcpAutoGatewayFix'
import { AutoFixToast } from './AutoFixToast'
```

Inside the `McpServerList` component function, after the `const [confirmDelete, ...]` line, add:

```typescript
  useMcpAutoGatewayFix()
```

Remove the `<DockerGatewayFixBanner ... />` block (lines 101-109):
```tsx
      {/* Banner: offer one-click fix when docker MCPs hit the Codex bug */}
      <DockerGatewayFixBanner
        servers={servers}
        onApplied={async () => {
          await fetchServers()
        }}
      />
```

Add `<AutoFixToast />` as the first child of the returned `<div>`:

```tsx
    <div className="flex flex-col gap-4">
      <AutoFixToast />
      {/* Header with action buttons */}
```

- [ ] **Step 2: Delete the banner files**

Delete `src/renderer/src/features/agent-workspace/DockerGatewayFixBanner.tsx`
Delete `src/renderer/src/features/agent-workspace/__tests__/DockerGatewayFixBanner.test.tsx`

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors related to DockerGatewayFixBanner

- [ ] **Step 4: Run all agent-workspace tests**

Run: `npx vitest run src/renderer/src/features/agent-workspace/`
Expected: ALL PASS. DockerGatewayFixBanner tests no longer exist; remaining tests pass.

- [ ] **Step 5: Commit**

```bash
git rm src/renderer/src/features/agent-workspace/DockerGatewayFixBanner.tsx \
       src/renderer/src/features/agent-workspace/__tests__/DockerGatewayFixBanner.test.tsx
git add src/renderer/src/features/agent-workspace/McpServerList.tsx
git commit -m "refactor: replace manual DockerGatewayFixBanner with auto-conversion hook + toast"
```

---

### Task 9: 全面回归验证

**Files:** (none changed — verification only)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass. Zero regressions.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: Clean — no type errors.

- [ ] **Step 3: Verify the docker-mcp binary is in resources**

Run: `ls resources/docker-mcp/` (or `dir resources\docker-mcp\` on Windows)
Expected: `<platform>-<arch>/docker-mcp[.exe]` present from Task 2.

- [ ] **Step 4: Verify electron-builder config is valid**

Run: `npx electron-builder --dir` (quick dry-run build)
Expected: Build completes without errors. `dist/` output includes `docker-mcp/` in resources.

---

## File Map

| File | Action | Task |
|---|---|---|
| `src/renderer/src/features/agent-workspace/useMcpStore.ts` | Modify | 1, 5 |
| `src/renderer/src/features/agent-workspace/__tests__/useMcpStore.test.ts` | Modify | 1, 5 |
| `scripts/fetch-docker-mcp.ts` | Create | 2 |
| `package.json` | Modify | 2 |
| `src/main/agent/dockerMcpGatewayPath.ts` | Create | 3 |
| `src/main/agent/__tests__/dockerMcpGatewayPath.test.ts` | Create | 3 |
| `src/main/agent/dockerMcpGateway.ts` | Modify | 3 |
| `src/main/agent/__tests__/dockerMcpGateway.test.ts` | Modify | 3 |
| `electron-builder.yml` | Modify | 4 |
| `src/renderer/src/features/agent-workspace/useMcpAutoGatewayFix.ts` | Create | 6 |
| `src/renderer/src/features/agent-workspace/__tests__/useMcpAutoGatewayFix.test.tsx` | Create | 6 |
| `src/renderer/src/features/agent-workspace/AutoFixToast.tsx` | Create | 7 |
| `src/renderer/src/features/agent-workspace/__tests__/AutoFixToast.test.tsx` | Create | 7 |
| `src/renderer/src/features/agent-workspace/DockerGatewayFixBanner.tsx` | Delete | 8 |
| `src/renderer/src/features/agent-workspace/__tests__/DockerGatewayFixBanner.test.tsx` | Delete | 8 |
| `src/renderer/src/features/agent-workspace/McpServerList.tsx` | Modify | 8 |

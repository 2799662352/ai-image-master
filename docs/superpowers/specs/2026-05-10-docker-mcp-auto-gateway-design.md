# Docker MCP 自动化 + OAuth 修复 + 二进制自带 设计

## Summary

把 Codex bug #19425（stdio MCP 工具不暴露给模型）的解决方案从「用户点按钮」升级成「零交互自动转换」，并把 `docker-mcp` 二进制随 app 一起分发避免依赖 Docker Desktop。同时修复 OAuth 登录按钮点击无反应的 bug（preload 没暴露 `shell.openExternal`）。

**本 spec 在** `2026-05-10-mcp-cursor-style-ui-design.md` 之后。复用其建立的 Cursor 风格 UI 框架（卡片 + Monaco + 通知）；本 spec 只增删该 UI 周边的支撑能力。

## 背景

上一份 spec 落地了"一键修复"的横幅 + 模态。用户使用后反馈：

1. 这个修复**应该自动**发生，不应该让用户去理解 #19425、点按钮、再确认。
2. 用户机器上 `docker mcp` plugin 多半没装（Docker Desktop 不一定有、Docker CE 用户压根没这玩意），手动从 GitHub releases 下载放到 `~/.docker/cli-plugins/` 几乎无人会做。
3. 顺带：HuggingFace MCP server 卡片上的 "登录 →" 按钮点了**没反应**——既没打开浏览器、也没明显错误，过几秒卡片显示 "timed out waiting for OAuth callback"。

第 (3) 项的根因独立于 docker 工作：preload 层没暴露 `shell.openExternal` IPC，`useMcpStore.startOAuthLogin` 里的 `if (shell?.openExternal)` 直接走 false 分支，浏览器从来没开过。所以 timed out 是 Codex 端等不到 callback 的合理结果，但用户看到的现象却是 "click does nothing"。

## 设计

### §1 OAuth 登录修复

#### 问题

`src/renderer/src/features/agent-workspace/useMcpStore.ts:329-331`：

```ts
if (shell?.openExternal) {
  await shell.openExternal(res.authorization_url)
}
```

`shell` 来自 `(window as any).electronAPI?.shell`。`src/preload/index.ts` 全文搜不到 `shell` namespace：从未暴露。

二级问题：`startOAuthLogin` 不清旧错误。重试时 UI 上的 `timed out waiting for OAuth callback` 还在，给用户"按钮不工作"的错觉。

#### 修复

**Preload 暴露**（`src/preload/index.ts`）：

```ts
import { shell as electronShell } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // ... 现有内容
  shell: {
    openExternal: (url: string) => electronShell.openExternal(url),
  },
})
```

类型声明同步加：

```ts
shell: {
  openExternal: (url: string) => Promise<void>
}
```

**Store 层重试时清错误**（`useMcpStore.ts.startOAuthLogin`）：

```ts
async startOAuthLogin(name) {
  // 重试时清掉旧错误，给用户明确反馈说"我点了"
  set((state) => ({
    servers: state.servers.map((s) =>
      s.name === name ? { ...s, error: null } : s,
    ),
  }))
  // ... 现有逻辑
}
```

**测试**（`useMcpStore.test.ts`）：

- 新 case：`startOAuthLogin` 在 mcpOAuthLogin 调用前清空旧 error
- 新 case：`shell.openExternal` 在 `authorization_url` 拿到后被调用一次
- 新 case：`shell` 不可用时设置 `setServerError(name, "无法打开浏览器，请手动复制链接")`（防御 preload 失败）

### §2 docker-mcp 二进制随 app 分发

#### 设计模仿 codex 的现有模式

repo 已有 `scripts/fetch-codex.ts` 把 codex 二进制下载到 `resources/codex-cli/`。docker-mcp 走同样套路：

| 维度 | codex（参照） | docker-mcp（新增） |
|---|---|---|
| 版本字段 | `package.json.codexCliVersion` | `package.json.dockerMcpGatewayVersion` |
| 下载脚本 | `scripts/fetch-codex.ts` | `scripts/fetch-docker-mcp.ts` |
| 落地路径 | `resources/codex-cli/<plat>-<arch>/codex[.exe]` | `resources/docker-mcp/<plat>-<arch>/docker-mcp[.exe]` |
| npm script | `npm run codex:fetch` | `npm run docker-mcp:fetch` |
| 触发 | `prebuild` / postinstall | 同 |
| 打包 | `electron-builder.yml.extraResources` | 同（追加 entry） |

#### Asset matrix

`docker/mcp-gateway` releases 的资产命名（来自 GitHub releases v0.10+）：

| 平台 | arch | asset name |
|---|---|---|
| linux | x64 | `docker-mcp-linux-amd64` |
| linux | arm64 | `docker-mcp-linux-arm64` |
| darwin | x64 | `docker-mcp-darwin-amd64` |
| darwin | arm64 | `docker-mcp-darwin-arm64` |
| win32 | x64 | `docker-mcp-windows-amd64.exe` |

我们目标用户主要是 win32-x64 / darwin-arm64 / darwin-x64。fetch 脚本固定下载 process 当前平台的版本（不矩阵下载，节省 CI 时间）。

#### 运行时路径解析

新增 `src/main/agent/dockerMcpGatewayPath.ts`：

```ts
export function resolveDockerMcpBinary(): string {
  // 1. ENV override (开发/调试)
  if (process.env.DOCKER_MCP_BINARY) return process.env.DOCKER_MCP_BINARY

  // 2. Packaged app: 从 resourcesPath 读
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'docker-mcp', binaryName())
  }

  // 3. 开发模式: 从工作区
  return path.join(__dirname, '../../resources/docker-mcp', binaryName())
}
```

#### `DockerMcpGatewayService` 重构

把硬编码的 `'docker'` 替换成 `resolveDockerMcpBinary()`。args 从 `['mcp', 'gateway', 'run', ...]` 改成 `['gateway', 'run', ...]`（直接调 docker-mcp 二进制时不需要 `mcp` 前缀）。

`checkInstalled()` 退化成 `binaryExists()`：检查二进制存不存在 + 可不可执行（macOS/Linux 还要 `chmod +x`，fetch 脚本里做）。

依然依赖 docker engine 在跑——`docker mcp gateway` 内部通过 docker socket 拉/管理 container。但用户**不再**需要 Docker Desktop 或 plugin 机制。

#### Tests

新增 `scripts/__tests__/fetch-docker-mcp.test.ts`：

- mock `node-fetch` + `fs.promises`
- platform×arch 选 asset 名
- SHA256 校验
- 缓存命中：本地已有正确版本时跳过下载
- 错误：资产不存在 → 报错
- 错误：网络失败 → 重试 3 次后报错

`dockerMcpGateway.test.ts` 现有 10 个测试改成传 `binaryPath` 参数，验证 spawn 第一参数变成绝对路径。

### §3 自动转换 + Toast（替换 banner+modal）

#### 删除

- `src/renderer/src/features/agent-workspace/DockerGatewayFixBanner.tsx`
- `src/renderer/src/features/agent-workspace/__tests__/DockerGatewayFixBanner.test.tsx`
- `McpServerList.tsx` 里 `<DockerGatewayFixBanner ... />` 那段

#### 新增

`src/renderer/src/features/agent-workspace/useMcpAutoGatewayFix.ts`：

```ts
export function useMcpAutoGatewayFix() {
  const servers = useMcpStore((s) => s.servers)
  const fetchServers = useMcpStore((s) => s.fetchServers)
  const setLastAutoFix = useMcpStore((s) => s.setLastAutoFix)

  // Debounced trigger: when servers change, check if there are docker-stdio
  // entries that need conversion. Trigger conversion + refetch.
  React.useEffect(() => {
    const dockers = collectFailingOrPendingDockerStdio(servers)
    if (dockers.length === 0) return
    const timer = setTimeout(async () => {
      const res = await getApi().dockerGatewayFix()
      if (res.ok) {
        setLastAutoFix({ count: res.converted?.length ?? 0, ts: Date.now() })
        await fetchServers()
      }
    }, 2_000)
    return () => clearTimeout(timer)
  }, [servers, fetchServers, setLastAutoFix])
}
```

注意：`collectFailingOrPendingDockerStdio` 不限定 status="failed"——也包括刚加进来还没探测的（防止用户来不及看到红点就被自动并入）。

`src/renderer/src/features/agent-workspace/AutoFixToast.tsx`：

```tsx
export function AutoFixToast() {
  const last = useMcpStore((s) => s.lastAutoFix)
  const dismiss = useMcpStore((s) => s.dismissLastAutoFix)
  if (!last) return null
  return (
    <div className="...toast 样式...">
      已自动将 {last.count} 个 Docker MCP 转换为 Gateway HTTP 模式
      （监听 :{last.port}）
      <button onClick={dismiss}>×</button>
    </div>
  )
}
```

8 秒自动消失（zustand action 里 setTimeout）。

#### Store 加 3 个字段

```ts
interface McpStore {
  // ... 现有
  lastAutoFix: { count: number; port: number; ts: number } | null
  setLastAutoFix: (v: McpStore['lastAutoFix']) => void
  dismissLastAutoFix: () => void
  // 防止 hook 再次触发：一次成功的 auto-fix 后存 fingerprint
  // (一组 docker server name 的排序 join)
  lastConvertedFingerprint: string | null
}
```

#### Hook 防再触发

`useMcpAutoGatewayFix` 计算当前 `dockers.map(d => d.name).sort().join(',')` 作为 fingerprint。和 `lastConvertedFingerprint` 一致 → 不触发。这样 fetchServers 每次刷 servers 不会反复跑 fix。

#### Gateway 自动停止

App 退出时停（已实现）。**不**做"删掉所有 docker entry 时主动停 gateway"——YAGNI，gateway 空跑只占很少资源，下次启动有 docker entry 时自动复用。

#### Tests

- `useMcpAutoGatewayFix.test.tsx`：
  - 触发：发现 docker-stdio entry 后 2s 触发 dockerGatewayFix
  - 防抖：连续 servers 变化只触发一次
  - 取消：组件卸载/中途没有 docker entry 了 → 不调
- `AutoFixToast.test.tsx`：
  - 渲染：`lastAutoFix` 为 null 时不渲染；非 null 时显示数量
  - 关闭：点 × 调 dismissLastAutoFix
- `useMcpStore.test.ts`：
  - 新 store fields setter / getter

## 实施顺序

逐项 commit，每项都通过 typecheck + 相关测试：

1. **§1 OAuth 修复**：preload `shell.openExternal` + store 清错误 + 测试。最小、独立、立刻可验证。
2. **§2.1 fetch-docker-mcp 脚本**：纯 Node 脚本，无 app 依赖。`npm run docker-mcp:fetch` 能跑通，资源落地正确。
3. **§2.2 path 解析 + Service 改造**：`resolveDockerMcpBinary` + 现有 dockerMcpGateway 测试改造（传 binaryPath）。
4. **§2.3 electron-builder 集成**：`extraResources` 加 entry，`prebuild` script 加 fetch。验证 `npm run build` 后 unpacked resources 里有 docker-mcp。
5. **§3 自动化 hook + Toast，删 banner**：渲染端工作。原有 banner 测试删除，新 hook/toast 测试通过。
6. **端到端冒烟**：起 app，配 docker MCP 两条，刷一次，看是否 2s 内自动并入 gateway，toast 显示，绿点亮起。

## 不做

- 不做"撤销自动转换"按钮（YAGNI；用户改 JSON 编辑器手动还原）
- 不做"开关单个 docker MCP 是否走 gateway"（既然 stdio 路径上游 bug 影响所有 docker stdio entry，分开管不增加价值）
- 不做 Linux x64 以外的 Linux 架构（armv7 等）的二进制下载（覆盖目标用户即可，未来按需扩）
- 不做 SSE 端口冲突自动选择（默认 8811，冲突时报错；用户可在 store/未来 settings 改）

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| GitHub releases 在大陆下载慢/失败 | fetch 脚本 3 次重试 + 失败时降级到链接告知用户手动放到 resources（保留旧 `checkInstalled` 路径作为 fallback） |
| 用户 docker engine 没跑（mac/Win 没启 Desktop） | `start()` 失败时 toast 提示"请确保 docker engine 正在运行" |
| 自动转换在用户正手动编辑 JSON 时插队 | hook 用 2s 防抖；JSON 编辑器保存后 store 立即更新，2s 内若用户继续编辑会取消上一次 timer |
| 自动停 gateway 时 Codex 还有 in-flight tool call | YAGNI；让 stop 时打 SIGTERM，Codex 那边 RPC 失败会传给 model 当 tool error |

## 测试矩阵

| 模块 | 类型 | 数量 |
|---|---|---|
| `scripts/fetch-docker-mcp` | unit | ~6 |
| `dockerMcpGatewayPath` | unit | ~4 |
| `dockerMcpGateway`（改造） | unit | 10（已有，要更新） |
| `useMcpStore` OAuth 修复 | unit | +3 |
| `useMcpStore` autofix store | unit | +3 |
| `useMcpAutoGatewayFix` hook | unit | ~5（含防重触发 fingerprint 测试） |
| `AutoFixToast` | unit | ~2 |
| 端到端冒烟 | manual | 1 |

预计约 25 个新/改测试，0 回归。

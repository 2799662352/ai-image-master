import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getCodexResourceRoot } from './paths'

export interface ApiyiMcpPathOptions {
  appPath: string
  isPackaged: boolean
  resourcesPath?: string
}

/**
 * Resolve the absolute filesystem path to the vendored apiyi-mcp-server entry
 * (dist/index.js). Mirrors the layout produced by scripts/vendor-apiyi-mcp.mjs
 * and shipped via electron-builder.yml `extraResources`.
 *
 * Packaged: <resourcesPath>/apiyi-mcp/dist/index.js
 * Dev:      <appPath>/resources/apiyi-mcp/dist/index.js
 */
export function getApiyiMcpEntryPath(options: ApiyiMcpPathOptions): string {
  const root = getCodexResourceRoot(options)
  return path.join(root, 'apiyi-mcp', 'dist', 'index.js')
}

/**
 * Default env scaffold seeded into `mcp_servers.apiyi.env`. Modeled on the
 * canonical Cursor `mcp.json` shape for `2799662352/apiyi-mcp-server`, MINUS
 * the secret:
 *
 *   {
 *     "command": "node",
 *     "args": ["<absolute>/dist/index.js"],
 *     "env": {
 *       "GEMINI_MODEL": "gemini-3.5-flash",
 *       "APIYI_BASE_URL": "https://api.apiyi.com",
 *       "GEMINI_MAX_OUTPUT_TOKENS": "65536",
 *       "GEMINI_TIMEOUT": "1800000"
 *     }
 *   }
 *
 * `APIYI_API_KEY` is persisted as an EMPTY placeholder (`""`) — matching the
 * canonical dev-machine mcp.json shape so the JSON editor shows the slot —
 * but the REAL secret never touches disk. It is injected at codex spawn via
 * `-c mcp_servers.apiyi.env.APIYI_API_KEY=...` (CLI `-c` overrides win over
 * config.toml values, so the empty placeholder is always superseded) from the
 * single key the user saved in 设置 → API易 (see `buildCodexLaunchArgs.apiyiKey`
 * / `AgentManager.apiyiMcpKey`). This is the ONLY supported key source — for
 * BOTH the system-node and Electron-as-Node forms alike. The entry is
 * app-managed and force-seeded every boot, so a key hand-typed into the JSON
 * editor is scrubbed back to `""` at restart (no secret persists).
 *
 * Field rationale:
 *  - `APIYI_BASE_URL` — apiyi-mcp's own baked-in default is `https://api.bltcy.ai`,
 *    which silently rejects `sk-...` keys from `api.apiyi.com`. Overriding here
 *    is what makes a freshly-pasted apiyi key actually work.
 *  - `GEMINI_MODEL` — see "Recommended models" table below. Default (为主) is
 *    `gemini-3.5-flash` — the stable, cheap+fast model the app pins for
 *    apiyi-mcp understanding (incl. 音频理解). 关键:**绝不退回 `gemini-2.x`(2.5)**
 *    — 2.x 已弃用且明显掉点。条目由应用托管(每次启动强制收敛),模型固定为
 *    3.5-flash;JSON 编辑器里的手动改动重启后会被恢复。
 *  - `GEMINI_MAX_OUTPUT_TOKENS` / `GEMINI_TIMEOUT` — long-context / long-running
 *    defaults from the documented Cursor reference, so large video / PDF jobs
 *    don't get truncated at 8K tokens or time-out at 5 minutes.
 *
 * ## Recommended models (Gemini 3.x only — 2.5 is EOL for this app)
 *
 * | Model                                    | 价/速 | 强项           | 何时选          |
 * |------------------------------------------|-------|----------------|-----------------|
 * | `gemini-3.5-flash`              ← 默认/为主 | 便宜+快| 综合最强(含音频)| 99% 场景,默认 |
 * | `gemini-3.1-pro-preview-thinking`        | 贵+慢 | 深度推理 / 思维链 | 复杂分析、需要 thinking_budget 时手动切 |
 * | `gemini-3-flash-preview`                 | 最便宜 | 简单任务最省 token | 量大、不在意精度时 |
 *
 * **`gemini-2.x`(2.5 等)已弃用,默认/自动填充绝不使用。**
 *
 * 旧的 `gemini-2.x` 系列已被替换。`seedApiyiMcpEntry` 现为强制收敛:每次启动
 * 把 env 重写为本 scaffold,任何残留的 2.x 模型值都会被自动升级回 3.5-flash。
 *
 * `ELECTRON_RUN_AS_NODE` is deliberately NOT in the scaffold — when `command`
 * is plain `node` (the standard MCP convention used by Claude Desktop, Cursor,
 * FastMCP, and the official MCP spec docs), the flag is meaningless. It is
 * only injected via `resolveApiyiCommand`'s `extraEnv` when the runtime falls
 * back to Electron-as-Node (no system `node` available — packaged-app users).
 */
export const APIYI_MCP_ENV_SCAFFOLD: Readonly<Record<string, string>> = Object.freeze({
  APIYI_BASE_URL: 'https://api.apiyi.com',
  GEMINI_MODEL: 'gemini-3.5-flash',
  GEMINI_MAX_OUTPUT_TOKENS: '65536',
  GEMINI_TIMEOUT: '1800000',
  // Empty placeholder only — the real key is injected at spawn from 设置 →
  // API易 via `-c` (which overrides this value). Force-seeding scrubs any
  // hand-typed secret back to "" at every boot.
  APIYI_API_KEY: '',
})

export interface ApiyiResolvedCommand {
  /**
   * Absolute or PATH-resolved path to the binary that will spawn apiyi-mcp. In
   * the standard happy path this is the system `node` (located via $PATH); in
   * the packaged-app fallback this is `process.execPath` (Electron-as-Node).
   */
  command: string
  /**
   * Extra env vars to merge on top of `APIYI_MCP_ENV_SCAFFOLD` in the seeded
   * config entry. Empty for the `node` path; carries `ELECTRON_RUN_AS_NODE=1`
   * for the Electron fallback (without which electron.exe boots in GUI mode
   * and trashes the MCP stdio JSON-RPC channel with Chromium log output).
   */
  extraEnv: Record<string, string>
}

/**
 * Locate the system `node` binary by scanning $PATH (with platform-aware
 * extension handling on Windows). Returns the absolute path of the first hit,
 * or null if no executable `node` is found on PATH.
 *
 * Standalone helper — does not consult `process.execPath` or any Electron
 * runtime; pure filesystem probe. Safe to call in tests with a custom
 * `pathEnv` override.
 */
export async function whichNode(
  pathEnv: string | undefined = process.env.PATH,
  pathExt: string | undefined = process.env.PATHEXT,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (!pathEnv) return null
  const sep = platform === 'win32' ? ';' : ':'
  const exts =
    platform === 'win32'
      ? (pathExt ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean).map((e) => e.toLowerCase())
      : ['']
  const dirs = pathEnv.split(sep).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `node${ext}`)
      try {
        await fs.access(candidate)
        return candidate
      } catch {
        /* not here, try next */
      }
    }
  }
  return null
}

/**
 * Pick the right `command` for the seeded apiyi-mcp entry. Two outcomes:
 *
 *  - `command: '<path>/node[.exe]'`, `extraEnv: {}`
 *      → System `node` is on PATH. Matches the canonical MCP spec / Cursor /
 *      Claude Desktop / FastMCP convention exactly. This is the path 99% of
 *      developers (and anyone who installed Node themselves) will take.
 *
 *  - `command: '<electron.exe>'`, `extraEnv: { ELECTRON_RUN_AS_NODE: '1' }`
 *      → Packaged-app fallback when the end user has no Node installed.
 *      Catimation ships an Electron runtime regardless, so we coopt it as a
 *      Node interpreter via the documented `ELECTRON_RUN_AS_NODE` flag.
 *
 * Detection happens at every boot. `seedApiyiMcpEntry` converges the on-disk
 * entry to the resolved form automatically: stale absolute paths (moved /
 * uninstalled binaries) are repaired, and an entry we seeded in the
 * Electron-as-Node fallback form is upgraded to `command = node` as soon as a
 * system node appears on PATH. User-set env values (and any user-customized
 * command) are always preserved.
 */
export async function resolveApiyiCommand(
  electronExecPath: string,
  nodeFinder: () => Promise<string | null> = () => whichNode(),
): Promise<ApiyiResolvedCommand> {
  const nodePath = await nodeFinder()
  if (nodePath) {
    return { command: nodePath, extraEnv: {} }
  }
  return {
    command: electronExecPath,
    extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
  }
}

/**
 * Minimal TOML-serializable shape we write into `mcp_servers.apiyi`. The
 * `command` and `extraEnv` come from `resolveApiyiCommand` — see that helper
 * for the node-vs-electron decision matrix.
 *
 * The seed defaults this entry to `enabled: true` (see `seedApiyiMcpEntry`) so
 * apiyi works out of the box — the user neither fills a key nor flips a toggle.
 * The key is injected at spawn from 设置 → API易; apiyi is the app's default
 * codex gateway, so that key is the norm. `buildApiyiMcpConfigEntry` itself is
 * generic and honors whatever `enabled` the caller passes.
 *
 * `env` is a fresh copy of the scaffold (frozen template → new mutable object
 * per call) with `extraEnv` merged on top, so downstream code can edit
 * without poisoning future seeds.
 */
export interface ApiyiMcpConfigEntry {
  command: string
  args: string[]
  enabled: boolean
  env: Record<string, string>
}

export interface ApiyiMcpConfigEntryInput {
  entryPath: string
  command: string
  extraEnv?: Record<string, string>
  enabled: boolean
}

export function buildApiyiMcpConfigEntry(
  input: ApiyiMcpConfigEntryInput,
): ApiyiMcpConfigEntry {
  return {
    command: input.command,
    args: [input.entryPath],
    enabled: input.enabled,
    env: { ...APIYI_MCP_ENV_SCAFFOLD, ...(input.extraEnv ?? {}) },
  }
}

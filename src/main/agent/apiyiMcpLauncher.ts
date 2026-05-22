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
 * Default env scaffold seeded into `mcp_servers.apiyi.env`. Modeled 1:1 on the
 * canonical Cursor `mcp.json` shape for `2799662352/apiyi-mcp-server`:
 *
 *   {
 *     "command": "node",
 *     "args": ["<absolute>/dist/index.js"],
 *     "env": {
 *       "APIYI_API_KEY": "sk-...",
 *       "GEMINI_MODEL": "gemini-3.5-flash",
 *       "APIYI_BASE_URL": "https://api.apiyi.com",
 *       "GEMINI_MAX_OUTPUT_TOKENS": "65536",
 *       "GEMINI_TIMEOUT": "1800000"
 *     }
 *   }
 *
 * Field rationale:
 *  - `APIYI_API_KEY` — empty placeholder; the only field the user has to fill.
 *  - `APIYI_BASE_URL` — apiyi-mcp's own baked-in default is `https://api.bltcy.ai`,
 *    which silently rejects `sk-...` keys from `api.apiyi.com`. Overriding here
 *    is what makes a freshly-pasted apiyi key actually work.
 *  - `GEMINI_MODEL` — see "Recommended models" table below. Default is the
 *    best price/perf option; users can swap to anything via the MCP JSON editor
 *    (no whitelist is enforced — whatever string is in the JSON is what runs).
 *  - `GEMINI_MAX_OUTPUT_TOKENS` / `GEMINI_TIMEOUT` — long-context / long-running
 *    defaults from the documented Cursor reference, so large video / PDF jobs
 *    don't get truncated at 8K tokens or time-out at 5 minutes.
 *
 * ## Recommended models (Gemini 3.x only — 2.5 is EOL for this app)
 *
 * | Model                              | 价/速 | 强项           | 何时选          |
 * |------------------------------------|-------|----------------|-----------------|
 * | `gemini-3.5-flash`         ← 默认  | 便宜+快| 综合最强       | 99% 场景        |
 * | `gemini-3.1-pro-preview-thinking`  | 贵+慢 | 深度推理 / 思维链 | 复杂分析、需要 thinking_budget 时 |
 * | `gemini-3-flash-preview`           | 最便宜 | 简单任务最省 token | 量大、不在意精度时 |
 *
 * 旧的 `gemini-2.x` 系列已被替换,新种子不会推荐。注意 `seedApiyiMcpEntry` 的
 * backfill 路径会**保留用户已设的任意模型值**(包括 2.5),不强制升级。
 *
 * `ELECTRON_RUN_AS_NODE` is deliberately NOT in the scaffold — when `command`
 * is plain `node` (the standard MCP convention used by Claude Desktop, Cursor,
 * FastMCP, and the official MCP spec docs), the flag is meaningless. It is
 * only injected via `resolveApiyiCommand`'s `extraEnv` when the runtime falls
 * back to Electron-as-Node (no system `node` available — packaged-app users).
 */
export const APIYI_MCP_ENV_SCAFFOLD: Readonly<Record<string, string>> = Object.freeze({
  APIYI_API_KEY: '',
  APIYI_BASE_URL: 'https://api.apiyi.com',
  GEMINI_MODEL: 'gemini-3.5-flash',
  GEMINI_MAX_OUTPUT_TOKENS: '65536',
  GEMINI_TIMEOUT: '1800000',
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
 * Detection happens once at boot; the resolved command is baked into the
 * seeded `config.toml` entry and is NOT re-resolved on every spawn. If a user
 * later installs Node, they can re-seed (delete the apiyi entry and restart)
 * to pick up the cleaner `command = node` path.
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
 * `enabled: false` is the first-boot default; the seeded `APIYI_API_KEY` is
 * empty, so flipping on without filling the key would just produce a noisy
 * "token invalid" loop. User pastes their key in the JSON editor, then flips
 * the toggle.
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

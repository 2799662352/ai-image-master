import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * 通用：给「用 node 跑一个脚本」的 stdio MCP（catimation 桥、运镜知识库）选
 * 可执行文件。
 *
 * 这块原先放在 apiyi 的启动器里（`resolveApiyiCommand`），apiyi MCP 移除后
 * 抽出来，名字也去掉了 apiyi。行为一字未改。
 */
export interface StdioResolvedCommand {
  /** 要执行的可执行文件：系统 node 的绝对路径，或 Electron 自身。 */
  command: string
  /**
   * 额外要带上的环境变量：走系统 node 时为空；回落到 Electron 时带
   * `ELECTRON_RUN_AS_NODE=1`（缺了它 electron.exe 会以 GUI 模式启动，
   * Chromium 的日志输出会把 MCP 的 stdio JSON-RPC 通道搅乱）。
   */
  extraEnv: Record<string, string>
}

/**
 * 在 $PATH 里找系统 `node`（Windows 下按 PATHEXT 补扩展名），返回第一个命中的
 * 绝对路径，找不到返回 null。
 *
 * 纯文件系统探测，不看 `process.execPath`；参数都可注入，方便测试。
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
        /* 这个目录里没有，试下一个 */
      }
    }
  }
  return null
}

/**
 * 选 `command`，两种结果：
 *
 *  - 系统有 node：`{ command: '<path>/node[.exe]', extraEnv: {} }`，与 MCP 规范 /
 *    Cursor / Claude Desktop 的惯例一致。
 *  - 系统没有 node（打包后的终端用户常见）：`{ command: <electron>,
 *    extraEnv: { ELECTRON_RUN_AS_NODE: '1' } }`，把我们自带的 Electron 当 node 用。
 *
 * 每次启动都重新探测，调用方据此收敛磁盘上的条目。
 */
export async function resolveStdioNodeCommand(
  electronExecPath: string,
  nodeFinder: () => Promise<string | null> = () => whichNode(),
): Promise<StdioResolvedCommand> {
  const nodePath = await nodeFinder()
  if (nodePath) {
    return { command: nodePath, extraEnv: {} }
  }
  return {
    command: electronExecPath,
    extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
  }
}

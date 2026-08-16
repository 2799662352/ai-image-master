// cinematography_kb 的 transport 每次 spawn 现算 —— 学 catimation,不再只靠开机
// 那一次 seed。
//
// 真实事故(2026-08-16 用户报障):用户把 app 从 `D:\懒人猫平台\...` 重装到
// `C:\Users\<name>\AppData\Local\Programs\...`,config.toml 里 cinematography_kb
// 的 args 仍指向 D 盘那个已经不存在的 index.js。node 拿到不存在的脚本立刻退出,
// codex 报 `connection closed: initialize response`。
//
// 同机上 apiyi 好好的(它的 seed 每次开机逐字段强制覆写),catimation 也好好的
// (它压根不写 config.toml,每次 spawn 现算)。烂掉的恰恰是「写一次、之后只补 env
// 不校验路径」的那一个。
//
// 这里锁住 catimation 那套做法:transport 由 spawn 时注入,磁盘上那份再陈旧也
// 盖不过 `-c`(SessionFlags 层优先级高于 config.toml)。

import { describe, expect, it } from 'vitest'
import { buildCodexLaunchArgs } from '../codexLaunch'

const ENTRY = 'C:\\Users\\ZhuanZ\\AppData\\Local\\Programs\\CATIMATION\\resources\\cinematography-kb-mcp\\index.js'
const NODE = 'C:\\Program Files\\nodejs\\node.exe'

describe('cinematography_kb transport 注入', () => {
  it('注入现算的 command 与 args,覆盖 config.toml 里可能过期的那份', () => {
    const args = buildCodexLaunchArgs({
      cinematographyKbStdio: { command: NODE, args: [ENTRY], env: {} },
    })
    // JSON.stringify 的转义(反斜杠翻倍)正是合法的 TOML basic string,
    // Windows 路径能原样穿过 `-c` 的 TOML 解析 —— 与 catimation 同款。
    expect(args).toContain(
      'mcp_servers.cinematography_kb.command="C:\\\\Program Files\\\\nodejs\\\\node.exe"',
    )
    expect(args).toContain(
      'mcp_servers.cinematography_kb.args=["C:\\\\Users\\\\ZhuanZ\\\\AppData\\\\Local\\\\Programs\\\\CATIMATION\\\\resources\\\\cinematography-kb-mcp\\\\index.js"]',
    )
  })

  it('Electron 兜底时把 ELECTRON_RUN_AS_NODE 一起带上', () => {
    // 漏了它,electron.exe 会以 GUI 模式启动并把 stdio 弄坏 —— 症状与本次事故
    // 一模一样(catimation 踩过,见 codexLaunch.test.ts 的同名守卫)。
    const args = buildCodexLaunchArgs({
      cinematographyKbStdio: {
        command: 'C:\\app\\catimation.exe',
        args: [ENTRY],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    })
    expect(args).toContain('mcp_servers.cinematography_kb.env.ELECTRON_RUN_AS_NODE="1"')
  })

  it('env 用点号叶子而不是整表赋值 —— 否则会把密钥那几条覆盖掉', () => {
    // 这个服务器的 env 是由多条独立 `-c` 叶子拼起来的(DashScope key /
    // DashVector key / endpoint)。若这里改用 `env={...}` 整表赋值,就会和那几条
    // 互相覆盖,取决于顺序 —— 那是必然会回归的写法。
    const args = buildCodexLaunchArgs({
      cinematographyKbStdio: {
        command: 'C:\\app\\catimation.exe',
        args: [ENTRY],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
      cinematographyKbKey: 'sk-kb',
      dashVectorKey: 'dv-key',
    })
    expect(args.some((a) => a.startsWith('mcp_servers.cinematography_kb.env='))).toBe(false)
    // 四条叶子并存
    expect(args).toContain('mcp_servers.cinematography_kb.env.ELECTRON_RUN_AS_NODE="1"')
    expect(args).toContain('mcp_servers.cinematography_kb.env.DASHSCOPE_API_KEY="sk-kb"')
    expect(args).toContain('mcp_servers.cinematography_kb.env.DASHVECTOR_API_KEY="dv-key"')
    expect(args.some((a) => a.startsWith('mcp_servers.cinematography_kb.env.DASHVECTOR_ENDPOINT='))).toBe(true)
  })

  it('系统 node 时不注入 ELECTRON_RUN_AS_NODE', () => {
    const args = buildCodexLaunchArgs({
      cinematographyKbStdio: { command: NODE, args: [ENTRY], env: {} },
    })
    expect(args.some((a) => a.includes('ELECTRON_RUN_AS_NODE'))).toBe(false)
  })

  it('没给 stdio 信息时一条 transport 都不注入(仍由 seed 管,外部 CLI 用户不受影响)', () => {
    const args = buildCodexLaunchArgs()
    expect(args.some((a) => a.startsWith('mcp_servers.cinematography_kb.command'))).toBe(false)
    expect(args.some((a) => a.startsWith('mcp_servers.cinematography_kb.args'))).toBe(false)
  })

  it('注入 transport 不改变 enabled —— 用户手动关掉的服务器不该被强行拉起', () => {
    const args = buildCodexLaunchArgs({
      cinematographyKbStdio: { command: NODE, args: [ENTRY], env: {} },
    })
    expect(args.some((a) => a.startsWith('mcp_servers.cinematography_kb.enabled'))).toBe(false)
  })
})

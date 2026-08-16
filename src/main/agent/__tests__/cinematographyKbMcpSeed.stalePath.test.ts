// seed 必须收敛「指向上一个安装目录」的 transport。
//
// 事故复盘(2026-08-16):用户从 `D:\懒人猫平台\CATIMATION-Cyberpunk Master\` 重装到
// `C:\Users\<name>\AppData\Local\Programs\CATIMATION-Cyberpunk Master\`。
// apiyi 自愈了(它每次开机逐字段强制覆写),cinematography_kb 没有 —— 它的
// needsTransportRepair 只认「完全没 transport」和「遗留 python 脚本」两种形状,
// 一条 command 有效、args 指向旧安装的记录在它眼里是健康的,于是永远跳过。
//
// 收敛口径:transport(command/args)是 app 托管的,按本次构建的真值覆写;
// env 仍是用户领地,只增不改(注释里对外部 codex CLI 用户承诺过手填的 key 和
// 自定义 DASHVECTOR_ENDPOINT 不被抹掉)。

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseToml } from 'toml'
import { seedCinematographyKbMcpEntry } from '../cinematographyKbMcpSeed'

let tmpDir: string
let configPath: string

const OLD_INSTALL = 'D:\\懒人猫平台\\CATIMATION-Cyberpunk Master\\resources\\cinematography-kb-mcp\\index.js'
const NEW_INSTALL = 'C:\\Users\\ZhuanZ\\AppData\\Local\\Programs\\CATIMATION-Cyberpunk Master\\resources\\cinematography-kb-mcp\\index.js'
const NODE = 'C:\\Program Files\\nodejs\\node.exe'

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cinema-kb-stale-'))
  configPath = path.join(tmpDir, 'config.toml')
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function entryOf(raw: string): Record<string, any> {
  const servers = (parseToml(raw) as Record<string, unknown>).mcp_servers as Record<string, unknown>
  return servers.cinematography_kb as Record<string, any>
}

describe('seed 收敛过期的 transport', () => {
  it('args 指向上一个安装目录时改写成本次构建的路径', async () => {
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.cinematography_kb]',
        `command = ${JSON.stringify(NODE)}`,
        `args = [${JSON.stringify(OLD_INSTALL)}]`,
        'enabled = true',
        '',
        '  [mcp_servers.cinematography_kb.env]',
        '  DASHVECTOR_ENDPOINT = "vrs-cn-1zz4v38oq0001l.dashvector.cn-beijing.aliyuncs.com"',
        '',
      ].join('\n'),
      'utf8',
    )

    const action = await seedCinematographyKbMcpEntry({
      personalConfigToml: configPath,
      entryPath: NEW_INSTALL,
      command: NODE,
    })

    expect(action).toBe('repaired')
    expect(entryOf(await fs.readFile(configPath, 'utf8')).args).toEqual([NEW_INSTALL])
  })

  it('command 变了(卸载 node → Electron 兜底)也收敛,并带上 ELECTRON_RUN_AS_NODE', async () => {
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.cinematography_kb]',
        `command = ${JSON.stringify(NODE)}`,
        `args = [${JSON.stringify(NEW_INSTALL)}]`,
        'enabled = true',
        '',
      ].join('\n'),
      'utf8',
    )

    const action = await seedCinematographyKbMcpEntry({
      personalConfigToml: configPath,
      entryPath: NEW_INSTALL,
      command: 'C:\\app\\catimation.exe',
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    })

    expect(action).toBe('repaired')
    const entry = entryOf(await fs.readFile(configPath, 'utf8'))
    expect(entry.command).toBe('C:\\app\\catimation.exe')
    expect(entry.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('收敛 transport 时不动用户的 env —— 手填的 key 与自定义 endpoint 都留着', async () => {
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.cinematography_kb]',
        `command = ${JSON.stringify(NODE)}`,
        `args = [${JSON.stringify(OLD_INSTALL)}]`,
        'enabled = true',
        '',
        '  [mcp_servers.cinematography_kb.env]',
        '  DASHSCOPE_API_KEY = "sk-user-typed"',
        '  DASHVECTOR_ENDPOINT = "my-own-cluster.example.com"',
        '',
      ].join('\n'),
      'utf8',
    )

    await seedCinematographyKbMcpEntry({
      personalConfigToml: configPath,
      entryPath: NEW_INSTALL,
      command: NODE,
    })

    const entry = entryOf(await fs.readFile(configPath, 'utf8'))
    expect(entry.args).toEqual([NEW_INSTALL])
    expect(entry.env.DASHSCOPE_API_KEY).toBe('sk-user-typed')
    expect(entry.env.DASHVECTOR_ENDPOINT).toBe('my-own-cluster.example.com')
  })

  it('用户关掉的服务器保持关闭 —— 收敛路径不等于强行拉起', async () => {
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.cinematography_kb]',
        `command = ${JSON.stringify(NODE)}`,
        `args = [${JSON.stringify(OLD_INSTALL)}]`,
        'enabled = false',
        '',
      ].join('\n'),
      'utf8',
    )

    await seedCinematographyKbMcpEntry({
      personalConfigToml: configPath,
      entryPath: NEW_INSTALL,
      command: NODE,
    })

    expect(entryOf(await fs.readFile(configPath, 'utf8')).enabled).toBe(false)
  })

  it('transport 已是本次构建的真值时不写盘(幂等)', async () => {
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.cinematography_kb]',
        `command = ${JSON.stringify(NODE)}`,
        `args = [${JSON.stringify(NEW_INSTALL)}]`,
        'enabled = true',
        '',
        '  [mcp_servers.cinematography_kb.env]',
        '  DASHVECTOR_ENDPOINT = "vrs-cn-1zz4v38oq0001l.dashvector.cn-beijing.aliyuncs.com"',
        '',
      ].join('\n'),
      'utf8',
    )

    const action = await seedCinematographyKbMcpEntry({
      personalConfigToml: configPath,
      entryPath: NEW_INSTALL,
      command: NODE,
    })

    expect(action).toBe('skipped')
  })
})

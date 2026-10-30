// 启动参数整行进 `[CodexLaunch] spawn …` 日志(写盘 + console),而 `-c` 里带着用户的
// 私钥(DashScope / DashVector)、catimation 桥的口令和知识库中转口令。日志会被
// 用户整段贴进反馈里,所以这里锁住:能打出来的只有键名,值一律遮掉。

import { describe, expect, it } from 'vitest'
import { buildCodexLaunchArgs, redactCodexLaunchArgsForLog } from '../codexLaunch'

const SECRETS = {
  dashscope: 'sk-dashscope-secret-0002',
  dashvector: 'dv-secret-0003',
  relay: 'relay-secret-0004',
  bridge: 'bridge-secret-0005',
  http: 'http-header-secret-0006',
}

describe('redactCodexLaunchArgsForLog', () => {
  it('真实启动参数里的每一枚密钥都遮掉,键名留着', () => {
    const stdioArgs = buildCodexLaunchArgs({
      listenUrl: 'ws://127.0.0.1:4222',
      catimationMcp: {
        port: 4900,
        token: SECRETS.http,
        stdio: {
          command: 'C:\\app\\catimation.exe',
          args: ['C:\\app\\resources\\mcp-bridge.js'],
          env: { ELECTRON_RUN_AS_NODE: '1', CATIMATION_MCP_TOKEN: SECRETS.bridge },
        },
      },
      cinematographyKbStdio: { command: 'node', args: ['index.js'], env: {} },
      cinematographyKbKey: SECRETS.dashscope,
      dashVectorKey: SECRETS.dashvector,
      cinematographyKbPlatformRelay: { url: 'http://127.0.0.1:52011', token: SECRETS.relay },
    })
    const httpArgs = buildCodexLaunchArgs({
      catimationMcp: { port: 4900, token: SECRETS.http },
    })

    const logged = [
      ...redactCodexLaunchArgsForLog(stdioArgs),
      ...redactCodexLaunchArgsForLog(httpArgs),
    ].join(' ')

    for (const secret of Object.values(SECRETS)) {
      expect(logged).not.toContain(secret)
    }
    expect(logged).toContain('mcp_servers.cinematography_kb.env.DASHSCOPE_API_KEY=<redacted>')
    expect(logged).toContain('mcp_servers.cinematography_kb.env.DASHVECTOR_API_KEY=<redacted>')
    expect(logged).toContain('mcp_servers.cinematography_kb.env.CATIMATION_KB_RELAY_TOKEN=<redacted>')
    expect(logged).toContain('"x-catimation-token" = "<redacted>"')
    expect(logged).toContain('"CATIMATION_MCP_TOKEN" = "<redacted>"')
  })

  it('非密钥的值原样保留 —— 排障要看的就是它们', () => {
    const args = buildCodexLaunchArgs({
      listenUrl: 'ws://127.0.0.1:4222',
      provider: {
        id: 'miau',
        name: 'Miau',
        baseUrl: 'https://miauapi.13797248455.xyz/v1',
        envKey: 'MIAU_API_KEY',
        model: 'gpt-5.5',
      },
      catimationMcp: {
        port: 4900,
        token: 't',
        stdio: { command: 'node', args: ['bridge.js'], env: { ELECTRON_RUN_AS_NODE: '1' } },
      },
      cinematographyKbPlatformRelay: { url: 'http://127.0.0.1:52011', token: 't' },
    })

    const redacted = redactCodexLaunchArgsForLog(args)

    expect(redacted).toContain('ws://127.0.0.1:4222')
    expect(redacted).toContain('model_providers.miau.env_key="MIAU_API_KEY"')
    expect(redacted).toContain('mcp_servers.cinematography_kb.env.CATIMATION_KB_RELAY_URL="http://127.0.0.1:52011"')
    expect(redacted.join(' ')).toContain('"ELECTRON_RUN_AS_NODE" = "1"')
    expect(redacted).toHaveLength(args.length)
  })

  it('遮罩只看形状(`.env.` 下以 KEY/TOKEN/SECRET/PASSWORD 结尾的叶子),不依赖具体服务器名', () => {
    // 以后再往 `mcp_servers.<任意名>.env.*` 里注入密钥,不用改遮罩也不会漏进日志。
    const redacted = redactCodexLaunchArgsForLog([
      '-c', 'mcp_servers.some_server.env.SOME_API_KEY="sk-leaky"',
      '-c', 'mcp_servers.some_server.enabled=true',
    ])
    expect(redacted).toEqual([
      '-c', 'mcp_servers.some_server.env.SOME_API_KEY=<redacted>',
      '-c', 'mcp_servers.some_server.enabled=true',
    ])
  })

  it('不改动传入的数组', () => {
    const args = ['-c', 'mcp_servers.some_server.env.SOME_API_KEY="sk-1"']
    redactCodexLaunchArgsForLog(args)
    expect(args).toEqual(['-c', 'mcp_servers.some_server.env.SOME_API_KEY="sk-1"'])
  })
})

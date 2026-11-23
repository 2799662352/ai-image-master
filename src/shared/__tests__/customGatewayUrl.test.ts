import { describe, expect, it } from 'vitest'
import {
  CUSTOM_GATEWAY_URL_STORAGE_KEY,
  DEFAULT_CUSTOM_GATEWAY_URL,
  LEGACY_LOCAL_PORT_STORAGE_KEY,
  isLocalOrPrivateHost,
  normalizeGatewayUrl,
  readStoredCustomGatewayUrl,
} from '../customGatewayUrl'

function ok(raw: string) {
  const r = normalizeGatewayUrl(raw)
  if (!r.ok) throw new Error(`期望合法但失败了(${r.reason}): ${raw}`)
  return r
}

describe('normalizeGatewayUrl —— 写了协议的', () => {
  it.each([
    ['https://api.example.com', 'https://api.example.com'],
    ['http://192.168.1.5:3000', 'http://192.168.1.5:3000'],
    ['http://127.0.0.1:3000', 'http://127.0.0.1:3000'],
    ['  https://api.example.com  ', 'https://api.example.com'],
    ['HTTPS://API.Example.com', 'https://api.example.com'],
  ])('%s → %s', (raw, expected) => {
    expect(ok(raw).url).toBe(expected)
  })

  it('末尾斜杠、/v1、整段接口地址都截回根地址', () => {
    expect(ok('https://x.com/').url).toBe('https://x.com')
    expect(ok('https://x.com///').url).toBe('https://x.com')
    expect(ok('https://x.com/v1').url).toBe('https://x.com')
    expect(ok('https://x.com/v1/').url).toBe('https://x.com')
    expect(ok('https://x.com/V1').url).toBe('https://x.com')
    expect(ok('https://x.com/v1/chat/completions').url).toBe('https://x.com')
    expect(ok('https://x.com/v1/images/generations?foo=1').url).toBe('https://x.com')
  })

  it('反代子路径保留,`/v1-xxx` 这种不是版本段的不动', () => {
    expect(ok('https://x.com/newapi').url).toBe('https://x.com/newapi')
    expect(ok('https://x.com/newapi/v1').url).toBe('https://x.com/newapi')
    expect(ok('https://x.com/v1-gateway').url).toBe('https://x.com/v1-gateway')
    expect(ok('https://x.com/api/v10').url).toBe('https://x.com/api/v10')
  })

  it('丢掉查询串和 # 片段', () => {
    expect(ok('https://x.com?token=abc').url).toBe('https://x.com')
    expect(ok('https://x.com/#/home').url).toBe('https://x.com')
  })

  it('协议默认端口被 URL 抹掉是正常的', () => {
    expect(ok('http://x.com:80').url).toBe('http://x.com')
    expect(ok('https://x.com:443').url).toBe('https://x.com')
    expect(ok('https://x.com:8443').url).toBe('https://x.com:8443')
  })

  it('IPv6 字面量', () => {
    expect(ok('http://[::1]:3000').url).toBe('http://[::1]:3000')
  })
})

describe('normalizeGatewayUrl —— 没写协议的', () => {
  it('本机 / 内网 / 裸 IP / 带端口 → http', () => {
    expect(ok('localhost:3000').url).toBe('http://localhost:3000')
    expect(ok('localhost').url).toBe('http://localhost')
    expect(ok('127.0.0.1:3000').url).toBe('http://127.0.0.1:3000')
    expect(ok('192.168.1.5:3000').url).toBe('http://192.168.1.5:3000')
    expect(ok('10.0.0.8').url).toBe('http://10.0.0.8')
    expect(ok('175.178.198.17').url).toBe('http://175.178.198.17')
    expect(ok('175.178.198.17:3000').url).toBe('http://175.178.198.17:3000')
    expect(ok('api.example.com:3000').url).toBe('http://api.example.com:3000')
    expect(ok('nas').url).toBe('http://nas')
    expect(ok('[::1]:3000').url).toBe('http://[::1]:3000')
  })

  it('公网域名不带端口 → https', () => {
    expect(ok('api.example.com').url).toBe('https://api.example.com')
    expect(ok('miauapi.13797248455.xyz').url).toBe('https://miauapi.13797248455.xyz')
    expect(ok('api.example.com/v1').url).toBe('https://api.example.com')
    expect(ok('api.example.com/newapi').url).toBe('https://api.example.com/newapi')
  })

  it('显式 :443 按 https;显式 :80 按 http(而不是被 URL 抹掉端口后误判成「没写端口」)', () => {
    expect(ok('api.example.com:443').url).toBe('https://api.example.com')
    expect(ok('api.example.com:80').url).toBe('http://api.example.com')
  })

  it('只给端口 = 本机该端口(沿用旧版「本地服务」的填法)', () => {
    expect(ok('3000').url).toBe('http://127.0.0.1:3000')
    expect(ok(':8080').url).toBe('http://127.0.0.1:8080')
    expect(ok(' 65535 ').url).toBe('http://127.0.0.1:65535')
  })
})

describe('normalizeGatewayUrl —— 拒绝的', () => {
  it('空', () => {
    expect(normalizeGatewayUrl('')).toEqual({ ok: false, reason: 'empty' })
    expect(normalizeGatewayUrl('   ')).toEqual({ ok: false, reason: 'empty' })
  })

  it('端口越界', () => {
    expect(normalizeGatewayUrl('0')).toEqual({ ok: false, reason: 'invalid' })
    expect(normalizeGatewayUrl('65536')).toEqual({ ok: false, reason: 'invalid' })
    expect(normalizeGatewayUrl('http://x.com:99999')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('不是 http / https', () => {
    expect(normalizeGatewayUrl('ftp://x.com')).toEqual({ ok: false, reason: 'scheme' })
    expect(normalizeGatewayUrl('file:///C:/a')).toEqual({ ok: false, reason: 'scheme' })
    expect(normalizeGatewayUrl('javascript://x')).toEqual({ ok: false, reason: 'scheme' })
    expect(normalizeGatewayUrl('ws://x.com')).toEqual({ ok: false, reason: 'scheme' })
  })

  it('带账号密码', () => {
    expect(normalizeGatewayUrl('https://user:pass@x.com')).toEqual({ ok: false, reason: 'credentials' })
    expect(normalizeGatewayUrl('user:pass@x.com')).toEqual({ ok: false, reason: 'credentials' })
  })

  it('格式坏的 / 含空白', () => {
    expect(normalizeGatewayUrl('http://')).toEqual({ ok: false, reason: 'invalid' })
    expect(normalizeGatewayUrl('https://')).toEqual({ ok: false, reason: 'invalid' })
    expect(normalizeGatewayUrl('a b.com')).toEqual({ ok: false, reason: 'invalid' })
    expect(normalizeGatewayUrl('https://x .com')).toEqual({ ok: false, reason: 'invalid' })
    expect(normalizeGatewayUrl('http://exa mple.com')).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('insecurePublicHttp —— 公网明文 http 才提醒', () => {
  it('公网 http 提醒', () => {
    expect(ok('http://api.example.com').insecurePublicHttp).toBe(true)
    expect(ok('http://175.178.198.17:3000').insecurePublicHttp).toBe(true)
    expect(ok('175.178.198.17:3000').insecurePublicHttp).toBe(true)
  })

  it('https 不提醒', () => {
    expect(ok('https://api.example.com').insecurePublicHttp).toBe(false)
    expect(ok('api.example.com').insecurePublicHttp).toBe(false)
  })

  it('本机 / 内网 http 不提醒', () => {
    for (const raw of ['http://127.0.0.1:3000', '3000', 'localhost:3000', '192.168.1.5:3000', 'http://nas:3000', 'http://10.1.0.17:3000']) {
      expect(ok(raw).insecurePublicHttp, raw).toBe(false)
    }
  })
})

describe('isLocalOrPrivateHost', () => {
  it.each([
    'localhost',
    'foo.localhost',
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.127.255.255',
    '[::1]',
    '::1',
    'fd12:3456::1',
    'fe80::1',
    'nas',
    'printer.local',
    'box.lan',
    'host.docker.internal',
  ])('%s 是自己人的网络', (host) => {
    expect(isLocalOrPrivateHost(host)).toBe(true)
  })

  it.each([
    'api.example.com',
    '175.178.198.17',
    '172.15.0.1',
    '172.32.0.1',
    '192.169.0.1',
    '100.63.0.1',
    '100.128.0.1',
    '8.8.8.8',
    '2001:db8::1',
    '',
  ])('%s 不是', (host) => {
    expect(isLocalOrPrivateHost(host)).toBe(false)
  })
})

describe('readStoredCustomGatewayUrl', () => {
  const store = (entries: Record<string, string>) => ({
    getItem: (k: string) => (k in entries ? entries[k] : null),
  })

  it('什么都没存 → 缺省', () => {
    expect(readStoredCustomGatewayUrl(store({}))).toBe(DEFAULT_CUSTOM_GATEWAY_URL)
    expect(DEFAULT_CUSTOM_GATEWAY_URL).toBe('http://127.0.0.1:3000')
  })

  it('新键优先', () => {
    expect(
      readStoredCustomGatewayUrl(
        store({
          [CUSTOM_GATEWAY_URL_STORAGE_KEY]: 'https://api.example.com',
          [LEGACY_LOCAL_PORT_STORAGE_KEY]: '4000',
        }),
      ),
    ).toBe('https://api.example.com')
  })

  it('新键存的是未归一化的写法也能读成归一化结果', () => {
    expect(readStoredCustomGatewayUrl(store({ [CUSTOM_GATEWAY_URL_STORAGE_KEY]: '192.168.1.5:3000/v1' }))).toBe('http://192.168.1.5:3000')
  })

  it('只有旧版端口键 → 升级后原来填过的端口不丢', () => {
    expect(readStoredCustomGatewayUrl(store({ [LEGACY_LOCAL_PORT_STORAGE_KEY]: '8080' }))).toBe('http://127.0.0.1:8080')
  })

  it('旧版端口键是空串 / 乱码 → 缺省', () => {
    expect(readStoredCustomGatewayUrl(store({ [LEGACY_LOCAL_PORT_STORAGE_KEY]: '' }))).toBe(DEFAULT_CUSTOM_GATEWAY_URL)
    expect(readStoredCustomGatewayUrl(store({ [LEGACY_LOCAL_PORT_STORAGE_KEY]: 'abc' }))).toBe(DEFAULT_CUSTOM_GATEWAY_URL)
    expect(readStoredCustomGatewayUrl(store({ [LEGACY_LOCAL_PORT_STORAGE_KEY]: '99999' }))).toBe(DEFAULT_CUSTOM_GATEWAY_URL)
  })

  it('新键被手改坏了 → 当没存,继续用旧版端口兜底', () => {
    expect(
      readStoredCustomGatewayUrl(
        store({
          [CUSTOM_GATEWAY_URL_STORAGE_KEY]: 'ftp://nope',
          [LEGACY_LOCAL_PORT_STORAGE_KEY]: '4000',
        }),
      ),
    ).toBe('http://127.0.0.1:4000')
  })
})

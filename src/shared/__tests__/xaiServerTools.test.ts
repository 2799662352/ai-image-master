import { describe, expect, it } from 'vitest'
import {
  XAI_REMOTE_MCP_MAX,
  formatRemoteMcpLines,
  isAllowedRemoteMcpUrl,
  parseRemoteMcpLines,
  sameRemoteMcpServers,
  validateRemoteMcpServers,
} from '../xaiServerTools'

describe('isAllowedRemoteMcpUrl', () => {
  it.each([
    'https://mcp.deepwiki.com/mcp',
    'https://example.com',
    'https://example.com:8443/path?x=1',
    'https://sub.domain.example.org/mcp',
    // 公网 IPv4 字面量:xAI 够得着,不拦
    'https://8.8.8.8/mcp',
  ])('accepts %s', (url) => {
    expect(isAllowedRemoteMcpUrl(url)).toBe(true)
  })

  it.each([
    ['明文 http', 'http://mcp.deepwiki.com/mcp'],
    ['其他协议', 'ftp://example.com/mcp'],
    ['不是 URL', 'not a url'],
    ['空串', ''],
    ['带账号密码', 'https://user:pass@example.com/mcp'],
    ['只有用户名', 'https://user@example.com/mcp'],
    ['localhost', 'https://localhost/mcp'],
    ['localhost 子域', 'https://foo.localhost/mcp'],
    ['环回 IP', 'https://127.0.0.1/mcp'],
    ['环回段内其他地址', 'https://127.8.9.10/mcp'],
    ['10 段', 'https://10.0.0.5/mcp'],
    ['172.16 段', 'https://172.16.5.5/mcp'],
    ['172.31 段', 'https://172.31.255.255/mcp'],
    ['192.168 段', 'https://192.168.1.10/mcp'],
    ['链路本地(云元数据)', 'https://169.254.169.254/latest'],
    ['CGNAT', 'https://100.64.0.1/mcp'],
    ['0.0.0.0', 'https://0.0.0.0/mcp'],
    ['IPv6 字面量', 'https://[::1]/mcp'],
    ['十进制整数写法的环回', 'https://2130706433/mcp'],
    ['十六进制写法的环回', 'https://0x7f.1/mcp'],
    ['.local 后缀', 'https://printer.local/mcp'],
    ['.internal 后缀', 'https://svc.internal/mcp'],
    ['.lan 后缀', 'https://nas.lan/mcp'],
    ['单段主机名', 'https://mcpserver/mcp'],
  ])('rejects %s', (_name, url) => {
    expect(isAllowedRemoteMcpUrl(url)).toBe(false)
  })

  it('does not reject 172.15 / 172.32 (just outside the private /12)', () => {
    expect(isAllowedRemoteMcpUrl('https://172.15.0.1/mcp')).toBe(true)
    expect(isAllowedRemoteMcpUrl('https://172.32.0.1/mcp')).toBe(true)
  })

  it('rejects absurdly long URLs', () => {
    expect(isAllowedRemoteMcpUrl(`https://example.com/${'a'.repeat(3000)}`)).toBe(false)
  })
})

describe('validateRemoteMcpServers', () => {
  it('returns normalized servers (url trimmed)', () => {
    expect(validateRemoteMcpServers([{ label: 'deepwiki', url: ' https://mcp.deepwiki.com/mcp ' }]))
      .toEqual([{ label: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' }])
  })

  it('accepts an empty list (clears the setting)', () => {
    expect(validateRemoteMcpServers([])).toEqual([])
  })

  it.each([
    ['not an array', 'x'],
    ['item not an object', ['x']],
    ['bad label (starts with digit)', [{ label: '1a', url: 'https://example.com/mcp' }]],
    ['bad label (space)', [{ label: 'a b', url: 'https://example.com/mcp' }]],
    ['bad label (too long)', [{ label: 'a'.repeat(33), url: 'https://example.com/mcp' }]],
    ['missing url', [{ label: 'a' }]],
    ['non-public url', [{ label: 'a', url: 'https://192.168.0.2/mcp' }]],
    ['http url', [{ label: 'a', url: 'http://example.com/mcp' }]],
  ])('rejects %s', (_name, input) => {
    expect(() => validateRemoteMcpServers(input)).toThrow()
  })

  it('rejects duplicate labels case-insensitively', () => {
    expect(() => validateRemoteMcpServers([
      { label: 'Wiki', url: 'https://a.example.com/mcp' },
      { label: 'wiki', url: 'https://b.example.com/mcp' },
    ])).toThrow(/duplicate/)
  })

  it(`allows exactly ${XAI_REMOTE_MCP_MAX} servers and rejects one more`, () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => ({
      label: `s${i}`,
      url: `https://s${i}.example.com/mcp`,
    }))
    expect(validateRemoteMcpServers(make(XAI_REMOTE_MCP_MAX))).toHaveLength(XAI_REMOTE_MCP_MAX)
    expect(() => validateRemoteMcpServers(make(XAI_REMOTE_MCP_MAX + 1))).toThrow(/at most/)
  })
})

describe('parseRemoteMcpLines / formatRemoteMcpLines', () => {
  it('parses "label url" lines, skipping blanks and # comments', () => {
    const parsed = parseRemoteMcpLines([
      '# 我的 MCP',
      '',
      'deepwiki https://mcp.deepwiki.com/mcp',
      '   docs    https://docs.example.com/mcp   ',
    ].join('\r\n'))
    expect(parsed.errors).toEqual([])
    expect(parsed.servers).toEqual([
      { label: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' },
      { label: 'docs', url: 'https://docs.example.com/mcp' },
    ])
  })

  it('derives a label from the host when only a url is given', () => {
    const parsed = parseRemoteMcpLines('https://mcp.deepwiki.com/mcp')
    expect(parsed.errors).toEqual([])
    expect(parsed.servers).toEqual([{ label: 'mcp_deepwiki_com', url: 'https://mcp.deepwiki.com/mcp' }])
  })

  it('reports line numbers (1-based, counting blank lines) for each bad line', () => {
    const parsed = parseRemoteMcpLines([
      'ok https://ok.example.com/mcp',
      '',
      'bad http://plain.example.com/mcp',
      'a https://a.example.com/mcp extra',
      '1x https://c.example.com/mcp',
    ].join('\n'))
    expect(parsed.servers).toEqual([{ label: 'ok', url: 'https://ok.example.com/mcp' }])
    expect(parsed.errors).toHaveLength(3)
    expect(parsed.errors[0]).toMatch(/^第 3 行/)
    expect(parsed.errors[1]).toMatch(/^第 4 行/)
    expect(parsed.errors[2]).toMatch(/^第 5 行/)
  })

  it('flags duplicate labels and over-limit lists', () => {
    const dup = parseRemoteMcpLines('a https://a.example.com/mcp\nA https://b.example.com/mcp')
    expect(dup.errors).toHaveLength(1)
    expect(dup.errors[0]).toMatch(/重复/)

    const many = parseRemoteMcpLines(
      Array.from({ length: XAI_REMOTE_MCP_MAX + 1 }, (_, i) => `s${i} https://s${i}.example.com/mcp`).join('\n'),
    )
    expect(many.errors.some((message) => message.includes(String(XAI_REMOTE_MCP_MAX)))).toBe(true)
  })

  it('treats an empty / whitespace-only box as "no servers, no errors"', () => {
    expect(parseRemoteMcpLines('')).toEqual({ servers: [], errors: [] })
    expect(parseRemoteMcpLines('  \n\n  ')).toEqual({ servers: [], errors: [] })
  })

  it('round-trips through format', () => {
    const servers = [
      { label: 'deepwiki', url: 'https://mcp.deepwiki.com/mcp' },
      { label: 'docs', url: 'https://docs.example.com/mcp' },
    ]
    expect(parseRemoteMcpLines(formatRemoteMcpLines(servers)).servers).toEqual(servers)
  })
})

describe('sameRemoteMcpServers', () => {
  const a = { label: 'a', url: 'https://a.example.com/mcp' }
  const b = { label: 'b', url: 'https://b.example.com/mcp' }

  it('compares element-wise, order matters', () => {
    expect(sameRemoteMcpServers([], [])).toBe(true)
    expect(sameRemoteMcpServers([a, b], [{ ...a }, { ...b }])).toBe(true)
    expect(sameRemoteMcpServers([a, b], [b, a])).toBe(false)
    expect(sameRemoteMcpServers([a], [a, b])).toBe(false)
    expect(sameRemoteMcpServers([a], [{ ...a, url: 'https://x.example.com/mcp' }])).toBe(false)
    expect(sameRemoteMcpServers([a], [{ ...a, label: 'z' }])).toBe(false)
  })
})

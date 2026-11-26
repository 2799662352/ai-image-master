import type { GrokRemoteMcpServer } from '../types/agent'

/**
 * xAI(Grok)Remote MCP 服务器的校验与「每行一个」文本格式。
 *
 * 主进程(落盘校验 / 注入前复核)和渲染层(设置面板的文本框)共用这一份,
 * 所以这里只许是纯函数、不碰 Node / Electron。
 *
 * 为什么要这么严:Remote MCP 的连接**由 xAI 服务端发起**,对话内容会经 xAI 发给这个地址
 * (docs.apiyi.com 的「代码执行与 Remote MCP」页原话:「MCP server 必须公网可达……你的对话内容
 * 会经 xAI 服务端发送到该 MCP server,请只接入可信服务」)。所以:
 * - 只收 `https://`(明文 http 会让对话在公网上裸奔);
 * - 不收带账号密码的 URL(`https://user:pass@host`,凭据会被写进配置文件与日志);
 * - 不收 localhost / 内网 / 链路本地地址:xAI 够不着,留着只会让每一轮请求都因为连不上而失败,
 *   而且「看起来配置成功」比「直接拒绝」更糟。
 */

/** 上游 `server_label`:字母开头,字母 / 数字 / 下划线 / 连字符,最长 32。 */
export const XAI_MCP_LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/
/** 一次请求最多挂几个远程 MCP。每多一个,xAI 都要先连过去列一遍工具,延迟与失败面都会涨。 */
export const XAI_REMOTE_MCP_MAX = 5
const MAX_URL_LENGTH = 2048

/** 这些后缀的主机名只在内网 / 本机解析得出来,xAI 的服务端够不着。 */
const NON_PUBLIC_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.lan',
  '.intranet',
  '.corp',
  '.home',
  '.home.arpa',
] as const

function parseIpv4(host: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  if (parts.some((part) => part > 255)) return null
  return parts as [number, number, number, number]
}

function isNonPublicIpv4([a, b]: readonly number[]): boolean {
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127) // CGNAT
    || (a === 169 && b === 254) // 链路本地,含云厂商元数据服务
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224 // 组播 / 保留
  )
}

/**
 * `https://` + 公网可达的主机名(或公网 IPv4)才算合格。
 * 不是「保证 xAI 一定连得上」,只是挡掉**一定**连不上或不该发出去的那些。
 */
export function isAllowedRemoteMcpUrl(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return false
  // IPv6 字面量:公网 v6 的 MCP 极少见,而 ::1 / fc00::/7 / fe80::/10 要逐段判,宁可一刀切拒绝。
  if (host.startsWith('[')) return false
  const ipv4 = parseIpv4(host)
  if (ipv4) return !isNonPublicIpv4(ipv4)
  // `new URL` 已把 `2130706433`、`0x7f.1` 这类怪写法折叠成点分 IPv4(上面那支会拦住私网段);
  // 这里兜底:主机名只剩数字和点、却不是合法 IPv4,一律拒绝。
  if (/^[0-9.]+$/.test(host)) return false
  if (host === 'localhost') return false
  if (NON_PUBLIC_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false
  // 单段主机名(`mcpserver`)只会走本机 / 内网的搜索域解析。
  if (!host.includes('.')) return false
  return true
}

/** 校验一个 `{label,url}`,不合格抛带原因的错(IPC 校验、落盘读回都走这里)。 */
export function validateRemoteMcpServer(input: unknown): GrokRemoteMcpServer {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('remote MCP server must be an object')
  }
  const { label, url } = input as Record<string, unknown>
  if (typeof label !== 'string' || !XAI_MCP_LABEL_PATTERN.test(label)) {
    throw new Error('invalid remote MCP label (letters, digits, _ or -, must start with a letter, max 32)')
  }
  if (typeof url !== 'string' || !isAllowedRemoteMcpUrl(url.trim())) {
    throw new Error('invalid remote MCP url (must be a public https:// address without credentials)')
  }
  return { label, url: url.trim() }
}

/** 校验整个列表:元素合格、label 不重复、个数不超上限。 */
export function validateRemoteMcpServers(input: unknown): GrokRemoteMcpServer[] {
  if (!Array.isArray(input)) throw new Error('grokRemoteMcp must be an array')
  if (input.length > XAI_REMOTE_MCP_MAX) {
    throw new Error(`grokRemoteMcp allows at most ${XAI_REMOTE_MCP_MAX} servers`)
  }
  const seen = new Set<string>()
  return input.map((item) => {
    const server = validateRemoteMcpServer(item)
    const key = server.label.toLowerCase()
    if (seen.has(key)) throw new Error(`duplicate remote MCP label: ${server.label}`)
    seen.add(key)
    return server
  })
}

/** 只给 URL、没写标签时,用主机名拼一个:`mcp.deepwiki.com` → `mcp_deepwiki_com`。 */
function deriveLabel(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase()
    const label = host.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32)
    return XAI_MCP_LABEL_PATTERN.test(label) ? label : null
  } catch {
    return null
  }
}

export interface ParsedRemoteMcpLines {
  servers: GrokRemoteMcpServer[]
  /** 带行号的中文原因;非空时界面应拦住「应用」。 */
  errors: string[]
}

/**
 * 设置面板文本框 → 列表。每行一个,`标签 地址` 或只写 `地址`(标签用主机名生成);
 * 空行与 `#` 开头的行忽略。校验规则与 {@link validateRemoteMcpServers} 完全一致,
 * 这里只是把错误翻成带行号的人话。
 */
export function parseRemoteMcpLines(text: string): ParsedRemoteMcpLines {
  const servers: GrokRemoteMcpServer[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  const lines = text.split(/\r?\n/)
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) return
    const where = `第 ${index + 1} 行`
    const tokens = line.split(/\s+/)
    if (tokens.length > 2) {
      errors.push(`${where}:格式应为「标签 地址」,多了内容`)
      return
    }
    const url = tokens.length === 2 ? tokens[1] : tokens[0]
    if (!isAllowedRemoteMcpUrl(url)) {
      errors.push(`${where}:地址必须是公网可达的 https:// 地址(不能带账号密码,不能是 localhost / 内网)`)
      return
    }
    const label = tokens.length === 2 ? tokens[0] : deriveLabel(url)
    if (!label || !XAI_MCP_LABEL_PATTERN.test(label)) {
      errors.push(`${where}:标签只能用字母、数字、下划线、连字符,以字母开头,最长 32`)
      return
    }
    const key = label.toLowerCase()
    if (seen.has(key)) {
      errors.push(`${where}:标签「${label}」重复`)
      return
    }
    seen.add(key)
    servers.push({ label, url })
  })
  if (servers.length > XAI_REMOTE_MCP_MAX) {
    errors.push(`最多配置 ${XAI_REMOTE_MCP_MAX} 个远程 MCP 服务器`)
  }
  return { servers, errors }
}

/** 列表 → 文本框内容(每行 `标签 地址`)。 */
export function formatRemoteMcpLines(servers: readonly GrokRemoteMcpServer[]): string {
  return servers.map((server) => `${server.label} ${server.url}`).join('\n')
}

/** 两份列表是否逐项相同(顺序也算)。会话配置的「是否改动」比较要用,数组不能用 `===`。 */
export function sameRemoteMcpServers(
  a: readonly GrokRemoteMcpServer[],
  b: readonly GrokRemoteMcpServer[],
): boolean {
  return a.length === b.length && a.every((server, i) => (
    server.label === b[i].label && server.url === b[i].url
  ))
}

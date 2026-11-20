export const CATIMATION_MCP_HOST = '127.0.0.1'
export const CATIMATION_MCP_PORT = 7842
export const CATIMATION_MCP_TOKEN_HEADER = 'x-catimation-token'
/**
 * 钉在单条 Codex 线程 MCP 连接上的「所属对话 id」：
 * - stdio bridge 经线程级 `config` 注入环境变量，握手首行随 token 一并上报；
 * - streamable-HTTP 兜底经线程级 `http_headers` 随每次请求上报。
 * 这样归属在线程建起那一刻就写死在连接上（子代理与孙代子代理自动继承），
 * 不再依赖事后从 `_meta` 反查内存表。
 */
export const CATIMATION_MCP_OWNER_ENV = 'CATIMATION_OWNER_THREAD_ID'
export const CATIMATION_MCP_OWNER_HEADER = 'x-catimation-thread-id'
export const CATIMATION_MCP_OWNER_ENV_CONFIG_KEY = `mcp_servers.catimation.env.${CATIMATION_MCP_OWNER_ENV}` as const
export const CATIMATION_MCP_OWNER_HEADER_CONFIG_KEY = `mcp_servers.catimation.http_headers.${CATIMATION_MCP_OWNER_HEADER}` as const

/**
 * 解析握手行或 HTTP 头里的所属对话 id。拒绝空白、控制字符和异常长度，
 * 避免脏字符混进归属判断或日志。
 */
export function parsePinnedThreadId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > 256) return undefined
  if (/[\s\x00-\x1f]/u.test(trimmed)) return undefined
  return trimmed
}
/**
 * Codex's `mcp_servers.<name>.tool_input_schema_max_bytes` (0.158+, default
 * 5,000). Over it, Codex strips every parameter description from the schema;
 * `generate_image` alone is ~9.7 KB. Raising this keeps descriptions intact at
 * the cost of a few thousand extra tokens in the (cacheable) tool prefix.
 */
export const CATIMATION_TOOL_INPUT_SCHEMA_MAX_BYTES = 16_384

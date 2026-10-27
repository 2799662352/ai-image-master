export const CATIMATION_MCP_HOST = '127.0.0.1'
export const CATIMATION_MCP_PORT = 7842
export const CATIMATION_MCP_TOKEN_HEADER = 'x-catimation-token'
/**
 * Codex's `mcp_servers.<name>.tool_input_schema_max_bytes` (0.158+, default
 * 5,000). Over it, Codex strips every parameter description from the schema;
 * `generate_image` alone is ~9.7 KB. Raising this keeps descriptions intact at
 * the cost of a few thousand extra tokens in the (cacheable) tool prefix.
 */
export const CATIMATION_TOOL_INPUT_SCHEMA_MAX_BYTES = 16_384

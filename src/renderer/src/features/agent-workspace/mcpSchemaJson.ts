export const mcpServerSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'MCP Server Configuration',
  description: 'Configuration for a single MCP server entry in Codex config',
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'Command to spawn the MCP server (stdio transport)',
    },
    args: {
      type: 'array',
      items: { type: 'string' },
      description: 'Arguments passed to the command',
    },
    url: {
      type: 'string',
      description: 'URL for HTTP/streamable transport (mutually exclusive with command)',
    },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Environment variables passed to the server process',
    },
    enabled: {
      type: 'boolean',
      description: 'Whether this server is enabled (default: true)',
      default: true,
    },
    disabled_tools: {
      type: 'array',
      items: { type: 'string' },
      description: 'List of tool names to disable on this server',
    },
  },
  oneOf: [
    { required: ['command'] },
    { required: ['url'] },
  ],
  additionalProperties: false,
}

export const mcpConfigSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'MCP Servers Configuration',
  description: 'Map of server names to their configurations',
  type: 'object',
  additionalProperties: mcpServerSchema,
}

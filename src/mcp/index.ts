/** MCP module public facade: manager plus protocol/error contracts. */

export { McpManager } from './mcp-manager.js';
export type { McpStatusProvider, McpToolInvocationPort, McpToolsReadModelProvider } from './mcp-manager.js';
export type { McpStatus, McpServerStatus, McpToolAnnotations, McpToolDefinition } from './protocol.js';
export { McpInvokeError } from './errors.js';

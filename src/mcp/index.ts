/**
 * MCP module — re-exports McpManager and related types.
 */

export { McpManager } from './mcp-manager.js';
export type {
  McpTransport,
  McpStatus,
  McpServerStatus,
  McpToolAnnotations,
  McpToolDefinition,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpJsonRpcError,
  ListToolsResult,
  McpInitializeParams,
} from './mcp-manager.js';

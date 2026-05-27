/** MCP module public facade, protocol, errors, and narrow ports. */

export { McpManager } from './mcp-manager.js';
export type { McpStatusProvider, McpToolInvocationPort, McpToolsReadModelProvider } from './mcp-manager.js';
export {
  MCP_INVOKE_TIMEOUT_MS,
  MCP_DISCOVERY_TIMEOUT_MS,
  MCP_PROTOCOL_VERSION,
  CLIENT_NAME,
  CLIENT_VERSION,
} from './protocol.js';
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
  ToolsCallResult,
} from './protocol.js';
export {
  McpInvokeError,
  ServerNotRunningError,
  ToolNotFoundError,
  InvalidArgumentsError,
  TimeoutError,
  TransportError,
} from './errors.js';
export { buildMcpToolsReadModel, buildMcpServerStatus } from './status-projection.js';
export type { McpServerConfig, McpServerHandle } from './server-registry.js';
